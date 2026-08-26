import { evaluatePolicy } from "../core/engine.js";
import type { GithubPrEvidence } from "../core/github.js";
import { findProjectRoot } from "../core/project.js";
import type { PushLintEvidence } from "../core/push.js";
import {
  loadEffectivePolicy,
  loadUserPolicy,
  userConfigDirectory,
} from "../core/user.js";
import type {
  DiffStats,
  NormalizedHookEvent,
  Policy,
  PolicyRule,
  Receipt,
} from "../core/schema.js";

type TestResult = {
  ruleId: string;
  directive: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
};

const EDIT_TIME = "2026-01-01T00:00:00.000Z";
const COMMAND_TIME = "2026-01-01T00:00:01.000Z";
const STOP_TIME = "2026-01-01T00:00:02.000Z";

function event(
  stage: NormalizedHookEvent["stage"],
  overrides: Partial<NormalizedHookEvent> = {},
): NormalizedHookEvent {
  return {
    agent: "claude",
    stage,
    sessionId: "codecut-policy-test",
    cwd: process.cwd(),
    occurredAt: stage === "stop" ? STOP_TIME : COMMAND_TIME,
    stopHookActive: false,
    loopCount: 0,
    ...overrides,
  };
}

function editReceipt(): Receipt {
  return {
    version: 1,
    id: "edit",
    timestamp: EDIT_TIME,
    sessionId: "codecut-policy-test",
    kind: "edit",
    path: "src/example.ts",
    changedLines: 10,
  };
}

function commandReceipt(overrides: Partial<Receipt>): Receipt {
  return {
    version: 1,
    id: "command",
    timestamp: COMMAND_TIME,
    sessionId: "codecut-policy-test",
    kind: "command",
    command: "npm test",
    success: true,
    isTest: true,
    isVerification: true,
    location: "local",
    warningCount: 0,
    ...overrides,
  };
}

function fixtureFor(rule: PolicyRule): {
  hookEvent: NormalizedHookEvent;
  receipts: Receipt[];
  diffStats?: DiffStats;
  githubPrEvidence?: GithubPrEvidence;
  pushLintEvidence?: PushLintEvidence;
} | undefined {
  switch (rule.type) {
    case "local-testing":
      return {
        hookEvent: event("pre-tool", {
          toolName: "Bash",
          toolInput: { command: "ssh build-runner npm test" },
        }),
        receipts: [],
      };
    case "require-passing-tests":
      return {
        hookEvent: event("stop"),
        receipts: [
          editReceipt(),
          commandReceipt({ success: false, warningCount: 0 }),
        ],
      };
    case "warnings-as-errors":
      return {
        hookEvent: event("stop"),
        receipts: [
          editReceipt(),
          commandReceipt({ success: true, warningCount: 1 }),
        ],
      };
    case "blast-radius":
      return {
        hookEvent: event("stop"),
        receipts: [editReceipt(), commandReceipt({})],
        diffStats: {
          files: rule.maxFiles + 1,
          added: rule.maxChangedLines + 1,
          deleted: 0,
          complete: true,
        },
      };
    case "verification-evidence":
      return {
        hookEvent: event("stop"),
        receipts: [editReceipt()],
      };
    case "comment-quality":
      return {
        hookEvent: event("post-tool", {
          toolName: "Edit",
          toolInput: {
            file_path: "src/example.ts",
            new_string: "// Per the prompt, keep this implementation here.",
          },
        }),
        receipts: [],
      };
    case "require-ready-github-pr":
      return {
        hookEvent: event("stop"),
        receipts: [],
        githubPrEvidence: {
          status: "draft",
          branch: "feature/example",
          headOid: "0123456789abcdef",
          url: "https://github.com/example/repository/pull/1",
        },
      };
    case "require-clean-push":
      return {
        hookEvent: event("pre-tool", {
          toolName: "Bash",
          toolInput: { command: "git push" },
        }),
        receipts: [],
        pushLintEvidence: {
          status: "findings",
          branch: "feature/example",
          base: "refs/remotes/origin/main",
          range:
            "0123456789abcdef0123456789abcdef01234567..fedcba9876543210fedcba9876543210fedcba98",
          files: 1,
          findings: [
            {
              check: rule.checks[0] ?? "comment-quality",
              path: "src/example.ts",
              line: 1,
              message: "Sample finding.",
            },
          ],
        },
      };
    case "meta-compliance":
    case "advisory":
      return undefined;
  }
}

function testRule(policy: Policy, rule: PolicyRule): TestResult {
  const fixture = fixtureFor(rule);
  if (!fixture || !rule.enabled || rule.mode === "off") {
    return {
      ruleId: rule.id,
      directive: rule.directive,
      status: "SKIP",
      detail: "no automatic sample",
    };
  }

  const decision = evaluatePolicy({
    policy,
    event: fixture.hookEvent,
    receipts: fixture.receipts,
    diffStats: fixture.diffStats,
    githubPrEvidence: fixture.githubPrEvidence,
    pushLintEvidence: fixture.pushLintEvidence,
  });
  const detected = decision.violations.some(
    (violation) => violation.ruleId === rule.id,
  );
  return {
    ruleId: rule.id,
    directive: rule.directive,
    status: detected ? "PASS" : "FAIL",
    detail: detected
      ? decision.outcome === "block"
        ? "sample was blocked"
        : "sample produced a warning"
      : "sample was not caught",
  };
}

export async function testPolicy(cwd: string): Promise<{
  /** Whether a project policy or only user-level rules were tested. */
  scope: "project" | "user";
  projectRoot?: string;
  results: TestResult[];
  passed: boolean;
}> {
  const projectRoot = await findProjectRoot(cwd);
  // No project policy: fall back to the user-level rules, which user-level
  // hooks enforce here regardless of the missing project setup.
  const userFallback = projectRoot
    ? undefined
    : await loadUserPolicy(userConfigDirectory());
  if (!projectRoot && (!userFallback || userFallback.rules.length === 0)) {
    throw new Error(
      "No project policy found here or in a parent directory and no user-level rules are configured. Run `codecut setup --agent claude` for this project or `codecut setup --user` for user-level rules.",
    );
  }
  const policy = projectRoot
    ? await loadEffectivePolicy(projectRoot)
    : (userFallback as NonNullable<typeof userFallback>);
  const results = policy.rules.map((rule) => testRule(policy, rule));
  return {
    scope: projectRoot ? "project" : "user",
    projectRoot: projectRoot ?? undefined,
    results,
    passed: results.every((result) => result.status !== "FAIL"),
  };
}

export function formatPolicyTests(results: TestResult[]): string {
  return results
    .map(
      (result) =>
        `${result.status}  ${result.directive} — ${result.detail}`,
    )
    .join("\n");
}
