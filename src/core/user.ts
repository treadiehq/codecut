import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDirectives } from "./discovery.js";
import { loadPolicy, parsePolicyDocument } from "./project.js";
import type { Directive, Policy } from "./schema.js";

export const USER_RULES_FILE = "AGENTS.md";
export const USER_POLICY_FILE = "policy.json";

export function userConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const base =
    xdgConfigHome && xdgConfigHome.length > 0
      ? xdgConfigHome
      : path.join(os.homedir(), ".config");
  return path.join(base, "codecut");
}

export function userStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  const base =
    xdgStateHome && xdgStateHome.length > 0
      ? xdgStateHome
      : path.join(os.homedir(), ".local", "state");
  return path.join(base, "codecut");
}

export function userEventsPath(
  stateRoot: string,
  stateDirectory: string = userStateDirectory(),
): string {
  const resolvedStateRoot = path.resolve(stateRoot);
  let canonicalStateRoot = resolvedStateRoot;
  try {
    canonicalStateRoot = realpathSync.native(resolvedStateRoot);
  } catch {
    // Hooks may report a path that no longer exists; keep hashing deterministic.
  }
  const digest = createHash("sha256")
    .update(canonicalStateRoot)
    .digest("hex")
    .slice(0, 16);
  return path.join(stateDirectory, `events-${digest}.jsonl`);
}

export function userRulesPath(configDirectory: string): string {
  return path.join(configDirectory, USER_RULES_FILE);
}

export function userPolicyPath(configDirectory: string): string {
  return path.join(configDirectory, USER_POLICY_FILE);
}

export function displayPath(absolutePath: string): string {
  const home = os.homedir();
  return absolutePath === home || absolutePath.startsWith(`${home}${path.sep}`)
    ? `~${absolutePath.slice(home.length)}`
    : absolutePath;
}

function userConfigReadError(
  kind: "rules file" | "policy",
  filePath: string,
  error: unknown,
): Error {
  const code =
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : undefined;
  const problem =
    code === "EISDIR"
      ? "expected a file but found a directory"
      : code === "EACCES" || code === "EPERM"
        ? "permission was denied"
        : error instanceof Error
          ? error.message
          : String(error);
  return new Error(
    `Cannot read Codecut user ${kind} ${displayPath(filePath)}: ${problem}. Repair the path, then rerun \`codecut setup --user --refresh-policy\`.`,
  );
}

export async function discoverUserDirectives(configDirectory: string): Promise<{
  directives: Directive[];
  sources: string[];
}> {
  const rulesFile = userRulesPath(configDirectory);
  let content: string;
  try {
    content = await readFile(rulesFile, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { directives: [], sources: [] };
    }
    throw userConfigReadError("rules file", rulesFile, error);
  }

  return {
    directives: parseDirectives(content, {
      path: displayPath(rulesFile),
      scope: "user",
      conditional: false,
    }),
    sources: [displayPath(rulesFile)],
  };
}

export async function loadUserPolicy(
  configDirectory: string,
): Promise<Policy | undefined> {
  const policyFile = userPolicyPath(configDirectory);
  let raw: string;
  try {
    raw = await readFile(policyFile, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw userConfigReadError("policy", policyFile, error);
  }
  try {
    return parsePolicyDocument(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid Codecut user policy ${displayPath(policyFile)}: ${message}. Repair it or rerun \`codecut setup --user --refresh-policy\`.`,
    );
  }
}

export function mergePolicies(
  projectPolicy: Policy,
  userPolicy: Policy | undefined,
): Policy {
  if (!userPolicy || userPolicy.rules.length === 0) {
    return projectPolicy;
  }

  const projectRuleIds = new Set(projectPolicy.rules.map((rule) => rule.id));
  const userRules = userPolicy.rules.filter(
    (rule) => !projectRuleIds.has(rule.id),
  );
  const newSources = userPolicy.sources.filter(
    (source) => !projectPolicy.sources.includes(source),
  );

  return {
    ...projectPolicy,
    sources: [...projectPolicy.sources, ...newSources],
    rules: [...projectPolicy.rules, ...userRules],
  };
}

export async function loadEffectivePolicy(
  projectRoot: string,
  configDirectory: string = userConfigDirectory(),
): Promise<Policy> {
  const projectPolicy = await loadPolicy(projectRoot);
  const userPolicy = await loadUserPolicy(configDirectory);
  return mergePolicies(projectPolicy, userPolicy);
}

export type EnforcementPolicyResult = {
  policy: Policy;
  warning?: string;
};

/**
 * Load a project policy for hook enforcement without allowing an invalid
 * optional user policy to disable the project's rules.
 */
export async function loadEnforcementPolicy(
  projectRoot: string,
  configDirectory: string = userConfigDirectory(),
): Promise<EnforcementPolicyResult> {
  const projectPolicy = await loadPolicy(projectRoot);
  try {
    const userPolicy = await loadUserPolicy(configDirectory);
    return { policy: mergePolicies(projectPolicy, userPolicy) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      policy: projectPolicy,
      warning: `Codecut enforced the project policy but skipped invalid user policy ${displayPath(userPolicyPath(configDirectory))}: ${message}`,
    };
  }
}
