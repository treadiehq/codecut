import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_RELATIVE_PATH } from "./runtime.js";

const RUNTIME_PATH = RUNTIME_RELATIVE_PATH.split(path.sep).join("/");
const HOOK_COMMAND =
  `CODECUT_ROOT="\${CLAUDE_PROJECT_DIR:-$PWD}"; "$CODECUT_ROOT/${RUNTIME_PATH}" hook --agent claude`;
const TOOL_MATCHER = "Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch|mcp__.*";

type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hookDefinition(event: HookEventName): JsonObject {
  const definition: JsonObject = {
    hooks: [
      {
        type: "command",
        command: HOOK_COMMAND,
        timeout: event === "Stop" ? 10 : 5,
      },
    ],
  };
  if (event !== "Stop") {
    definition.matcher = TOOL_MATCHER;
  }
  return definition;
}

function includesCodecutHook(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      (value.includes("codecut") || value.includes("papercut")) &&
      value.includes("hook --agent")
    );
  }
  if (Array.isArray(value)) {
    return value.some(includesCodecutHook);
  }
  if (isObject(value)) {
    return Object.values(value).some(includesCodecutHook);
  }
  return false;
}

async function readClaudeSettings(settingsPath: string): Promise<JsonObject> {
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) {
      throw new Error("Claude settings must contain a JSON object.");
    }
    return parsed;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}

export async function validateClaudeSettings(
  projectRoot: string,
): Promise<void> {
  const settingsPath = path.join(projectRoot, ".claude", "settings.json");
  try {
    await readClaudeSettings(settingsPath);
  } catch (error) {
    throw new Error(
      `Cannot update ${path.relative(projectRoot, settingsPath)} safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function installClaudeHooks(projectRoot: string): Promise<{
  settingsPath: string;
  addedEvents: HookEventName[];
}> {
  const settingsPath = path.join(projectRoot, ".claude", "settings.json");
  let settings: JsonObject;
  try {
    settings = await readClaudeSettings(settingsPath);
  } catch (error) {
    throw new Error(
      `Cannot update ${path.relative(projectRoot, settingsPath)} safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  settings.hooks = hooks;
  const events: HookEventName[] = [
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
  ];
  const addedEvents: HookEventName[] = [];

  for (const event of events) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const unrelated = existing.filter((entry) => !includesCodecutHook(entry));
    const existingCodecut = existing.filter(includesCodecutHook);
    const desired = hookDefinition(event);
    if (
      existingCodecut.length !== 1 ||
      JSON.stringify(existingCodecut[0]) !== JSON.stringify(desired)
    ) {
      hooks[event] = [...unrelated, desired];
      addedEvents.push(event);
    }
  }

  await mkdir(path.dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.codecut.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  await rename(temporaryPath, settingsPath);

  return { settingsPath, addedEvents };
}

export function expectedHookCommand(): string {
  return HOOK_COMMAND;
}
