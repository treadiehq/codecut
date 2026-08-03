import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentName } from "../core/schema.js";
import { installClaudeHooks } from "./claude.js";
import { installCodexHooks } from "./codex.js";
import { installCursorHooks } from "./cursor.js";
import { installPolytokenHooks } from "./polytoken.js";

type HookAgent = Exclude<AgentName, "unknown">;

const HOOK_SETTINGS_FILES: Record<HookAgent, string> = {
  claude: path.join(".claude", "settings.json"),
  cursor: path.join(".cursor", "hooks.json"),
  codex: path.join(".codex", "hooks.json"),
  polytoken: path.join(".polytoken", "hooks.json"),
};

const RESOLVE_BINARY =
  'CODECUT_BIN="$(command -v codecut 2>/dev/null || true)"; ' +
  '[ -x "$CODECUT_BIN" ] || CODECUT_BIN="/usr/local/bin/codecut"; ' +
  '[ -x "$CODECUT_BIN" ] || CODECUT_BIN="$HOME/.local/bin/codecut"';

export function userHookCommand(agent: HookAgent): string {
  return `${RESOLVE_BINARY}; "$CODECUT_BIN" hook --agent ${agent} --user`;
}

export async function installUserHooks(
  agent: HookAgent,
  homeDirectory: string = os.homedir(),
): Promise<{ settingsPath: string; addedEvents: string[] }> {
  switch (agent) {
    case "cursor":
      return installCursorHooks(homeDirectory, {
        command: userHookCommand("cursor"),
      });
    case "codex":
      return installCodexHooks(homeDirectory, {
        commands: {
          command: userHookCommand("codex"),
          commandWindows:
            'powershell -NoProfile -Command "codecut hook --agent codex --user"',
        },
      });
    case "polytoken":
      return installPolytokenHooks(homeDirectory, {
        command: userHookCommand("polytoken"),
      });
    case "claude":
      return installClaudeHooks(homeDirectory, {
        command: userHookCommand("claude"),
      });
  }
}

export async function hasProjectHooks(
  projectRoot: string,
  agent: AgentName,
): Promise<boolean> {
  if (agent === "unknown") {
    return false;
  }
  try {
    const raw = await readFile(
      path.join(projectRoot, HOOK_SETTINGS_FILES[agent]),
      "utf8",
    );
    return (
      (raw.includes("codecut") || raw.includes("papercut")) &&
      raw.includes(`hook --agent ${agent}`)
    );
  } catch {
    return false;
  }
}
