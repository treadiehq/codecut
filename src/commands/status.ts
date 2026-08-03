import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  findProjectRoot,
  loadPolicy,
  policyPath,
} from "../core/project.js";
import type { AgentName, PolicyRule } from "../core/schema.js";
import {
  displayPath,
  loadUserPolicy,
  mergePolicies,
  userConfigDirectory,
  userPolicyPath,
} from "../core/user.js";
import { RUNTIME_RELATIVE_PATH } from "../install/runtime.js";

export type RuleStatus = {
  id: string;
  type: PolicyRule["type"];
  directive: string;
  source: string;
  scope: "project" | "user" | "generated";
  mode: "block" | "warn" | "off";
};

export type StatusResult = {
  projectRoot: string;
  policyPath: string;
  userPolicyPath?: string;
  userRuleCount: number;
  hookAgent: AgentName;
  runtimeInstalled: boolean;
  runtimePath: string;
  agents: string[];
  sources: string[];
  hooksInstalled: boolean;
  installedHookEvents: string[];
  missingHookEvents: string[];
  rules: RuleStatus[];
};

export async function inspectHookSettings(
  baseDirectory: string,
  hookAgent: AgentName,
): Promise<{
  settingsPath: string;
  installedHookEvents: string[];
  missingHookEvents: string[];
}> {
  const settingsPath =
    hookAgent === "cursor"
      ? path.join(baseDirectory, ".cursor", "hooks.json")
      : hookAgent === "codex"
        ? path.join(baseDirectory, ".codex", "hooks.json")
        : hookAgent === "polytoken"
          ? path.join(baseDirectory, ".polytoken", "hooks.json")
        : path.join(baseDirectory, ".claude", "settings.json");
  const requiredHookEvents =
    hookAgent === "cursor"
      ? [
          "preToolUse",
          "postToolUse",
          "postToolUseFailure",
          "afterAgentResponse",
          "stop",
        ]
      : hookAgent === "codex"
        ? ["PreToolUse", "PostToolUse", "Stop"]
        : hookAgent === "polytoken"
          ? [
              "pre_tool_use",
              "post_tool_use",
              "post_tool_use_failure",
              "post_model_turn",
              "stop",
            ]
        : ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"];
  let installedHookEvents: string[] = [];
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    if (hookAgent === "polytoken" && Array.isArray(settings)) {
      installedHookEvents = requiredHookEvents.filter((event) =>
        settings.some((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return false;
          }
          const definition = entry as Record<string, unknown>;
          const serialized = JSON.stringify(definition);
          return (
            definition.event === event &&
            serialized.includes("codecut") &&
            serialized.includes("hook --agent polytoken")
          );
        }),
      );
    } else if (
      settings &&
      typeof settings === "object" &&
      !Array.isArray(settings)
    ) {
      const hooks = (settings as { hooks?: Record<string, unknown> }).hooks;
      installedHookEvents = requiredHookEvents.filter((event) => {
        const definition = JSON.stringify(hooks?.[event] ?? "");
        return (
          definition.includes("codecut") &&
          definition.includes(`hook --agent ${hookAgent}`)
        );
      });
    }
  } catch {
    // Missing or invalid settings are reported as incomplete hook health.
  }
  const missingHookEvents = requiredHookEvents.filter(
    (event) => !installedHookEvents.includes(event),
  );

  return { settingsPath, installedHookEvents, missingHookEvents };
}

export async function getStatus(
  cwd: string,
  hookAgent: AgentName = "claude",
): Promise<StatusResult> {
  const projectRoot = await findProjectRoot(cwd);
  if (!projectRoot) {
    throw new Error(
      "No Codecut policy found here or in a parent directory. Run `codecut setup`.",
    );
  }
  const configDirectory = userConfigDirectory();
  const userPolicy = await loadUserPolicy(configDirectory);
  const policy = mergePolicies(await loadPolicy(projectRoot), userPolicy);
  const runtimePath = path.join(projectRoot, RUNTIME_RELATIVE_PATH);
  let runtimeInstalled = false;
  try {
    await access(runtimePath);
    runtimeInstalled = true;
  } catch {
    // Missing runtime is reported in health status.
  }
  const { installedHookEvents, missingHookEvents } = await inspectHookSettings(
    projectRoot,
    hookAgent,
  );

  return {
    projectRoot,
    policyPath: policyPath(projectRoot),
    userPolicyPath: userPolicy
      ? displayPath(userPolicyPath(configDirectory))
      : undefined,
    userRuleCount: userPolicy?.rules.length ?? 0,
    hookAgent,
    runtimeInstalled,
    runtimePath,
    agents: policy.agents,
    sources: policy.sources,
    hooksInstalled: missingHookEvents.length === 0,
    installedHookEvents,
    missingHookEvents,
    rules: policy.rules.map((rule) => ({
      id: rule.id,
      type: rule.type,
      directive: rule.directive,
      source: `${rule.source.path}${rule.source.line ? `:${rule.source.line}` : ""}`,
      scope: rule.source.scope,
      mode:
        rule.mode === "block" && !rule.confirmed ? "warn" : rule.mode,
    })),
  };
}

export function formatStatus(status: StatusResult): string {
  const lines = [
    `project: ${status.projectRoot}`,
    `policy: ${status.policyPath}`,
    ...(status.userPolicyPath
      ? [`user policy: ${status.userPolicyPath} (${status.userRuleCount} rules)`]
      : []),
    `runtime: ${status.runtimeInstalled ? "installed" : "missing"}`,
    `agents: ${status.agents.join(", ")}`,
    `hooks (${status.hookAgent}): ${
      status.hooksInstalled
        ? "installed"
        : `incomplete; missing: ${status.missingHookEvents.join(", ")}`
    }`,
    `sources: ${status.sources.join(", ")}`,
    "rules:",
  ];

  for (const rule of status.rules) {
    lines.push(
      `  ${rule.mode.padEnd(5)}  ${rule.directive} (${rule.source})`,
    );
  }
  return lines.join("\n");
}
