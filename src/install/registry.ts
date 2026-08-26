import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SupportedAgentName } from "../core/agents.js";
import type { AgentName, HookStage } from "../core/schema.js";
import {
  CLAUDE_HOOK_EVENTS,
  installClaudeHooks,
  validateClaudeSettings,
} from "./claude.js";
import {
  CODEX_HOOK_EVENTS,
  installCodexHooks,
  validateCodexSettings,
} from "./codex.js";
import {
  CURSOR_HOOK_EVENTS,
  installCursorHooks,
  validateCursorSettings,
} from "./cursor.js";
import {
  devinUserConfigPath,
  DEVIN_HOOK_EVENTS,
  installDevinHooks,
  validateDevinSettings,
} from "./devin.js";
import {
  inspectOpenCodePlugin,
  installOpenCodeHooks,
  OPENCODE_HOOK_EVENTS,
  openCodePluginPath,
  validateOpenCodeSettings,
} from "./opencode.js";
import {
  installPolytokenHooks,
  POLYTOKEN_HOOK_EVENTS,
  validatePolytokenSettings,
} from "./polytoken.js";

type JsonObject = Record<string, unknown>;

export type HookInstallResult = {
  settingsPath: string;
  addedEvents: readonly string[];
};

export const REQUIRED_HOOK_EVENTS: Record<
  SupportedAgentName,
  readonly string[]
> = {
  claude: CLAUDE_HOOK_EVENTS,
  cursor: CURSOR_HOOK_EVENTS,
  codex: CODEX_HOOK_EVENTS,
  devin: DEVIN_HOOK_EVENTS,
  opencode: OPENCODE_HOOK_EVENTS,
  polytoken: POLYTOKEN_HOOK_EVENTS,
};

const STAGE_EVENTS: Record<
  SupportedAgentName,
  Partial<Record<HookStage, readonly string[]>>
> = {
  claude: {
    "pre-tool": ["PreToolUse"],
    "post-tool": ["PostToolUse"],
    "post-tool-failure": ["PostToolUseFailure"],
    stop: ["Stop"],
    "context-reset": ["SessionStart"],
  },
  cursor: {
    "pre-tool": ["preToolUse"],
    "post-tool": ["postToolUse"],
    "post-tool-failure": ["postToolUseFailure"],
    "agent-response": ["afterAgentResponse"],
    stop: ["stop"],
    "context-reset": ["preCompact"],
  },
  codex: {
    "pre-tool": ["PreToolUse"],
    "post-tool": ["PostToolUse"],
    stop: ["Stop"],
    "context-reset": ["SessionStart"],
  },
  devin: {
    "pre-tool": ["PreToolUse"],
    "post-tool": ["PostToolUse"],
    "post-tool-failure": ["PostToolUse"],
    stop: ["Stop"],
    "context-reset": ["PostCompaction"],
  },
  opencode: {
    "pre-tool": ["tool.execute.before"],
    "post-tool": ["tool.execute.after"],
    "post-tool-failure": ["tool.execute.after"],
    stop: ["session.idle"],
    "context-reset": ["session.compacted"],
  },
  polytoken: {
    "pre-tool": ["pre_tool_use"],
    "post-tool": ["post_tool_use"],
    "post-tool-failure": ["post_tool_use_failure"],
    "agent-response": ["post_model_turn"],
    stop: ["stop"],
    "context-reset": ["post_clear", "post_compaction"],
  },
};

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function polytokenUserHooksPath(
  homeDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configDirectory =
    environment.XDG_CONFIG_HOME?.trim() ||
    path.join(homeDirectory, ".config");
  return path.join(configDirectory, "polytoken", "hooks.json");
}

export function projectHookSettingsPath(
  projectRoot: string,
  agent: SupportedAgentName,
): string {
  switch (agent) {
    case "claude":
      return path.join(projectRoot, ".claude", "settings.json");
    case "cursor":
      return path.join(projectRoot, ".cursor", "hooks.json");
    case "codex":
      return path.join(projectRoot, ".codex", "hooks.json");
    case "devin":
      return path.join(projectRoot, ".devin", "hooks.v1.json");
    case "opencode":
      return openCodePluginPath(projectRoot);
    case "polytoken":
      return path.join(projectRoot, ".polytoken", "hooks.json");
  }
}

export function userHookSettingsPath(
  homeDirectory: string,
  agent: SupportedAgentName,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (agent === "polytoken") {
    return polytokenUserHooksPath(homeDirectory, environment);
  }
  if (agent === "devin") {
    return devinUserConfigPath(homeDirectory, environment);
  }
  if (agent === "opencode") {
    return openCodePluginPath(homeDirectory, {
      userLevel: true,
      environment,
    });
  }
  return projectHookSettingsPath(homeDirectory, agent);
}

export async function validateAgentSettings(
  projectRoot: string,
  agent: SupportedAgentName,
): Promise<void> {
  switch (agent) {
    case "claude":
      await validateClaudeSettings(projectRoot);
      return;
    case "cursor":
      await validateCursorSettings(projectRoot);
      return;
    case "codex":
      await validateCodexSettings(projectRoot);
      return;
    case "devin":
      await validateDevinSettings(projectRoot);
      return;
    case "opencode":
      await validateOpenCodeSettings(projectRoot);
      return;
    case "polytoken":
      await validatePolytokenSettings(projectRoot);
      return;
  }
}

export async function installProjectHooks(
  projectRoot: string,
  agent: SupportedAgentName,
): Promise<HookInstallResult> {
  switch (agent) {
    case "claude":
      return installClaudeHooks(projectRoot);
    case "cursor":
      return installCursorHooks(projectRoot);
    case "codex":
      return installCodexHooks(projectRoot);
    case "devin":
      return installDevinHooks(projectRoot);
    case "opencode":
      return installOpenCodeHooks(projectRoot);
    case "polytoken":
      return installPolytokenHooks(projectRoot);
  }
}

const RESOLVE_BINARY =
  'CODECUT_BIN="$(command -v codecut 2>/dev/null || true)"; ' +
  '[ -x "$CODECUT_BIN" ] || CODECUT_BIN="/usr/local/bin/codecut"; ' +
  '[ -x "$CODECUT_BIN" ] || CODECUT_BIN="$HOME/.local/bin/codecut"';

export function userHookCommand(agent: SupportedAgentName): string {
  return `${RESOLVE_BINARY}; "$CODECUT_BIN" hook --agent ${agent} --user`;
}

export async function installUserAgentHooks(
  agent: SupportedAgentName,
  homeDirectory: string = os.homedir(),
): Promise<HookInstallResult> {
  switch (agent) {
    case "claude":
      return installClaudeHooks(homeDirectory, {
        command: userHookCommand("claude"),
      });
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
    case "devin":
      return installDevinHooks(homeDirectory, {
        command: "codecut hook --agent devin --user",
        userLevel: true,
        settingsPath: userHookSettingsPath(homeDirectory, "devin"),
      });
    case "opencode":
      return installOpenCodeHooks(homeDirectory, {
        userLevel: true,
        pluginPath: userHookSettingsPath(homeDirectory, "opencode"),
      });
    case "polytoken":
      return installPolytokenHooks(homeDirectory, {
        command: userHookCommand("polytoken"),
        settingsPath: userHookSettingsPath(homeDirectory, "polytoken"),
      });
  }
}

function isCodecutCommand(
  value: unknown,
  agent: SupportedAgentName,
): boolean {
  return (
    typeof value === "string" &&
    (value.includes("codecut") || value.includes("papercut")) &&
    value.includes(`hook --agent ${agent}`)
  );
}

function entryHasCodecutCommand(
  entry: unknown,
  agent: SupportedAgentName,
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

async function installedJsonHookEvents(
  settingsPath: string,
  agent: Exclude<SupportedAgentName, "opencode">,
): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    if (agent === "polytoken") {
      if (!Array.isArray(parsed)) {
        return [];
      }
      return REQUIRED_HOOK_EVENTS[agent].filter((event) =>
        parsed.some(
          (entry) =>
            isObject(entry) &&
            entry.event === event &&
            entryHasCodecutCommand(entry, agent),
        ),
      );
    }
    if (!isObject(parsed)) {
      return [];
    }
    const hooks =
      agent === "devin"
        ? isObject(parsed.hooks)
          ? parsed.hooks
          : parsed
        : isObject(parsed.hooks)
          ? parsed.hooks
          : undefined;
    if (!hooks) {
      return [];
    }
    return REQUIRED_HOOK_EVENTS[agent].filter((event) => {
      const entries = hooks[event];
      return (
        Array.isArray(entries) &&
        entries.some((entry) => entryHasCodecutCommand(entry, agent))
      );
    });
  } catch {
    return [];
  }
}

export async function inspectAgentHooks(
  baseDirectory: string,
  agent: SupportedAgentName,
  options: { userLevel?: boolean } = {},
): Promise<{
  settingsPath: string;
  installedHookEvents: string[];
  missingHookEvents: string[];
}> {
  const settingsPath = options.userLevel
    ? userHookSettingsPath(baseDirectory, agent)
    : projectHookSettingsPath(baseDirectory, agent);
  let installedHookEvents: string[] = [];
  try {
    installedHookEvents =
      agent === "opencode"
        ? await inspectOpenCodePlugin(settingsPath)
        : await installedJsonHookEvents(settingsPath, agent);
  } catch {
    // Missing, unreadable, or invalid hook files are reported as incomplete.
  }
  const missingHookEvents = REQUIRED_HOOK_EVENTS[agent].filter(
    (event) => !installedHookEvents.includes(event),
  );
  return { settingsPath, installedHookEvents, missingHookEvents };
}

export async function hasProjectHooks(
  projectRoot: string,
  agent: AgentName,
  stage?: HookStage,
): Promise<boolean> {
  if (agent === "unknown") {
    return false;
  }
  const installed = await inspectAgentHooks(projectRoot, agent);
  if (!stage) {
    return installed.installedHookEvents.length > 0;
  }
  const stageEvents = STAGE_EVENTS[agent][stage] ?? [];
  return stageEvents.some((event) =>
    installed.installedHookEvents.includes(event),
  );
}
