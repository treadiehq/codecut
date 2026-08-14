import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentName, HookStage } from "../core/schema.js";
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
  stage?: HookStage,
): Promise<boolean> {
  if (agent === "unknown") {
    return false;
  }
  try {
    const raw = await readFile(
      path.join(projectRoot, HOOK_SETTINGS_FILES[agent]),
      "utf8",
    );
    const parsed = JSON.parse(raw) as unknown;
    const eventNames: Record<HookAgent, Partial<Record<HookStage, string>>> = {
      claude: {
        "pre-tool": "PreToolUse",
        "post-tool": "PostToolUse",
        "post-tool-failure": "PostToolUseFailure",
        stop: "Stop",
      },
      cursor: {
        "pre-tool": "preToolUse",
        "post-tool": "postToolUse",
        "post-tool-failure": "postToolUseFailure",
        "agent-response": "afterAgentResponse",
        stop: "stop",
      },
      codex: {
        "pre-tool": "PreToolUse",
        "post-tool": "PostToolUse",
        stop: "Stop",
      },
      polytoken: {
        "pre-tool": "pre_tool_use",
        "post-tool": "post_tool_use",
        "post-tool-failure": "post_tool_use_failure",
        "agent-response": "post_model_turn",
        stop: "stop",
      },
    };
    const includesAgentHook = (value: unknown): boolean => {
      const serialized = JSON.stringify(value);
      return (
        (serialized.includes("codecut") || serialized.includes("papercut")) &&
        serialized.includes(`hook --agent ${agent}`)
      );
    };
    if (!stage) {
      return includesAgentHook(parsed);
    }
    const eventName = eventNames[agent][stage];
    if (!eventName) {
      return false;
    }
    if (agent === "polytoken") {
      return (
        Array.isArray(parsed) &&
        parsed.some(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            (entry as Record<string, unknown>).event === eventName &&
            includesAgentHook(entry),
        )
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const hooks = (parsed as Record<string, unknown>).hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
      return false;
    }
    const handlers = (hooks as Record<string, unknown>)[eventName];
    return Array.isArray(handlers) && handlers.some(includesAgentHook);
  } catch {
    return false;
  }
}
