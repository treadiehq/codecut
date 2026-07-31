import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { scanComments } from "../core/comments.js";
import { diffTotals, parseUnifiedDiff, type FileDiff } from "../core/diff.js";
import {
  DEFAULT_CODE_FILE_PATTERNS,
  DEFAULT_COMMENT_CONTEXT_PATTERNS,
  DEFAULT_DEBUG_ARTIFACT_PATTERNS,
  DEFAULT_TEST_FILE_PATTERNS,
  DEFAULT_TODO_PATTERNS,
  matchesAny,
} from "../core/patterns.js";
import { findProjectRoot, loadPolicy } from "../core/project.js";

const execFileAsync = promisify(execFile);

export const LINT_CHECKS = [
  "comment-quality",
  "todo-comments",
  "debug-artifacts",
  "blast-radius",
] as const;
export type LintCheck = (typeof LINT_CHECKS)[number];

const CHECK_INFO: Record<LintCheck, { summary: string; recovery: string }> = {
  "comment-quality": {
    summary:
      "New comments should not reference prompts, agent instructions, tickets, or temporary files.",
    recovery: "Remove the comment or keep only lasting code constraints.",
  },
  "todo-comments": {
    summary: "New comments should not leave unresolved task markers.",
    recovery: "Resolve the marker or track it in an issue instead.",
  },
  "debug-artifacts": {
    summary: "New code should not contain leftover debug statements.",
    recovery:
      "Remove the debug statement or replace it with intentional logging.",
  },
  "blast-radius": {
    summary: "Changes should stay small and focused.",
    recovery:
      "Split the change or explain the larger scope in the PR description.",
  },
};

export type LintFinding = {
  check: LintCheck;
  path?: string;
  line?: number;
  message: string;
  evidence?: string;
  recovery: string;
};

export type LintResult = {
  findings: LintFinding[];
  files: number;
  added: number;
  deleted: number;
  checks: LintCheck[];
};

export type LintConfig = {
  checks: Set<LintCheck>;
  filePatterns: string[];
  bannedPatterns: string[];
  todoPatterns: string[];
  debugPatterns: string[];
  testFilePatterns: string[];
  maxFiles: number;
  maxChangedLines: number;
};

export function defaultLintConfig(): LintConfig {
  return {
    checks: new Set(LINT_CHECKS),
    filePatterns: DEFAULT_CODE_FILE_PATTERNS,
    bannedPatterns: DEFAULT_COMMENT_CONTEXT_PATTERNS,
    todoPatterns: DEFAULT_TODO_PATTERNS,
    debugPatterns: DEFAULT_DEBUG_ARTIFACT_PATTERNS,
    testFilePatterns: DEFAULT_TEST_FILE_PATTERNS,
    maxFiles: 12,
    maxChangedLines: 500,
  };
}

export function parseLintChecks(value: string): Set<LintCheck> {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new Error(`No checks selected. Available: ${LINT_CHECKS.join(", ")}.`);
  }
  const checks = new Set<LintCheck>();
  for (const name of names) {
    if (!(LINT_CHECKS as readonly string[]).includes(name)) {
      throw new Error(
        `Unknown check "${name}". Available: ${LINT_CHECKS.join(", ")}.`,
      );
    }
    checks.add(name as LintCheck);
  }
  return checks;
}

/**
 * Build the lint configuration for a directory. Uses built-in defaults with
 * zero setup; when a `.codecut/policy.json` exists, its comment-quality and
 * blast-radius rules override the matching patterns and thresholds. Explicit
 * rule opt-outs in the policy remove those checks unless the user requested
 * them with --checks.
 */
export async function resolveLintConfig(
  cwd: string,
  requestedChecks?: Set<LintCheck>,
): Promise<LintConfig> {
  const config = defaultLintConfig();
  if (requestedChecks) {
    config.checks = new Set(requestedChecks);
  }

  const projectRoot = await findProjectRoot(cwd);
  if (!projectRoot) {
    return config;
  }
  let policy;
  try {
    policy = await loadPolicy(projectRoot);
  } catch {
    return config;
  }

  const commentRule = policy.rules.find(
    (rule) => rule.type === "comment-quality",
  );
  if (commentRule && commentRule.type === "comment-quality") {
    if (!commentRule.enabled || commentRule.mode === "off") {
      if (!requestedChecks) {
        config.checks.delete("comment-quality");
      }
    } else {
      config.filePatterns = commentRule.filePatterns;
      config.bannedPatterns = commentRule.bannedPatterns;
    }
  }

  const blastRule = policy.rules.find((rule) => rule.type === "blast-radius");
  if (blastRule && blastRule.type === "blast-radius") {
    if (!blastRule.enabled || blastRule.mode === "off") {
      if (!requestedChecks) {
        config.checks.delete("blast-radius");
      }
    } else {
      config.maxFiles = blastRule.maxFiles;
      config.maxChangedLines = blastRule.maxChangedLines;
    }
  }

  return config;
}

function matchesAnyCaseSensitive(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern).test(value);
    } catch {
      return false;
    }
  });
}

function truncate(value: string, max = 160): string {
  const collapsed = value.trim().replace(/\s+/g, " ");
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export function runLint(files: FileDiff[], config: LintConfig): LintResult {
  const findings: LintFinding[] = [];

  for (const file of files) {
    if (file.binary || !matchesAny(file.path, config.filePatterns)) {
      continue;
    }

    if (
      config.checks.has("comment-quality") ||
      config.checks.has("todo-comments")
    ) {
      for (const comment of scanComments(file.addedLines)) {
        if (
          config.checks.has("comment-quality") &&
          matchesAny(comment.text, config.bannedPatterns)
        ) {
          findings.push({
            check: "comment-quality",
            path: file.path,
            line: comment.line,
            message: "New comment mentions temporary agent context.",
            evidence: truncate(comment.text),
            recovery: CHECK_INFO["comment-quality"].recovery,
          });
        }
        if (
          config.checks.has("todo-comments") &&
          matchesAnyCaseSensitive(comment.text, config.todoPatterns)
        ) {
          findings.push({
            check: "todo-comments",
            path: file.path,
            line: comment.line,
            message: "New comment leaves a task marker.",
            evidence: truncate(comment.text),
            recovery: CHECK_INFO["todo-comments"].recovery,
          });
        }
      }
    }

    if (
      config.checks.has("debug-artifacts") &&
      !matchesAny(file.path, config.testFilePatterns)
    ) {
      for (const added of file.addedLines) {
        if (matchesAny(added.text, config.debugPatterns)) {
          findings.push({
            check: "debug-artifacts",
            path: file.path,
            line: added.line,
            message: "Possible leftover debug statement.",
            evidence: truncate(added.text),
            recovery: CHECK_INFO["debug-artifacts"].recovery,
          });
        }
      }
    }
  }

  findings.sort((left, right) => {
    const byPath = (left.path ?? "").localeCompare(right.path ?? "");
    return byPath !== 0 ? byPath : (left.line ?? 0) - (right.line ?? 0);
  });

  const totals = diffTotals(files);
  const changedLines = totals.added + totals.deleted;
  if (
    config.checks.has("blast-radius") &&
    (totals.files > config.maxFiles || changedLines > config.maxChangedLines)
  ) {
    findings.push({
      check: "blast-radius",
      message: `Change spans ${countLabel(totals.files, "file")} and ${countLabel(changedLines, "changed line")} (limits: ${config.maxFiles} files, ${config.maxChangedLines} lines).`,
      recovery: CHECK_INFO["blast-radius"].recovery,
    });
  }

  return {
    findings,
    files: totals.files,
    added: totals.added,
    deleted: totals.deleted,
    checks: [...config.checks],
  };
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr).trim()
        : "";
    throw new Error(
      `\`git ${args.join(" ")}\` failed${stderr ? `: ${stderr}` : "."}`,
    );
  }
}

async function runGh(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("gh", args, {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code: unknown }).code === "ENOENT"
    ) {
      throw new Error(
        "--pr requires the GitHub CLI. Install it from https://cli.github.com and run `gh auth login`.",
      );
    }
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr).trim()
        : "";
    throw new Error(
      `\`gh ${args.join(" ")}\` failed${stderr ? `: ${stderr}` : "."}`,
    );
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const UNTRACKED_MAX_BYTES = 1024 * 1024;

async function untrackedFileDiffs(repoRoot: string): Promise<FileDiff[]> {
  const output = await runGit(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]).catch(() => "");
  const files: FileDiff[] = [];
  for (const filePath of output.split(/\r?\n/).filter(Boolean)) {
    try {
      const buffer = await readFile(path.join(repoRoot, filePath));
      if (
        buffer.length > UNTRACKED_MAX_BYTES ||
        buffer.subarray(0, 8_000).includes(0)
      ) {
        files.push({
          path: filePath,
          addedLines: [],
          added: 0,
          deleted: 0,
          binary: true,
        });
        continue;
      }
      const lines = buffer.toString("utf8").split(/\r?\n/);
      if (lines.at(-1) === "") {
        lines.pop();
      }
      files.push({
        path: filePath,
        addedLines: lines.map((text, index) => ({ line: index + 1, text })),
        added: lines.length,
        deleted: 0,
        binary: false,
      });
    } catch {
      // Unreadable files are skipped.
    }
  }
  return files;
}

export type LintCommandOptions = {
  cwd: string;
  base?: string;
  staged?: boolean;
  pr?: string;
  patch?: string;
  checks?: string;
};

async function collectFileDiffs(
  options: LintCommandOptions,
): Promise<FileDiff[]> {
  if (options.patch !== undefined) {
    const raw =
      options.patch === "-"
        ? await readStdin()
        : await readFile(path.resolve(options.cwd, options.patch), "utf8");
    return parseUnifiedDiff(raw);
  }

  if (options.pr !== undefined) {
    return parseUnifiedDiff(
      await runGh(options.cwd, ["pr", "diff", options.pr]),
    );
  }

  const repoRoot = (
    await runGit(options.cwd, ["rev-parse", "--show-toplevel"]).catch(() => {
      throw new Error(
        "Not a git repository. Use --patch to lint a diff file instead.",
      );
    })
  ).trim();

  const diffArgs = ["diff", "--no-color", "--no-ext-diff"];
  if (options.base) {
    return parseUnifiedDiff(
      await runGit(repoRoot, [...diffArgs, `${options.base}...HEAD`]),
    );
  }
  if (options.staged) {
    return parseUnifiedDiff(await runGit(repoRoot, [...diffArgs, "--cached"]));
  }

  const workingDiff = await runGit(repoRoot, [...diffArgs, "HEAD"]).catch(() =>
    runGit(repoRoot, diffArgs),
  );
  return [...parseUnifiedDiff(workingDiff), ...(await untrackedFileDiffs(repoRoot))];
}

export async function runLintCommand(
  options: LintCommandOptions,
): Promise<LintResult> {
  const sources = [
    options.base !== undefined,
    options.staged === true,
    options.pr !== undefined,
    options.patch !== undefined,
  ].filter(Boolean).length;
  if (sources > 1) {
    throw new Error("Use only one of --base, --staged, --pr, or --patch.");
  }

  const requestedChecks =
    options.checks === undefined ? undefined : parseLintChecks(options.checks);
  const files = await collectFileDiffs(options);
  const config = await resolveLintConfig(options.cwd, requestedChecks);
  return runLint(files, config);
}

function summaryLine(result: LintResult): string {
  return [
    countLabel(result.findings.length, "finding"),
    countLabel(result.files, "file"),
    `+${result.added}/-${result.deleted} lines`,
    `checks: ${result.checks.join(", ")}`,
  ].join(" · ");
}

export function formatLintText(result: LintResult): string {
  if (result.findings.length === 0) {
    return `No issues found · ${summaryLine(result)}`;
  }
  const lines: string[] = [];
  for (const finding of result.findings) {
    const location = finding.path
      ? `${finding.path}${finding.line ? `:${finding.line}` : ""}`
      : "(repo)";
    lines.push(`${location}  ${finding.check}  ${finding.message}`);
    if (finding.evidence) {
      lines.push(`    > ${finding.evidence}`);
    }
  }
  lines.push("");
  lines.push(summaryLine(result));
  return lines.join("\n");
}

function escapeAnnotationMessage(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function escapeAnnotationProperty(value: string): string {
  return escapeAnnotationMessage(value)
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

export function formatLintGithub(result: LintResult): string {
  const lines = result.findings.map((finding) => {
    const properties = [
      finding.path && `file=${escapeAnnotationProperty(finding.path)}`,
      finding.line !== undefined && `line=${finding.line}`,
      `title=${escapeAnnotationProperty(`codecut ${finding.check}`)}`,
    ]
      .filter(Boolean)
      .join(",");
    const message = escapeAnnotationMessage(
      `${finding.message}${finding.evidence ? ` "${finding.evidence}"` : ""} ${finding.recovery}`,
    );
    return `::warning ${properties}::${message}`;
  });
  lines.push(summaryLine(result));
  return lines.join("\n");
}

export function formatLintSarif(result: LintResult, version: string): string {
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "codecut-lint",
            version,
            informationUri: "https://github.com/treadiehq/codecut",
            rules: LINT_CHECKS.map((check) => ({
              id: check,
              shortDescription: { text: CHECK_INFO[check].summary },
              help: { text: CHECK_INFO[check].recovery },
            })),
          },
        },
        results: result.findings.map((finding) => ({
          ruleId: finding.check,
          level: "warning",
          message: {
            text: `${finding.message}${finding.evidence ? ` "${finding.evidence}"` : ""} ${finding.recovery}`,
          },
          locations: finding.path
            ? [
                {
                  physicalLocation: {
                    artifactLocation: { uri: finding.path },
                    region: { startLine: finding.line ?? 1 },
                  },
                },
              ]
            : [],
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}

export const LINT_FORMATS = ["text", "json", "github", "sarif"] as const;
export type LintFormat = (typeof LINT_FORMATS)[number];

export function formatLint(
  result: LintResult,
  format: string,
  version: string,
): string {
  switch (format) {
    case "text":
      return formatLintText(result);
    case "json":
      return JSON.stringify(result, null, 2);
    case "github":
      return formatLintGithub(result);
    case "sarif":
      return formatLintSarif(result, version);
    default:
      throw new Error(
        `Unknown format "${format}". Available: ${LINT_FORMATS.join(", ")}.`,
      );
  }
}
