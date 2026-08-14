import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_RELATIVE_PATH } from "./runtime.js";

const RUNTIME_PATH = RUNTIME_RELATIVE_PATH.split(path.sep).join("/");
export const CURSOR_HOOK_COMMAND =
  `CODECUT_ROOT="\${CURSOR_PROJECT_DIR:-$PWD}"; "$CODECUT_ROOT/${RUNTIME_PATH}" hook --agent cursor`;
const TOOL_MATCHER = "Shell|Edit|Write|MultiEdit|NotebookEdit|apply_patch|MCP: .*";
const EVENTS = [
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "afterAgentResponse",
  "stop",
] as const;

type CursorHookEvent = (typeof EVENTS)[number];
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function includesCodecutHook(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      (value.includes("codecut") || value.includes("papercut")) &&
      value.includes("hook --agent cursor")
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

function hookDefinition(event: CursorHookEvent, command: string): JsonObject {
  const definition: JsonObject = {
    command,
    timeout: event === "stop" ? 30 : 15,
  };
  if (event === "stop") {
    definition.loop_limit = 4;
  } else if (event !== "afterAgentResponse") {
    definition.matcher = TOOL_MATCHER;
  }
  return definition;
}

export function mergeCursorHooks(
  input: JsonObject,
  command: string = CURSOR_HOOK_COMMAND,
): {
  settings: JsonObject;
  changedEvents: CursorHookEvent[];
} {
  const settings = structuredClone(input);
  if (settings.version !== undefined && settings.version !== 1) {
    throw new Error(
      `Unsupported Cursor hooks version ${String(settings.version)}. Expected version 1.`,
    );
  }
  settings.version = 1;
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  settings.hooks = hooks;
  const changedEvents: CursorHookEvent[] = [];

  for (const event of EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const unrelated = existing.filter((entry) => !includesCodecutHook(entry));
    const existingCodecut = existing.filter(includesCodecutHook);
    const desired = hookDefinition(event, command);
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

async function readCursorSettings(settingsPath: string): Promise<JsonObject> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    if (!isObject(parsed)) {
      throw new Error("Cursor hooks must contain a JSON object.");
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

export async function validateCursorSettings(
  projectRoot: string,
): Promise<void> {
  const settingsPath = path.join(projectRoot, ".cursor", "hooks.json");
  try {
    mergeCursorHooks(await readCursorSettings(settingsPath));
  } catch (error) {
    throw new Error(
      `Cannot update ${path.relative(projectRoot, settingsPath)} safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function installCursorHooks(
  rootDirectory: string,
  options: { command?: string } = {},
): Promise<{
  settingsPath: string;
  addedEvents: CursorHookEvent[];
}> {
  const settingsPath = path.join(rootDirectory, ".cursor", "hooks.json");
  let merged;
  try {
    merged = mergeCursorHooks(
      await readCursorSettings(settingsPath),
      options.command,
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

export function cursorHookEvents(): readonly CursorHookEvent[] {
  return EVENTS;
}
