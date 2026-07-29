import { evaluatePolicy } from "../core/engine.js";
import { findProjectRoot, loadPolicy } from "../core/project.js";
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
  projectRoot: string;
  results: TestResult[];
  passed: boolean;
}> {
  const projectRoot = await findProjectRoot(cwd);
  if (!projectRoot) {
    throw new Error(
      "No Codecut policy found here or in a parent directory. Run `codecut setup`.",
    );
  }
  const policy = await loadPolicy(projectRoot);
  const results = policy.rules.map((rule) => testRule(policy, rule));
  return {
    projectRoot,
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
