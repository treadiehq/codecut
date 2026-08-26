import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findProjectRoot,
  loadPolicy,
  policyPath,
} from "../core/project.js";
import type { SupportedAgentName } from "../core/agents.js";
import type { PolicyRule } from "../core/schema.js";
import {
  displayPath,
  loadUserPolicy,
  mergePolicies,
  userConfigDirectory,
  userPolicyPath,
} from "../core/user.js";
import { inspectAgentHooks } from "../install/registry.js";
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
  /** Whether a project policy or only user-level rules are in effect here. */
  scope: "project" | "user";
  projectRoot?: string;
  policyPath: string;
  userPolicyPath?: string;
  userRuleCount: number;
  hookAgent: SupportedAgentName;
  /** Absent in user scope: the runtime is a per-project install. */
  runtimeInstalled?: boolean;
  runtimePath?: string;
  agents: string[];
  sources: string[];
  hooksInstalled: boolean;
  installedHookEvents: string[];
  missingHookEvents: string[];
  rules: RuleStatus[];
};

export async function inspectHookSettings(
  baseDirectory: string,
  hookAgent: SupportedAgentName,
  options: { userLevel?: boolean } = {},
): Promise<{
  settingsPath: string;
  installedHookEvents: string[];
  missingHookEvents: string[];
}> {
  return inspectAgentHooks(baseDirectory, hookAgent, options);
}

function ruleStatuses(policy: {
  rules: {
    id: string;
    type: PolicyRule["type"];
    directive: string;
    source: { path: string; line?: number; scope: RuleStatus["scope"] };
    mode: "block" | "warn" | "off";
    confirmed: boolean;
  }[];
}): RuleStatus[] {
  return policy.rules.map((rule) => ({
    id: rule.id,
    type: rule.type,
    directive: rule.directive,
    source: `${rule.source.path}${rule.source.line ? `:${rule.source.line}` : ""}`,
    scope: rule.source.scope,
    mode: rule.mode === "block" && !rule.confirmed ? "warn" : rule.mode,
  }));
}

export async function getStatus(
  cwd: string,
  hookAgent: SupportedAgentName = "claude",
): Promise<StatusResult> {
  const projectRoot = await findProjectRoot(cwd);
  const configDirectory = userConfigDirectory();
  const userPolicy = await loadUserPolicy(configDirectory);
  if (!projectRoot) {
    if (!userPolicy || userPolicy.rules.length === 0) {
      throw new Error(
        "No project policy found here or in a parent directory and no user-level rules are configured. Run `codecut setup --agent claude` for this project or `codecut setup --user` for user-level rules.",
      );
    }
    // No project policy, but user-level rules enforce here through
    // user-level hooks — report them instead of a misleading hard error.
    const { installedHookEvents, missingHookEvents } =
      await inspectHookSettings(os.homedir(), hookAgent, { userLevel: true });
    const userPolicyDisplayPath = displayPath(userPolicyPath(configDirectory));
    return {
      scope: "user",
      policyPath: userPolicyDisplayPath,
      userPolicyPath: userPolicyDisplayPath,
      userRuleCount: userPolicy.rules.length,
      hookAgent,
      agents: userPolicy.agents,
      sources: userPolicy.sources,
      hooksInstalled: missingHookEvents.length === 0,
      installedHookEvents,
      missingHookEvents,
      rules: ruleStatuses(userPolicy),
    };
  }
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
    scope: "project",
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
    rules: ruleStatuses(policy),
  };
}

export function formatStatus(status: StatusResult): string {
  const lines = [
    ...(status.scope === "user"
      ? ["scope: user-level rules (no project policy here)"]
      : [`project: ${status.projectRoot}`]),
    `policy: ${status.policyPath}`,
    ...(status.userPolicyPath && status.scope === "project"
      ? [`user policy: ${status.userPolicyPath} (${status.userRuleCount} rules)`]
      : []),
    ...(status.runtimePath !== undefined
      ? [`runtime: ${status.runtimeInstalled ? "installed" : "missing"}`]
      : []),
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
