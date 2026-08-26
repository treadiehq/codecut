import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Directive } from "./schema.js";

const ROOT_INSTRUCTION_FILES = [
  "CLAUDE.md",
  path.join(".claude", "CLAUDE.md"),
  "AGENTS.md",
  "AGENT.md",
  path.join(".devin", "global_rules.md"),
];

const DIRECTIVE_LANGUAGE =
  /\b(?:always|never|must|should|do not|don't|cannot|can't|use|avoid|prefer|favor|keep|verify|treat|require)\b/i;
const CONDITIONAL_SCOPE_LANGUAGE =
  /^(?:for|while)\b|\b(?:if|when|whenever|unless|except)\b|\bonly\s+(?:if|when|for|in|on|during)\b/i;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".codecut",
  ".devin",
  ".papercut",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function cursorRuleFiles(cwd: string): Promise<string[]> {
  const rulesDirectory = path.join(cwd, ".cursor", "rules");
  if (!(await exists(rulesDirectory))) {
    return [];
  }

  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (/\.(?:md|mdc)$/i.test(entry.name)) {
        found.push(absolutePath);
      }
    }
  };

  await visit(rulesDirectory);
  return found;
}

async function devinRuleFiles(cwd: string): Promise<string[]> {
  const rulesDirectory = path.join(cwd, ".devin", "rules");
  if (!(await exists(rulesDirectory))) {
    return [];
  }

  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (/\.md$/i.test(entry.name)) {
        found.push(absolutePath);
      }
    }
  };

  await visit(rulesDirectory);
  return found;
}

async function nestedInstructionFiles(cwd: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && entry.name !== ".cursor") {
          await visit(absolutePath);
        }
      } else if (
        (entry.name === "CLAUDE.md" ||
          entry.name === "AGENTS.md" ||
          entry.name === "AGENT.md") &&
        directory !== cwd
      ) {
        found.push(absolutePath);
      }
    }
  };

  await visit(cwd);
  return found;
}

export async function discoverInstructionFiles(cwd: string): Promise<string[]> {
  const rootFiles = ROOT_INSTRUCTION_FILES.map((file) => path.join(cwd, file));
  const existingRootFiles: string[] = [];
  for (const file of rootFiles) {
    if (await exists(file)) {
      existingRootFiles.push(file);
    }
  }

  return [
    ...new Set([
      ...existingRootFiles,
      ...(await nestedInstructionFiles(cwd)),
      ...(await cursorRuleFiles(cwd)),
      ...(await devinRuleFiles(cwd)),
    ]),
  ].sort();
}

function cleanDirective(line: string): string | undefined {
  const withoutListMarker = line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^#+\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (
    withoutListMarker.length < 6 ||
    withoutListMarker.startsWith("```") ||
    withoutListMarker === "---" ||
    (!DIRECTIVE_LANGUAGE.test(withoutListMarker) &&
      !/^run\b/i.test(withoutListMarker))
  ) {
    return undefined;
  }

  return withoutListMarker;
}

export function parseDirectives(
  content: string,
  source: {
    path: string;
    scope: "project" | "user";
    conditional: boolean;
  },
): Directive[] {
  const directives: Directive[] = [];
  const lines = content.split(/\r?\n/);
  let inCodeFence = false;
  let inFrontmatter = lines[0]?.trim() === "---";
  const conditionalHeadings = new Map<number, boolean>();

  lines.forEach((line, index) => {
    if (index === 0 && inFrontmatter) {
      return;
    }
    if (inFrontmatter && line.trim() === "---") {
      inFrontmatter = false;
      return;
    }
    if (inFrontmatter) {
      return;
    }
    if (line.trim().startsWith("```")) {
      inCodeFence = !inCodeFence;
      return;
    }
    if (inCodeFence) {
      return;
    }

    const atxHeading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    const setextUnderline = lines[index + 1]?.trim();
    const setextHeading =
      line.trim().length > 0 &&
      !/^\s*(?:[-*+]|\d+[.)])\s+/.test(line) &&
      !/^\s*>/.test(line) &&
      /^(?:=+|-+)$/.test(setextUnderline ?? "")
        ? {
            level: setextUnderline?.startsWith("=") ? 1 : 2,
            text: line.trim(),
          }
        : undefined;
    const headingLevel = atxHeading?.[1]?.length ?? setextHeading?.level;
    const headingText = atxHeading?.[2] ?? setextHeading?.text;
    if (headingLevel && headingText) {
      for (const existingLevel of conditionalHeadings.keys()) {
        if (existingLevel >= headingLevel) {
          conditionalHeadings.delete(existingLevel);
        }
      }
      conditionalHeadings.set(
        headingLevel,
        CONDITIONAL_SCOPE_LANGUAGE.test(headingText),
      );
    }

    const text = cleanDirective(line);
    if (!text) {
      return;
    }

    directives.push({
      text,
      source: {
        path: source.path,
        line: index + 1,
        scope: source.scope,
        conditional:
          source.conditional ||
          [...conditionalHeadings.values()].some(Boolean),
      },
    });
  });

  return deduplicateDirectives(directives);
}

function deduplicateDirectives(directives: Directive[]): Directive[] {
  const byText = new Map<string, Directive>();
  for (const directive of directives) {
    const key = directive.text.toLowerCase();
    const existing = byText.get(key);
    if (
      !existing ||
      (existing.source.conditional && !directive.source.conditional)
    ) {
      byText.set(key, directive);
    }
  }
  return [...byText.values()];
}

export async function discoverDirectives(cwd: string): Promise<{
  directives: Directive[];
  sources: string[];
}> {
  const files = await discoverInstructionFiles(cwd);
  const directives: Directive[] = [];

  for (const absolutePath of files) {
    const content = await readFile(absolutePath, "utf8");
    const relativePath = path.relative(cwd, absolutePath) || path.basename(absolutePath);
    const lines = content.split(/\r?\n/);
    const frontmatterEnd =
      lines[0]?.trim() === "---"
        ? lines.findIndex((line, index) => index > 0 && line.trim() === "---")
        : -1;
    const frontmatter =
      frontmatterEnd > 0 ? lines.slice(1, frontmatterEnd).join("\n") : "";
    const cursorRule = relativePath.startsWith(
      `${path.join(".cursor", "rules")}${path.sep}`,
    );
    const devinRule = relativePath.startsWith(
      `${path.join(".devin", "rules")}${path.sep}`,
    );
    const nestedInstruction =
      !cursorRule && !devinRule && !ROOT_INSTRUCTION_FILES.includes(relativePath);
    const explicitlyAlwaysApplied = /^\s*alwaysApply\s*:\s*true\s*$/im.test(
      frontmatter,
    );
    const devinAlwaysOn = /^\s*trigger\s*:\s*always_on\s*$/im.test(frontmatter);
    const conditional =
      nestedInstruction ||
      (cursorRule && !explicitlyAlwaysApplied) ||
      (devinRule && !devinAlwaysOn);

    directives.push(
      ...parseDirectives(
        content,
        { path: relativePath, scope: "project", conditional },
      ),
    );
  }

  return {
    directives: deduplicateDirectives(directives),
    sources: files.map((file) => path.relative(cwd, file)),
  };
}
