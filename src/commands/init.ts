import { access } from "node:fs/promises";
import path from "node:path";
import { compilePolicy } from "../core/compiler.js";
import { discoverDirectives } from "../core/discovery.js";
import {
  ensureLocalLogIgnored,
  loadPolicy,
  migrateLegacyProjectDirectory,
  policyPath,
  writePolicy,
} from "../core/project.js";
import type { AgentName, Policy } from "../core/schema.js";
import {
  installClaudeHooks,
  validateClaudeSettings,
} from "../install/claude.js";
import {
  installCursorHooks,
  validateCursorSettings,
} from "../install/cursor.js";
import {
  installCodexHooks,
  validateCodexSettings,
} from "../install/codex.js";
import {
  installPolytokenHooks,
  validatePolytokenSettings,
} from "../install/polytoken.js";
import { installRuntime } from "../install/runtime.js";

export type InitResult = {
  projectRoot: string;
  policyPath: string;
  directiveCount: number;
  ruleCount: number;
  blockingRulesConfirmed: boolean;
  policyCreated: boolean;
  runtimePath?: string;
  runtimeUpdated: boolean;
  hookSettingsPath: string;
  addedHookEvents: string[];
};

export async function initializeProject(options: {
  cwd: string;
  agent: AgentName;
  accept: boolean;
  force: boolean;
  runtimeSourcePath?: string;
}): Promise<InitResult> {
  if (!["claude", "cursor", "codex", "polytoken"].includes(options.agent)) {
    throw new Error(
      `Unsupported agent "${options.agent}". Use "claude", "cursor", "codex", or "polytoken".`,
    );
  }

  const projectRoot = path.resolve(options.cwd);
  await migrateLegacyProjectDirectory(projectRoot);
  if (options.agent === "cursor") {
    await validateCursorSettings(projectRoot);
  } else if (options.agent === "codex") {
    await validateCodexSettings(projectRoot);
  } else if (options.agent === "polytoken") {
    await validatePolytokenSettings(projectRoot);
  } else {
    await validateClaudeSettings(projectRoot);
  }
  let policyCreated = false;
  let policy: Policy;
  let directiveCount: number;
  try {
    if (options.force) {
      throw new Error("refresh requested");
    }
    await access(policyPath(projectRoot));
    policy = await loadPolicy(projectRoot);
    if (!policy.agents.includes(options.agent)) {
      policy = {
        ...policy,
        updatedAt: new Date().toISOString(),
        agents: [...policy.agents, options.agent],
      };
      await writePolicy(projectRoot, policy, { force: true });
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
  const hooks =
    options.agent === "cursor"
      ? await installCursorHooks(projectRoot)
      : options.agent === "codex"
        ? await installCodexHooks(projectRoot)
        : options.agent === "polytoken"
          ? await installPolytokenHooks(projectRoot)
        : await installClaudeHooks(projectRoot);

  return {
    projectRoot,
    policyPath: policyPath(projectRoot),
    directiveCount,
    ruleCount: policy.rules.length,
    blockingRulesConfirmed: policy.rules
      .filter((rule) => rule.mode === "block")
      .every((rule) => rule.confirmed),
    policyCreated,
    runtimePath: runtime?.runtimePath,
    runtimeUpdated: runtime?.updated ?? false,
    hookSettingsPath: hooks.settingsPath,
    addedHookEvents: hooks.addedEvents,
  };
}
