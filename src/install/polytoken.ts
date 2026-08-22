import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const POLYTOKEN_HOOK_COMMAND =
  'CODECUT_ROOT="${POLYTOKEN_PROJECT_DIR:-${POLYTOKEN_PROJECT_PATH:-$PWD}}"; CODECUT_BIN="$CODECUT_ROOT/.codecut/runtime/codecut"; [ -x "$CODECUT_BIN" ] || CODECUT_BIN="$CODECUT_BIN.exe"; "$CODECUT_BIN" hook --agent polytoken';

const EVENTS = [
  "pre_tool_use",
  "post_tool_use",
  "post_tool_use_failure",
  "post_model_turn",
  "stop",
  // Context-reset signals: a cleared or compacted context no longer
  // contains previously delivered warnings, so codecut re-arms them.
  "post_clear",
  "post_compaction",
] as const;

type PolytokenHookEvent = (typeof EVENTS)[number];
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function includesCodecutHook(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  const name = typeof value.name === "string" ? value.name : "";
  return (
    name.startsWith("codecut-") ||
    JSON.stringify(value).includes("hook --agent polytoken")
  );
}

function hookDefinition(
  event: PolytokenHookEvent,
  command: string,
): JsonObject {
  return {
    name: `codecut-${event.replaceAll("_", "-")}`,
    event,
    handler: { bash: command },
  };
}

export function mergePolytokenHooks(
  input: unknown[],
  command: string = POLYTOKEN_HOOK_COMMAND,
): {
  settings: unknown[];
  changedEvents: PolytokenHookEvent[];
} {
  const existingCodecut = input.filter(includesCodecutHook);
  const unrelated = input.filter((entry) => !includesCodecutHook(entry));
  const desired = EVENTS.map((event) => hookDefinition(event, command));
  const changedEvents = EVENTS.filter((event, index) => {
    const matches = existingCodecut.filter(
      (entry) => isObject(entry) && entry.event === event,
    );
    return (
      matches.length !== 1 ||
      JSON.stringify(matches[0]) !== JSON.stringify(desired[index])
    );
  });
  return { settings: [...unrelated, ...desired], changedEvents };
}

async function readPolytokenHooks(settingsPath: string): Promise<unknown[]> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("Polytoken hooks must contain a JSON array.");
    }
    return parsed;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

export async function validatePolytokenSettings(
  projectRoot: string,
): Promise<void> {
  const settingsPath = path.join(projectRoot, ".polytoken", "hooks.json");
  try {
    mergePolytokenHooks(await readPolytokenHooks(settingsPath));
  } catch (error) {
    throw new Error(
      `Cannot update ${path.relative(projectRoot, settingsPath)} safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function installPolytokenHooks(
  rootDirectory: string,
  options: { command?: string; settingsPath?: string } = {},
): Promise<{
  settingsPath: string;
  addedEvents: PolytokenHookEvent[];
}> {
  const settingsPath =
    options.settingsPath ?? path.join(rootDirectory, ".polytoken", "hooks.json");
  let merged;
  try {
    merged = mergePolytokenHooks(
      await readPolytokenHooks(settingsPath),
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
