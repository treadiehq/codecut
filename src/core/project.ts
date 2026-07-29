import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { policySchema, type Policy } from "./schema.js";

export const PROJECT_DIRECTORY = ".codecut";
export const LEGACY_PROJECT_DIRECTORY = ".papercut";
export const POLICY_FILE = "policy.json";
export const EVENTS_FILE = "events.jsonl";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function policyPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_DIRECTORY, POLICY_FILE);
}

export function eventsPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_DIRECTORY, EVENTS_FILE);
}

export async function migrateLegacyProjectDirectory(
  projectRoot: string,
): Promise<boolean> {
  const legacyDirectory = path.join(projectRoot, LEGACY_PROJECT_DIRECTORY);
  const destination = path.join(projectRoot, PROJECT_DIRECTORY);
  if (!(await exists(legacyDirectory)) || (await exists(destination))) {
    return false;
  }

  await rename(legacyDirectory, destination);
  await rm(path.join(destination, "runtime", "papercut.cjs"), {
    force: true,
  });
  return true;
}

export async function findProjectRoot(startDirectory: string): Promise<string | undefined> {
  let current = path.resolve(startDirectory);

  while (true) {
    if (await exists(policyPath(current))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export async function loadPolicy(projectRoot: string): Promise<Policy> {
  const raw = await readFile(policyPath(projectRoot), "utf8");
  return policySchema.parse(JSON.parse(raw));
}

export async function writePolicy(
  projectRoot: string,
  policy: Policy,
  options: { force?: boolean } = {},
): Promise<void> {
  const destination = policyPath(projectRoot);
  if (!options.force && (await exists(destination))) {
    throw new Error(
      `${path.relative(projectRoot, destination)} already exists. Use --force to replace it.`,
    );
  }

  const validatedPolicy = policySchema.parse(policy);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(validatedPolicy, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
}

export async function ensureLocalLogIgnored(projectRoot: string): Promise<void> {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const entries = [
    `${PROJECT_DIRECTORY}/${EVENTS_FILE}`,
    `${PROJECT_DIRECTORY}/runtime/`,
  ];
  let content = "";
  if (await exists(gitignorePath)) {
    content = await readFile(gitignorePath, "utf8");
  }

  const lines = new Set(content.split(/\r?\n/));
  const missingEntries = entries.filter((entry) => !lines.has(entry));
  if (missingEntries.length === 0) {
    return;
  }

  const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await writeFile(
    gitignorePath,
    `${content}${separator}${missingEntries.join("\n")}\n`,
    "utf8",
  );
}
