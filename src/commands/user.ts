import { access, mkdir, writeFile } from "node:fs/promises";
import { compilePolicy, confirmBlockingRules } from "../core/compiler.js";
import { writePolicyDocument } from "../core/project.js";
import type { Policy } from "../core/schema.js";
import {
  discoverUserDirectives,
  loadUserPolicy,
  userConfigDirectory,
  userPolicyPath,
  userRulesPath,
} from "../core/user.js";

const RULES_TEMPLATE = `# User rules

Rules in this file apply to every project on this machine. Codecut merges
them with each project's policy when hooks run; project rules win when the
two overlap.

## Defaults

- Keep prompts, agent instructions, tickets, and temporary files out of code comments

Add or change rules one per line, then compile them:

\`\`\`sh
codecut setup --user --refresh-policy
\`\`\`

More example rules, shown inside a code fence so they stay inactive:

\`\`\`md
- Never leave prompts, agent instructions, or tickets in code comments
- All unit tests must pass
\`\`\`
`;

export type UserSetupResult = {
  configDirectory: string;
  rulesPath: string;
  policyPath: string;
  rulesFileCreated: boolean;
  policyCreated: boolean;
  policyUpdated: boolean;
  directiveCount: number;
  ruleCount: number;
  blockingRulesConfirmed: boolean;
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function setupUserRules(options: {
  accept: boolean;
  refresh: boolean;
  configDirectory?: string;
}): Promise<UserSetupResult> {
  const configDirectory = options.configDirectory ?? userConfigDirectory();
  const rulesPath = userRulesPath(configDirectory);
  const policyPath = userPolicyPath(configDirectory);
  await mkdir(configDirectory, { recursive: true });

  let rulesFileCreated = false;
  if (!(await exists(rulesPath))) {
    await writeFile(rulesPath, RULES_TEMPLATE, "utf8");
    rulesFileCreated = true;
  }

  let policy: Policy;
  let policyCreated = false;
  let policyUpdated = false;
  let directiveCount: number;
  const existingPolicy = options.refresh
    ? undefined
    : await loadUserPolicy(configDirectory);
  if (existingPolicy) {
    policy = options.accept
      ? confirmBlockingRules(existingPolicy)
      : existingPolicy;
    if (policy !== existingPolicy) {
      await writePolicyDocument(policyPath, policy);
      policyUpdated = true;
    }
    directiveCount = existingPolicy.rules.length;
  } else {
    const discovery = await discoverUserDirectives(configDirectory);
    policy = compilePolicy({
      directives: discovery.directives,
      sources: discovery.sources,
      agent: "unknown",
      acceptBlockingRules: options.accept,
      fallbackToStarterPolicy: false,
    });
    await writePolicyDocument(policyPath, policy);
    policyCreated = true;
    directiveCount = discovery.directives.length;
  }

  return {
    configDirectory,
    rulesPath,
    policyPath,
    rulesFileCreated,
    policyCreated,
    policyUpdated,
    directiveCount,
    ruleCount: policy.rules.length,
    blockingRulesConfirmed: policy.rules
      .filter((rule) => rule.mode === "block")
      .every((rule) => rule.confirmed),
  };
}
