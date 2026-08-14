import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_RELATIVE_PATH } from "./runtime.js";

const RUNTIME_PATH = RUNTIME_RELATIVE_PATH.split(path.sep).join("/");
const WINDOWS_RUNTIME_PATH = path.win32.join(
  ".codecut",
  "runtime",
  "codecut.exe",
);
export const CODEX_HOOK_COMMAND =
  `CODECUT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; "$CODECUT_ROOT/${RUNTIME_PATH}" hook --agent codex`;
const TOOL_MATCHER = "Bash|apply_patch|Edit|Write|mcp__.*";
const EVENTS = ["PreToolUse", "PostToolUse", "Stop"] as const;

type CodexHookEvent = (typeof EVENTS)[number];
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function includesCodecutHook(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("codecut") && value.includes("hook --agent codex");
  }
  if (Array.isArray(value)) {
    return value.some(includesCodecutHook);
  }
  if (isObject(value)) {
    return Object.values(value).some(includesCodecutHook);
  }
  return false;
}

const DEFAULT_COMMANDS = {
  command: CODEX_HOOK_COMMAND,
  commandWindows:
    `powershell -NoProfile -Command "& { $root = (git rev-parse --show-toplevel).Trim(); & (Join-Path $root '${WINDOWS_RUNTIME_PATH}') hook --agent codex }"`,
};

export type CodexCommands = typeof DEFAULT_COMMANDS;

function hookDefinition(
  event: CodexHookEvent,
  commands: CodexCommands,
): JsonObject {
  const definition: JsonObject = {
    hooks: [
      {
        type: "command",
        command: commands.command,
        commandWindows: commands.commandWindows,
        timeout: event === "Stop" ? 30 : 15,
        statusMessage: "Checking Codecut policy",
      },
    ],
  };
  if (event !== "Stop") {
    definition.matcher = TOOL_MATCHER;
  }
  return definition;
}

export function mergeCodexHooks(
  input: JsonObject,
  commands: CodexCommands = DEFAULT_COMMANDS,
): {
  settings: JsonObject;
  changedEvents: CodexHookEvent[];
} {
  const settings = structuredClone(input);
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  settings.hooks = hooks;
  const changedEvents: CodexHookEvent[] = [];

  for (const event of EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const unrelated = existing.filter((entry) => !includesCodecutHook(entry));
    const existingCodecut = existing.filter(includesCodecutHook);
    const desired = hookDefinition(event, commands);
    if (
      existingCodecut.length !== 1 ||
      JSON.stringify(existingCodecut[0]) !== JSON.stringify(desired)
    ) {
      hooks[event] = [...unrelated, desired];
      changedEvents.push(event);
    }
  }

  return { settings, changedEvents };
}

async function readCodexHooks(settingsPath: string): Promise<JsonObject> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    if (!isObject(parsed)) {
      throw new Error("Codex hooks must contain a JSON object.");
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

export async function validateCodexSettings(
  projectRoot: string,
): Promise<void> {
  const settingsPath = path.join(projectRoot, ".codex", "hooks.json");
  try {
    mergeCodexHooks(await readCodexHooks(settingsPath));
  } catch (error) {
    throw new Error(
      `Cannot update ${path.relative(projectRoot, settingsPath)} safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function installCodexHooks(
  rootDirectory: string,
  options: { commands?: CodexCommands } = {},
): Promise<{
  settingsPath: string;
  addedEvents: CodexHookEvent[];
}> {
  const settingsPath = path.join(rootDirectory, ".codex", "hooks.json");
  let merged;
  try {
    merged = mergeCodexHooks(
      await readCodexHooks(settingsPath),
      options.commands,
    );
  } catch (error) {
    throw new Error(
      `Cannot update ${path.relative(rootDirectory, settingsPath)} safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  await mkdir(path.dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.codecut.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(merged.settings, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  );
  await rename(temporaryPath, settingsPath);
  return { settingsPath, addedEvents: merged.changedEvents };
}
