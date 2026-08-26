import { access } from "node:fs/promises";
import path from "node:path";
import { compilePolicy, confirmBlockingRules } from "../core/compiler.js";
import { discoverDirectives } from "../core/discovery.js";
import {
  ensureLocalLogIgnored,
  loadPolicy,
  migrateLegacyProjectDirectory,
  policyPath,
  writePolicy,
} from "../core/project.js";
import {
  isSupportedAgentName,
  supportedAgentNames,
  type SupportedAgentName,
} from "../core/agents.js";
import type { Policy } from "../core/schema.js";
import {
  installProjectHooks,
  validateAgentSettings,
} from "../install/registry.js";
import { installRuntime } from "../install/runtime.js";

export type InitResult = {
  projectRoot: string;
  policyPath: string;
  directiveCount: number;
  ruleCount: number;
  blockingRulesConfirmed: boolean;
  policyCreated: boolean;
  policyUpdated: boolean;
  runtimePath?: string;
  runtimeUpdated: boolean;
  hookSettingsPath: string;
  addedHookEvents: string[];
};

export async function initializeProject(options: {
  cwd: string;
  agent: SupportedAgentName;
  accept: boolean;
  force: boolean;
  runtimeSourcePath?: string;
}): Promise<InitResult> {
  if (!isSupportedAgentName(options.agent)) {
    throw new Error(
      `Unsupported agent "${options.agent}". Use ${supportedAgentNames()}.`,
    );
  }

  const projectRoot = path.resolve(options.cwd);
  await migrateLegacyProjectDirectory(projectRoot);
  await validateAgentSettings(projectRoot, options.agent);
  let policyCreated = false;
  let policyUpdated = false;
  let policy: Policy;
  let directiveCount: number;
  try {
    if (options.force) {
      throw new Error("refresh requested");
    }
    await access(policyPath(projectRoot));
    const existingPolicy = await loadPolicy(projectRoot);
    policy = existingPolicy;
    if (!policy.agents.includes(options.agent)) {
      policy = {
        ...policy,
        updatedAt: new Date().toISOString(),
        agents: [...policy.agents, options.agent],
      };
    }
    if (options.accept) {
      policy = confirmBlockingRules(policy);
    }
    if (policy !== existingPolicy) {
      await writePolicy(projectRoot, policy, { force: true });
      policyUpdated = true;
    }
    directiveCount = policy.rules.length;
  } catch {
    const discovery = await discoverDirectives(projectRoot);
    policy = compilePolicy({
      directives: discovery.directives,
      sources: discovery.sources,
      agent: options.agent,
      acceptBlockingRules: options.accept,
    });
    await writePolicy(projectRoot, policy, { force: options.force });
    policyCreated = true;
    directiveCount = discovery.directives.length;
  }

  const runtime = options.runtimeSourcePath
    ? await installRuntime(projectRoot, options.runtimeSourcePath)
    : undefined;
  await ensureLocalLogIgnored(projectRoot);
  const hooks = await installProjectHooks(projectRoot, options.agent);

  return {
    projectRoot,
    policyPath: policyPath(projectRoot),
    directiveCount,
    ruleCount: policy.rules.length,
    blockingRulesConfirmed: policy.rules
      .filter((rule) => rule.mode === "block")
      .every((rule) => rule.confirmed),
    policyCreated,
    policyUpdated,
    runtimePath: runtime?.runtimePath,
    runtimeUpdated: runtime?.updated ?? false,
    hookSettingsPath: hooks.settingsPath,
    addedHookEvents: [...hooks.addedEvents],
  };
}
