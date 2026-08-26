import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_RELATIVE_PATH } from "./runtime.js";

const RUNTIME_PATH = RUNTIME_RELATIVE_PATH.split(path.sep).join("/");
export const DEVIN_HOOK_COMMAND =
  `CODECUT_ROOT="\${DEVIN_PROJECT_DIR:-$PWD}"; "$CODECUT_ROOT/${RUNTIME_PATH}" hook --agent devin`;
const TOOL_MATCHER =
  "^(?:exec|write|edit|apply_patch|notebook_edit|mcp__.*)$";

export const DEVIN_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "PostCompaction",
] as const;

type DevinHookEvent = (typeof DEVIN_HOOK_EVENTS)[number];
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function includesCodecutHook(value: unknown): boolean {
  if (!isObject(value) || !Array.isArray(value.hooks)) {
    return false;
  }
  return value.hooks.some(
    (hook) =>
      isObject(hook) &&
      typeof hook.command === "string" &&
      (hook.command.includes("codecut") ||
        hook.command.includes("papercut")) &&
      hook.command.includes("hook --agent devin"),
  );
}

function hookDefinition(event: DevinHookEvent, command: string): JsonObject {
  const definition: JsonObject = {
    hooks: [
      {
        type: "command",
        command,
        timeout: event === "Stop" ? 30 : 15,
      },
    ],
  };
  if (event === "PreToolUse" || event === "PostToolUse") {
    definition.matcher = TOOL_MATCHER;
  }
  return definition;
}

export function mergeDevinHooks(
  input: JsonObject,
  command: string = DEVIN_HOOK_COMMAND,
): {
  hooks: JsonObject;
  changedEvents: DevinHookEvent[];
} {
  const hooks = structuredClone(input);
  const changedEvents: DevinHookEvent[] = [];
  for (const event of DEVIN_HOOK_EVENTS) {
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
  return { hooks, changedEvents };
}

async function readDevinSettings(settingsPath: string): Promise<JsonObject> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    if (!isObject(parsed)) {
      throw new Error("Devin hooks must contain a JSON object.");
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

export function devinUserConfigPath(
  homeDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configDirectory =
    platform === "win32"
      ? environment.APPDATA?.trim() ||
        path.join(homeDirectory, "AppData", "Roaming")
      : environment.XDG_CONFIG_HOME?.trim() ||
        path.join(homeDirectory, ".config");
  return path.join(configDirectory, "devin", "config.json");
}

export async function validateDevinSettings(
  projectRoot: string,
): Promise<void> {
  const settingsPath = path.join(projectRoot, ".devin", "hooks.v1.json");
  try {
    mergeDevinHooks(await readDevinSettings(settingsPath));
  } catch (error) {
    throw new Error(
      `Cannot update ${path.relative(projectRoot, settingsPath)} safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function installDevinHooks(
  rootDirectory: string,
  options: {
    command?: string;
    userLevel?: boolean;
    settingsPath?: string;
  } = {},
): Promise<{
  settingsPath: string;
  addedEvents: DevinHookEvent[];
}> {
  const settingsPath =
    options.settingsPath ??
    (options.userLevel
      ? devinUserConfigPath(rootDirectory)
      : path.join(rootDirectory, ".devin", "hooks.v1.json"));
  let settings: JsonObject;
  try {
    settings = await readDevinSettings(settingsPath);
  } catch (error) {
    throw new Error(
      `Cannot update ${path.relative(rootDirectory, settingsPath)} safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    options.userLevel &&
    settings.hooks !== undefined &&
    !isObject(settings.hooks)
  ) {
    throw new Error(
      `Cannot update ${path.relative(rootDirectory, settingsPath)} safely: Devin user config "hooks" must contain a JSON object.`,
    );
  }

  const currentHooks = options.userLevel
    ? isObject(settings.hooks)
      ? settings.hooks
      : {}
    : settings;
  const merged = mergeDevinHooks(currentHooks, options.command);
  const output = options.userLevel
    ? { ...settings, hooks: merged.hooks }
    : merged.hooks;

  await mkdir(path.dirname(settingsPath), { recursive: true });
  const temporaryPath = `${settingsPath}.codecut.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(output, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  );
  await rename(temporaryPath, settingsPath);
  return { settingsPath, addedEvents: merged.changedEvents };
}
