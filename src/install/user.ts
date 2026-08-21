import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentName, HookStage } from "../core/schema.js";
import { installClaudeHooks } from "./claude.js";
import { installCodexHooks } from "./codex.js";
import { installCursorHooks } from "./cursor.js";
import { installPolytokenHooks } from "./polytoken.js";

type HookAgent = Exclude<AgentName, "unknown">;

const HOOK_SETTINGS_FILES: Record<Exclude<HookAgent, "polytoken">, string> = {
  claude: path.join(".claude", "settings.json"),
  cursor: path.join(".cursor", "hooks.json"),
  codex: path.join(".codex", "hooks.json"),
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isCodecutCommand(value: unknown, agent: HookAgent): boolean {
  return (
    typeof value === "string" &&
    (value.includes("codecut") || value.includes("papercut")) &&
    value.includes(`hook --agent ${agent}`)
  );
}

function entryHasCodecutCommand(
  entry: unknown,
  agent: HookAgent,
): boolean {
  if (!isObject(entry)) {
    return false;
  }
  if (agent === "cursor") {
    return isCodecutCommand(entry.command, agent);
  }
  if (agent === "polytoken") {
    const handler = entry.handler;
    return isObject(handler) && isCodecutCommand(handler.bash, agent);
  }
  const handlers = entry.hooks;
  return (
    Array.isArray(handlers) &&
    handlers.some(
      (handler) =>
        isObject(handler) &&
        (isCodecutCommand(handler.command, agent) ||
          isCodecutCommand(handler.commandWindows, agent)),
    )
  );
}

function polytokenUserHooksPath(
  homeDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const xdgConfigHome = environment.XDG_CONFIG_HOME?.trim();
  const configDirectory =
    xdgConfigHome && xdgConfigHome.length > 0
      ? xdgConfigHome
      : path.join(homeDirectory, ".config");
  return path.join(configDirectory, "polytoken", "hooks.json");
}

function hookSettingsPath(
  baseDirectory: string,
  hookAgent: HookAgent,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return hookAgent === "polytoken"
    ? polytokenUserHooksPath(baseDirectory, environment)
    : path.join(baseDirectory, HOOK_SETTINGS_FILES[hookAgent]);
}

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
        settingsPath: hookSettingsPath(homeDirectory, "polytoken"),
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
    // Project polytoken hooks live in-repo; user-level ones live under the
    // XDG config path (see hookSettingsPath).
    const settingsPath =
      agent === "polytoken"
        ? path.join(projectRoot, ".polytoken", "hooks.json")
        : path.join(projectRoot, HOOK_SETTINGS_FILES[agent]);
    const raw = await readFile(settingsPath, "utf8");
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
    if (agent === "polytoken") {
      return (
        Array.isArray(parsed) &&
        parsed.some(
          (entry) =>
            (!stage ||
              (isObject(entry) &&
                entry.event === eventNames[agent][stage])) &&
            entryHasCodecutCommand(entry, agent),
        )
      );
    }
    if (!isObject(parsed)) {
      return false;
    }
    const hooks = parsed.hooks;
    if (!isObject(hooks)) {
      return false;
    }
    if (!stage) {
      return Object.values(hooks).some(
        (entries) =>
          Array.isArray(entries) &&
          entries.some((entry) => entryHasCodecutCommand(entry, agent)),
      );
    }
    const eventName = eventNames[agent][stage];
    if (!eventName) {
      return false;
    }
    const entries = hooks[eventName];
    return (
      Array.isArray(entries) &&
      entries.some((entry) => entryHasCodecutCommand(entry, agent))
    );
  } catch {
    return false;
  }
}
