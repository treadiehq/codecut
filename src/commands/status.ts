import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  findProjectRoot,
  loadPolicy,
  policyPath,
} from "../core/project.js";
import type { AgentName, PolicyRule } from "../core/schema.js";
import { RUNTIME_RELATIVE_PATH } from "../install/runtime.js";

export type RuleStatus = {
  id: string;
  type: PolicyRule["type"];
  directive: string;
  source: string;
  mode: "block" | "warn" | "off";
};

export type StatusResult = {
  projectRoot: string;
  policyPath: string;
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
  const policy = await loadPolicy(projectRoot);
  const runtimePath = path.join(projectRoot, RUNTIME_RELATIVE_PATH);
  let runtimeInstalled = false;
  try {
    await access(runtimePath);
    runtimeInstalled = true;
  } catch {
    // Missing runtime is reported in health status.
  }
  const settingsPath =
    hookAgent === "cursor"
      ? path.join(projectRoot, ".cursor", "hooks.json")
      : hookAgent === "codex"
        ? path.join(projectRoot, ".codex", "hooks.json")
        : path.join(projectRoot, ".claude", "settings.json");
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
        : ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"];
  let installedHookEvents: string[] = [];
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks?: Record<string, unknown>;
    };
    installedHookEvents = requiredHookEvents.filter((event) => {
      const definition = JSON.stringify(settings.hooks?.[event] ?? "");
      return (
        definition.includes("codecut") &&
        definition.includes(`hook --agent ${hookAgent}`)
      );
    });
  } catch {
    // Missing or invalid settings are reported as incomplete hook health.
  }
  const missingHookEvents = requiredHookEvents.filter(
    (event) => !installedHookEvents.includes(event),
  );

  return {
    projectRoot,
    policyPath: policyPath(projectRoot),
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
      mode:
        rule.mode === "block" && !rule.confirmed ? "warn" : rule.mode,
    })),
  };
}

export function formatStatus(status: StatusResult): string {
  const lines = [
    `project: ${status.projectRoot}`,
    `policy: ${status.policyPath}`,
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
