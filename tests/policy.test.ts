import { describe, expect, it } from "vitest";
import { compilePolicy } from "../src/core/compiler.js";
import { evaluatePolicy } from "../src/core/engine.js";
import {
  deriveAcknowledgementReceipts,
  deriveReceipts,
  extractAddedCommentBlocks,
} from "../src/core/events.js";
import type {
  Directive,
  NormalizedHookEvent,
  Policy,
  Receipt,
} from "../src/core/schema.js";
import { policySchema } from "../src/core/schema.js";

const directives = [
  "Don't skip directives",
  "Treat warnings as errors",
  "All unit tests must pass",
  "Favor high confidence changes with a low blast radius",
  "Verify, don't assume",
  "Use local machines for testing",
  "Do not add comments that reference prompts, instructions, tickets, or temporary specification files",
].map(
  (text, index): Directive => ({
    text,
    source: { path: "CLAUDE.md", line: index + 1, scope: "project" },
  }),
);

function policy(accept = true): Policy {
  return compilePolicy({
    directives,
    sources: ["CLAUDE.md"],
    agent: "claude",
    acceptBlockingRules: accept,
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
}

function hookEvent(
  stage: NormalizedHookEvent["stage"],
  overrides: Partial<NormalizedHookEvent> = {},
): NormalizedHookEvent {
  return {
    agent: "claude",
    stage,
    sessionId: "session-1",
    cwd: "/tmp/project",
    occurredAt: "2026-01-01T00:00:03.000Z",
    stopHookActive: false,
    loopCount: 0,
    ...overrides,
  };
}

function edit(timestamp = "2026-01-01T00:00:01.000Z"): Receipt {
  return {
    version: 1,
    id: `edit-${timestamp}`,
    timestamp,
    sessionId: "session-1",
    kind: "edit",
    path: "src/example.ts",
    changedLines: 4,
  };
}

function verification(
  overrides: Partial<Receipt> = {},
  timestamp = "2026-01-01T00:00:02.000Z",
): Receipt {
  return {
    version: 1,
    id: `verification-${timestamp}`,
    timestamp,
    sessionId: "session-1",
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

describe("starter policy compilation", () => {
  it("uses clear starter rules with the intended checks", () => {
    const compiled = compilePolicy({
      directives: [],
      sources: [],
      agent: "cursor",
      acceptBlockingRules: true,
    });

    expect(compiled.sources).toEqual(["starter policy"]);
    expect(compiled.rules.map((rule) => rule.directive)).toEqual([
      "Treat warnings as errors",
      "All unit tests must pass",
      "Keep changes small and focused",
      "Verify your work",
      "Run tests locally",
      "Keep prompts, agent instructions, tickets, and temporary files out of code comments",
    ]);
    expect(compiled.rules[4]?.type).toBe("local-testing");
  });

  it("classifies David's directives into the intended policy types", () => {
    const compiled = policy();
    expect(compiled.agents).toEqual([
      "claude",
      "cursor",
      "codex",
      "polytoken",
    ]);
    expect(compiled.rules.map((rule) => rule.type)).toEqual([
      "advisory",
      "warnings-as-errors",
      "require-passing-tests",
      "blast-radius",
      "verification-evidence",
      "local-testing",
      "comment-quality",
    ]);
    expect(
      compiled.rules
        .filter((rule) => rule.mode === "block")
        .every((rule) => rule.confirmed),
    ).toBe(true);
  });

  it("labels generic compliance instructions as advice-only", () => {
    const compiled = policy();
    const genericCompliance = compiled.rules[0];

    expect(genericCompliance?.directive).toBe("Don't skip directives");
    expect(genericCompliance?.type).toBe("advisory");
  });

  it("downgrades inferred hard blocks until explicitly accepted", () => {
    const compiled = policy(false);
    const remoteTest = hookEvent("pre-tool", {
      toolName: "Bash",
      toolInput: { command: "ssh runner npm test" },
    });
    const decision = evaluatePolicy({
      policy: compiled,
      event: remoteTest,
      receipts: [],
    });

    expect(decision.outcome).toBe("warn");
    expect(decision.violations[0]?.ruleId).toContain("local-testing");
  });

  it("keeps ambiguous warning guidance advisory", () => {
    const compiled = compilePolicy({
      directives: [
        {
          text: "Ignore warnings from generated code",
          source: { path: "CLAUDE.md", line: 1, scope: "project" },
        },
      ],
      sources: ["CLAUDE.md"],
      agent: "claude",
      acceptBlockingRules: true,
    });

    expect(compiled.rules[0]?.type).toBe("advisory");
  });

  it("keeps negated and inline-scoped blocking phrases advisory", () => {
    const compiled = compilePolicy({
      directives: [
        {
          text: "Not all unit tests must pass",
          source: { path: "CLAUDE.md", line: 1, scope: "project" },
        },
        {
          text: "Never treat warnings as errors in generated code",
          source: { path: "CLAUDE.md", line: 2, scope: "project" },
        },
        {
          text: "Only when editing release docs, all unit tests must pass",
          source: { path: "CLAUDE.md", line: 3, scope: "project" },
        },
        {
          text: "Do not require tests to run locally",
          source: { path: "CLAUDE.md", line: 4, scope: "project" },
        },
        {
          text: "Do not verify generated files",
          source: { path: "CLAUDE.md", line: 5, scope: "project" },
        },
        {
          text: "Only when migrating, keep changes small and focused",
          source: { path: "CLAUDE.md", line: 6, scope: "project" },
        },
        {
          text: "Comments may reference prompts in generated fixtures",
          source: { path: "CLAUDE.md", line: 7, scope: "project" },
        },
        {
          text: "For release builds, all unit tests must pass",
          source: { path: "CLAUDE.md", line: 8, scope: "project" },
        },
        {
          text: "While editing generated files, verify your work",
          source: { path: "CLAUDE.md", line: 9, scope: "project" },
        },
        {
          text: "You should not verify generated snapshots",
          source: { path: "CLAUDE.md", line: 10, scope: "project" },
        },
        {
          text: "Treat warnings as errors and all unit tests must pass",
          source: { path: "CLAUDE.md", line: 11, scope: "project" },
        },
        {
          text: "All unit tests must pass and run tests locally",
          source: { path: "CLAUDE.md", line: 12, scope: "project" },
        },
      ],
      sources: ["CLAUDE.md"],
      agent: "claude",
      acceptBlockingRules: true,
    });

    expect(compiled.rules.map((rule) => rule.type)).toEqual([
      "advisory",
      "advisory",
      "advisory",
      "advisory",
      "advisory",
      "advisory",
      "advisory",
      "advisory",
      "advisory",
      "advisory",
      "advisory",
      "advisory",
    ]);
  });

  it("keeps punctuation-separated compound directives advisory", () => {
    const compiled = compilePolicy({
      directives: [
        {
          text: "All unit tests must pass; verify the build",
          source: { path: "CLAUDE.md", line: 1, scope: "project" },
        },
        {
          text: "Treat warnings as errors. All unit tests must pass.",
          source: { path: "CLAUDE.md", line: 2, scope: "project" },
        },
        {
          text: "All unit tests must pass, verify tests locally",
          source: { path: "CLAUDE.md", line: 3, scope: "project" },
        },
        {
          text: "All unit tests must pass.",
          source: { path: "CLAUDE.md", line: 4, scope: "project" },
        },
      ],
      sources: ["CLAUDE.md"],
      agent: "claude",
      acceptBlockingRules: true,
    });

    expect(compiled.rules.map((rule) => rule.type)).toEqual([
      "advisory",
      "advisory",
      "advisory",
      "require-passing-tests",
    ]);
  });

  it("parses a comment line limit from directive text", () => {
    const compiled = compilePolicy({
      directives: [
        {
          text: "Use a subagent to review code comments longer than one line for slop",
          source: { path: "AGENTS.md", line: 1, scope: "user" },
        },
        {
          text: "Avoid multi-line comments",
          source: { path: "AGENTS.md", line: 2, scope: "user" },
        },
        {
          text: "Never reference tickets in comments",
          source: { path: "AGENTS.md", line: 3, scope: "user" },
        },
      ],
      sources: ["AGENTS.md"],
      agent: "claude",
      acceptBlockingRules: true,
    });

    expect(compiled.rules.map((rule) => rule.type)).toEqual([
      "comment-quality",
      "comment-quality",
      "comment-quality",
    ]);
    expect(
      compiled.rules.map((rule) =>
        rule.type === "comment-quality" ? rule.maxCommentLines : null,
      ),
    ).toEqual([1, 1, undefined]);
  });

  it("rejects invalid policy regular expressions", () => {
    const compiled = policy();
    const testRule = compiled.rules.find(
      (rule) => rule.type === "require-passing-tests",
    );
    if (!testRule || testRule.type !== "require-passing-tests") {
      throw new Error("test rule missing");
    }
    testRule.commandPatterns = ["["];

    expect(() => policySchema.parse(compiled)).toThrow(
      "must be a valid regular expression",
    );
  });
});

describe("starter policy enforcement", () => {
  it("records command identity before execution without storing raw input", () => {
    const receipts = deriveReceipts(
      policy(),
      hookEvent("pre-tool", {
        toolName: "Bash",
        toolInput: { command: "API_TOKEN=secret npm test" },
      }),
    );

    expect(receipts).toEqual([
      expect.objectContaining({
        kind: "command-start",
        commandFingerprint: expect.stringMatching(/^sha256:/),
      }),
    ]);
    expect(JSON.stringify(receipts)).not.toContain("secret");
  });

  it("blocks a remote test before execution", () => {
    const decision = evaluatePolicy({
      policy: policy(),
      event: hookEvent("pre-tool", {
        toolName: "Bash",
        toolInput: { command: "ssh runner npm test" },
      }),
      receipts: [],
    });

    expect(decision.outcome).toBe("block");
    expect(decision.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ directive: "Use local machines for testing" }),
      ]),
    );
  });

  it("blocks commandless remote test tools", () => {
    const decision = evaluatePolicy({
      policy: policy(),
      event: hookEvent("pre-tool", {
        toolName: "mcp__cloud__run_tests",
        toolInput: { suite: "unit" },
      }),
      receipts: [],
    });

    expect(decision.outcome).toBe("block");
    expect(decision.violations[0]?.directive).toBe(
      "Use local machines for testing",
    );
  });

  it("identifies local tests with a local-testing rule only", () => {
    const localOnlyPolicy = compilePolicy({
      directives: [
        {
          text: "Run tests locally",
          source: { path: "CLAUDE.md", line: 1, scope: "project" },
        },
      ],
      sources: ["CLAUDE.md"],
      agent: "claude",
      acceptBlockingRules: true,
    });
    const localRule = localOnlyPolicy.rules.find(
      (rule) => rule.type === "local-testing",
    );
    if (!localRule || localRule.type !== "local-testing") {
      throw new Error("local-testing rule missing");
    }
    const commandEvent = hookEvent("post-tool", {
      toolName: "Bash",
      toolInput: { command: "npm test" },
      toolOutput: "5 tests passed",
    });
    const receipts = deriveReceipts(localOnlyPolicy, commandEvent);

    expect(receipts[0]).toMatchObject({
      isTest: true,
      testRuleIds: [localRule.id],
      location: "local",
    });
    expect(
      evaluatePolicy({
        policy: localOnlyPolicy,
        event: hookEvent("stop"),
        receipts: [edit(), ...receipts],
        diffStats: { files: 1, added: 1, deleted: 0, complete: true },
      }).outcome,
    ).toBe("allow");
  });

  it("keeps custom test patterns scoped to their matching rules", () => {
    const customPolicy = compilePolicy({
      directives: [
        {
          text: "All unit tests must pass",
          source: { path: "CLAUDE.md", line: 1, scope: "project" },
        },
        {
          text: "Run tests locally",
          source: { path: "CLAUDE.md", line: 2, scope: "project" },
        },
      ],
      sources: ["CLAUDE.md"],
      agent: "claude",
      acceptBlockingRules: true,
    });
    const passingRule = customPolicy.rules.find(
      (rule) => rule.type === "require-passing-tests",
    );
    const localRule = customPolicy.rules.find(
      (rule) => rule.type === "local-testing",
    );
    if (
      !passingRule ||
      passingRule.type !== "require-passing-tests" ||
      !localRule ||
      localRule.type !== "local-testing"
    ) {
      throw new Error("test rules missing");
    }
    passingRule.commandPatterns = [String.raw`\bvitest\b`];
    localRule.testCommandPatterns = [String.raw`\bnpm\s+test\b`];

    const receipts = deriveReceipts(
      customPolicy,
      hookEvent("post-tool", {
        toolName: "Bash",
        toolInput: { command: "npm test" },
        toolOutput: "5 tests passed",
      }),
    );
    const decision = evaluatePolicy({
      policy: customPolicy,
      event: hookEvent("stop"),
      receipts: [edit(), ...receipts],
      diffStats: { files: 1, added: 1, deleted: 0, complete: true },
    });

    expect(receipts[0]?.testRuleIds).toEqual([localRule.id]);
    expect(decision.violations).toEqual([
      expect.objectContaining({ ruleId: passingRule.id }),
    ]);
  });

  it("blocks completion when tests fail after an edit", () => {
    const decision = evaluatePolicy({
      policy: policy(),
      event: hookEvent("stop"),
      receipts: [edit(), verification({ success: false })],
      diffStats: { files: 1, added: 4, deleted: 0, complete: true },
    });

    expect(decision.outcome).toBe("block");
    expect(decision.violations.map((item) => item.directive)).toContain(
      "All unit tests must pass",
    );
  });

  it("allows completion with fresh, local, warning-free verification", () => {
    const decision = evaluatePolicy({
      policy: policy(),
      event: hookEvent("stop"),
      receipts: [edit(), verification()],
      diffStats: { files: 1, added: 4, deleted: 0, complete: true },
    });

    expect(decision.outcome).toBe("allow");
    expect(decision.violations).toEqual([]);
    expect(decision.summary).toContain("verification passed");
  });

  it("treats warning output as a violation", () => {
    const activePolicy = policy();
    const event = hookEvent("post-tool", {
      toolName: "Bash",
      toolInput: { command: "npm test" },
      toolOutput: "warning: deprecated option\n12 tests passed",
    });
    const receipts = deriveReceipts(activePolicy, event);
    const decision = evaluatePolicy({
      policy: activePolicy,
      event,
      receipts,
    });

    expect(receipts[0]?.warningCount).toBe(1);
    expect(decision.outcome).toBe("block");
    expect(decision.violations[0]?.directive).toBe(
      "Treat warnings as errors",
    );
  });

  it.each([
    ["numeric exit code", { exitCode: 1 }],
    ["string exit status", { exit_status: "2" }],
    ["nested failed result", { result: { success: false } }],
    ["JSON-stringified failure", JSON.stringify({ exit_code: 3 })],
    [
      "deeply wrapped failure",
      { data: { content: [{ text: "Process exited with code 4" }] } },
    ],
    [
      "nested structural failure under outer success",
      { exitCode: 0, result: { isError: true } },
    ],
  ])("records a post-tool command with %s as failed", (_label, toolOutput) => {
    const activePolicy = policy();
    const receipts = deriveReceipts(
      activePolicy,
      hookEvent("post-tool", {
        toolName: "Bash",
        toolInput: { command: "npm test" },
        toolOutput,
      }),
    );

    expect(receipts[0]).toMatchObject({
      kind: "command",
      isTest: true,
      success: false,
    });
  });

  it("trusts an explicit zero exit code over incidental output text", () => {
    const receipts = deriveReceipts(
      policy(),
      hookEvent("post-tool", {
        toolName: "Bash",
        toolInput: { command: "npm test" },
        toolOutput: {
          exitCode: 0,
          stdout: 'fixture text: {"code": 200}, process exited with code 1',
        },
      }),
    );

    expect(receipts[0]?.success).toBe(true);
  });

  it("does not count an explicit zero-warning summary", () => {
    const activePolicy = policy();
    const event = hookEvent("post-tool", {
      toolName: "Bash",
      toolInput: { command: "npm test" },
      toolOutput:
        "12 tests passed, 0 warnings\ninferred rules: warning-only\nTreat warnings as errors",
    });

    expect(deriveReceipts(activePolicy, event)[0]?.warningCount).toBe(0);
  });

  it("parses Cursor's JSON-stringified tool output before warning checks", () => {
    const activePolicy = policy();
    const clean = hookEvent("post-tool", {
      agent: "cursor",
      toolName: "Shell",
      toolInput: { command: "npm test" },
      toolOutput: JSON.stringify({
        exitCode: 0,
        stdout: "12 tests passed, 0 warnings",
        stderr: "",
      }),
    });
    const warning = hookEvent("post-tool", {
      agent: "cursor",
      toolName: "Shell",
      toolInput: { command: "npm test" },
      toolOutput: JSON.stringify({
        exitCode: 0,
        stdout: "12 tests passed",
        stderr: "warning: deprecated API",
      }),
    });

    expect(deriveReceipts(activePolicy, clean)[0]?.warningCount).toBe(0);
    expect(deriveReceipts(activePolicy, warning)[0]?.warningCount).toBe(1);
  });

  it("recognizes tests nested inside an aggregate verification script", () => {
    const activePolicy = policy();
    const event = hookEvent("post-tool", {
      toolName: "Shell",
      toolInput: { command: "npm run check" },
      toolOutput:
        "typecheck passed\nTest Files 7 passed (7)\nTests 31 passed (31)",
    });

    expect(deriveReceipts(activePolicy, event)[0]).toMatchObject({
      success: true,
      isTest: true,
      isVerification: true,
      location: "local",
    });
  });

  it("warns when the working diff exceeds the blast-radius threshold", () => {
    const activePolicy = policy();
    const blastRule = activePolicy.rules.find(
      (rule) => rule.type === "blast-radius",
    );
    if (!blastRule || blastRule.type !== "blast-radius") {
      throw new Error("blast-radius rule missing");
    }

    const decision = evaluatePolicy({
      policy: activePolicy,
      event: hookEvent("stop"),
      receipts: [edit(), verification()],
      diffStats: {
        files: blastRule.maxFiles + 1,
        added: blastRule.maxChangedLines + 1,
        deleted: 0,
        complete: true,
      },
    });

    expect(decision.outcome).toBe("warn");
    expect(decision.violations[0]?.directive).toContain("blast radius");
  });

  it("blocks when a blocking blast-radius rule has an incomplete line count", () => {
    const activePolicy = policy();
    const blastRule = activePolicy.rules.find(
      (rule) => rule.type === "blast-radius",
    );
    if (!blastRule || blastRule.type !== "blast-radius") {
      throw new Error("blast-radius rule missing");
    }
    blastRule.mode = "block";
    blastRule.confirmed = true;

    const decision = evaluatePolicy({
      policy: activePolicy,
      event: hookEvent("stop"),
      receipts: [edit(), verification()],
      diffStats: {
        files: 1,
        added: 0,
        deleted: 0,
        complete: false,
      },
    });

    expect(decision.outcome).toBe("block");
    expect(decision.violations[0]?.evidence).toContain(
      "could not determine a complete line count",
    );
  });

  it("does not repeat an explained blast-radius warning for an unchanged diff", () => {
    const activePolicy = policy();
    const blastRule = activePolicy.rules.find(
      (rule) => rule.type === "blast-radius",
    );
    if (!blastRule || blastRule.type !== "blast-radius") {
      throw new Error("blast-radius rule missing");
    }
    const diffStats = {
      files: blastRule.maxFiles + 1,
      added: blastRule.maxChangedLines + 1,
      deleted: 0,
      complete: true,
    };
    const receipts: Receipt[] = [
      edit(),
      verification(),
      {
        version: 1,
        id: "blast-decision",
        timestamp: "2026-01-01T00:00:03.000Z",
        sessionId: "session-1",
        kind: "decision",
        outcome: "warn",
        ruleIds: [blastRule.id],
      },
    ];
    const acknowledgement = deriveAcknowledgementReceipts(
      activePolicy,
      hookEvent("agent-response", {
        occurredAt: "2026-01-01T00:00:04.000Z",
        lastAssistantMessage:
          "The larger scope is intentional because this is the initial greenfield implementation.",
      }),
      receipts,
      diffStats,
    );

    expect(acknowledgement).toHaveLength(1);
    expect(acknowledgement[0]).toMatchObject({
      kind: "acknowledgement",
      ruleIds: [blastRule.id],
      diffFiles: diffStats.files,
      diffChangedLines: diffStats.added,
    });
    const decision = evaluatePolicy({
      policy: activePolicy,
      event: hookEvent("stop", {
        occurredAt: "2026-01-01T00:00:05.000Z",
      }),
      receipts: [...receipts, ...acknowledgement],
      diffStats,
    });
    expect(decision.outcome).toBe("allow");
  });

  it("requires verification newer than the latest edit", () => {
    const decision = evaluatePolicy({
      policy: policy(),
      event: hookEvent("stop"),
      receipts: [
        verification({}, "2026-01-01T00:00:01.000Z"),
        edit("2026-01-01T00:00:02.000Z"),
      ],
      diffStats: { files: 1, added: 4, deleted: 0, complete: true },
    });

    expect(decision.outcome).toBe("block");
    expect(decision.violations.map((item) => item.directive)).toContain(
      "Verify, don't assume",
    );
  });

  it("requires verification from the current working-tree state", () => {
    const stale = evaluatePolicy({
      policy: policy(),
      event: hookEvent("stop"),
      receipts: [
        verification({
          stateFingerprint: "sha256:1111111111111111",
        }),
      ],
      diffStats: {
        files: 0,
        added: 0,
        deleted: 0,
        complete: false,
        fingerprint: "sha256:2222222222222222",
      },
    });
    const current = evaluatePolicy({
      policy: policy(),
      event: hookEvent("stop"),
      receipts: [
        verification({
          stateBeforeFingerprint: "sha256:2222222222222222",
          stateFingerprint: "sha256:2222222222222222",
        }),
      ],
      diffStats: {
        files: 1,
        added: 2,
        deleted: 0,
        complete: true,
        fingerprint: "sha256:2222222222222222",
      },
    });
    const mutatedDuringVerification = evaluatePolicy({
      policy: policy(),
      event: hookEvent("stop"),
      receipts: [
        verification({
          stateBeforeFingerprint: "sha256:1111111111111111",
          stateFingerprint: "sha256:2222222222222222",
        }),
      ],
      diffStats: {
        files: 0,
        added: 0,
        deleted: 0,
        complete: false,
        fingerprint: "sha256:2222222222222222",
      },
    });
    const unmatchedCompletion = evaluatePolicy({
      policy: policy(),
      event: hookEvent("stop"),
      receipts: [
        verification({
          stateFingerprint: "sha256:2222222222222222",
        }),
      ],
      diffStats: {
        files: 1,
        added: 1,
        deleted: 0,
        complete: true,
        fingerprint: "sha256:2222222222222222",
      },
    });

    expect(stale.outcome).toBe("block");
    expect(stale.violations.map((item) => item.directive)).toContain(
      "All unit tests must pass",
    );
    expect(current.outcome).toBe("allow");
    expect(mutatedDuringVerification.outcome).toBe("block");
    expect(unmatchedCompletion.outcome).toBe("block");
  });

  it("requires tests when the working diff changed outside an edit tool", () => {
    const decision = evaluatePolicy({
      policy: policy(),
      event: hookEvent("stop"),
      receipts: [],
      diffStats: { files: 1, added: 2, deleted: 0, complete: true },
    });

    expect(decision.outcome).toBe("block");
    expect(decision.violations.map((item) => item.directive)).toContain(
      "All unit tests must pass",
    );
  });

  it("rejects a failed verification that follows a passing test", () => {
    const decision = evaluatePolicy({
      policy: policy(),
      event: hookEvent("stop"),
      receipts: [
        edit(),
        verification({}, "2026-01-01T00:00:02.000Z"),
        verification(
          {
            id: "failed-lint",
            command: "npm run lint",
            success: false,
            isTest: false,
            isVerification: true,
          },
          "2026-01-01T00:00:03.000Z",
        ),
      ],
      diffStats: { files: 1, added: 4, deleted: 0, complete: true },
    });

    expect(decision.outcome).toBe("warn");
    expect(decision.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          directive: "Verify, don't assume",
          evidence: "The latest check failed.",
        }),
      ]),
    );
  });

  it("ignores warning text from non-verification commands", () => {
    const activePolicy = policy();
    const event = hookEvent("post-tool", {
      toolName: "Bash",
      toolInput: { command: "git log --grep warning" },
      toolOutput: "warning cleanup commit",
    });
    const receipts = deriveReceipts(activePolicy, event);
    const decision = evaluatePolicy({
      policy: activePolicy,
      event,
      receipts,
    });

    expect(receipts[0]?.warningCount).toBe(0);
    expect(receipts[0]?.isVerification).toBe(false);
    expect(decision.outcome).toBe("allow");
  });

  it("stores only opaque command and MCP tool identities", () => {
    const activePolicy = policy();
    const commandEvent = hookEvent("post-tool", {
      toolName: "Bash",
      toolInput: {
        command:
          "API_TOKEN=secret npm test -- --header 'Authorization: Bearer hidden'",
      },
      toolOutput: "12 tests passed",
    });
    const commandReceipts = deriveReceipts(activePolicy, commandEvent);
    expect(commandReceipts[0]?.command).toBeUndefined();
    expect(commandReceipts[0]?.commandFingerprint).toMatch(/^sha256:/);
    expect(JSON.stringify(commandReceipts)).not.toContain("secret");
    expect(JSON.stringify(commandReceipts)).not.toContain("hidden");

    const mcpStart = deriveReceipts(
      activePolicy,
      hookEvent("pre-tool", {
        toolName: "mcp__filesystem__write_file",
        toolCallId: "mcp-call-1",
        toolInput: { path: "secret.txt", content: "private" },
      }),
    );
    const mcpWrite = deriveReceipts(
      activePolicy,
      hookEvent("post-tool", {
        toolName: "mcp__filesystem__write_file",
        toolCallId: "mcp-call-1",
        toolInput: { path: "secret.txt", content: "private" },
        toolOutput: "ok",
      }),
    );
    expect(mcpStart[0]).toMatchObject({
      kind: "tool-start",
      toolCallId: "mcp-call-1",
    });
    expect(mcpWrite[0]).toMatchObject({
      kind: "tool",
      toolCallId: "mcp-call-1",
      success: true,
    });
    expect(JSON.stringify([...mcpStart, ...mcpWrite])).not.toContain(
      "private",
    );
  });

  it("treats a commandless MCP state change as unverified work", () => {
    const decision = evaluatePolicy({
      policy: policy(),
      event: hookEvent("stop"),
      receipts: [
        {
          version: 1,
          id: "mcp-write",
          timestamp: "2026-01-01T00:00:02.000Z",
          sessionId: "session-1",
          kind: "tool",
          toolName: "mcp__filesystem__write_file",
          success: true,
          stateBeforeFingerprint: "sha256:1111111111111111",
          stateFingerprint: "sha256:2222222222222222",
        },
      ],
      diffStats: {
        files: 0,
        added: 0,
        deleted: 0,
        complete: false,
        fingerprint: "sha256:2222222222222222",
      },
    });

    expect(decision.outcome).toBe("block");
    expect(decision.violations.map((item) => item.directive)).toContain(
      "All unit tests must pass",
    );
  });

  it("flags comments that leak transient agent context", () => {
    const activePolicy = policy();
    const event = hookEvent("post-tool", {
      toolName: "Edit",
      toolInput: {
        file_path: "src/example.ts",
        new_string:
          "// Per the AGENTS.md instructions and APP-421, keep this workaround.",
      },
      toolOutput: "updated",
    });
    const receipts = deriveReceipts(activePolicy, event);
    const decision = evaluatePolicy({
      policy: activePolicy,
      event,
      receipts,
    });

    expect(decision.outcome).toBe("warn");
    expect(decision.violations).toEqual([
      expect.objectContaining({
        directive: expect.stringContaining("Do not add comments"),
        evidence: expect.stringContaining("1 new code comment"),
      }),
    ]);
    expect(JSON.stringify(receipts)).not.toContain("APP-421");
    expect(JSON.stringify(receipts)).not.toContain("AGENTS.md");
  });

  it("flags comment blocks longer than the configured line limit", () => {
    const limitedPolicy = compilePolicy({
      directives: [
        {
          text: "Use a subagent to review code comments longer than one line for slop",
          source: { path: "AGENTS.md", line: 1, scope: "user" },
        },
      ],
      sources: ["AGENTS.md"],
      agent: "claude",
      acceptBlockingRules: true,
    });
    const longComment = hookEvent("post-tool", {
      toolName: "Edit",
      toolInput: {
        file_path: "src/example.ts",
        new_string:
          "// Retries are capped at three attempts.\n// Anything beyond that saturates the pool.\nexport const retries = 3;",
      },
    });
    const shortComment = hookEvent("post-tool", {
      toolName: "Edit",
      toolInput: {
        file_path: "src/example.ts",
        new_string: "// Retries are capped at three attempts.\nexport const retries = 3;",
      },
    });

    const flagged = evaluatePolicy({
      policy: limitedPolicy,
      event: longComment,
      receipts: [],
    });
    expect(flagged.outcome).toBe("warn");
    expect(flagged.violations[0]?.evidence).toContain(
      "runs longer than 1 line",
    );
    expect(flagged.violations[0]?.directive).toContain("subagent");

    expect(
      evaluatePolicy({
        policy: limitedPolicy,
        event: shortComment,
        receipts: [],
      }).outcome,
    ).toBe("allow");
  });

  it("explains how to recover from every comment-quality violation", () => {
    const limitedPolicy = compilePolicy({
      directives: [
        {
          text: "Code comments longer than one line are not allowed",
          source: { path: "AGENTS.md", line: 1, scope: "user" },
        },
      ],
      sources: ["AGENTS.md"],
      agent: "claude",
      acceptBlockingRules: true,
    });
    const event = hookEvent("post-tool", {
      toolName: "Edit",
      toolInput: {
        file_path: "src/example.ts",
        new_string:
          "// Per the prompt, retries are capped.\n// Higher values saturate the pool.",
      },
    });

    const decision = evaluatePolicy({
      policy: limitedPolicy,
      event,
      receipts: [],
    });
    const violation = decision.violations[0];

    expect(violation?.evidence).toContain(
      "mentions temporary agent context",
    );
    expect(violation?.evidence).toContain("runs longer than 1 line");
    expect(violation?.recovery).toContain("Remove temporary agent context");
    expect(violation?.recovery).toContain("at most 1 line");
  });

  it.each([
    ["named", "@@ first function", "@@ second function"],
    ["numeric", "@@ -1,2 +4,3 @@ first", "@@ -40,2 +54,3 @@ second"],
  ])(
    "keeps comments in separate %s patch hunks",
    (_kind, firstHunk, secondHunk) => {
      const event = hookEvent("post-tool", {
        toolName: "apply_patch",
        toolInput: {
          command: [
            "*** Begin Patch",
            "*** Update File: src/example.ts",
            firstHunk,
            "+/**",
            "+ * First function.",
            "+ */",
            secondHunk,
            "+/**",
            "+ * Second function.",
            "+ */",
            "*** End Patch",
          ].join("\n"),
        },
      });
      const blocks = extractAddedCommentBlocks(event);
      const limitedPolicy = compilePolicy({
        directives: [
          {
            text: "Code comments longer than three lines are not allowed",
            source: { path: "AGENTS.md", line: 1, scope: "user" },
          },
        ],
        sources: ["AGENTS.md"],
        agent: "claude",
        acceptBlockingRules: true,
      });

      expect(blocks.map((block) => block.length)).toEqual([3, 3]);
      expect(
        evaluatePolicy({
          policy: limitedPolicy,
          event,
          receipts: [],
        }).outcome,
      ).toBe("allow");
    },
  );

  it("keeps context-separated comments in one patch hunk separate", () => {
    const event = hookEvent("post-tool", {
      toolName: "apply_patch",
      toolInput: {
        command: [
          "*** Begin Patch",
          "*** Update File: src/example.ts",
          "@@",
          "+// First function.",
          " export function first() {}",
          "+// Second function.",
          "*** End Patch",
        ].join("\n"),
      },
    });

    expect(extractAddedCommentBlocks(event)).toEqual([
      ["First function."],
      ["Second function."],
    ]);
  });

  it("keeps comments in separate patch files separate", () => {
    const event = hookEvent("post-tool", {
      toolName: "apply_patch",
      toolInput: {
        command: [
          "*** Begin Patch",
          "*** Update File: src/first.ts",
          "@@",
          "+// First file.",
          "*** Update File: src/second.ts",
          "@@",
          "+// Second file.",
          "*** End Patch",
        ].join("\n"),
      },
    });

    expect(extractAddedCommentBlocks(event)).toEqual([
      ["First file."],
      ["Second file."],
    ]);
  });

  it("allows durable comments and ignores documentation files", () => {
    const activePolicy = policy();
    const durable = hookEvent("post-tool", {
      toolName: "Edit",
      toolInput: {
        file_path: "src/example.ts",
        new_string:
          "// Retries are capped to avoid saturating the upstream connection pool.",
      },
    });
    const documentation = hookEvent("post-tool", {
      toolName: "Edit",
      toolInput: {
        file_path: "README.md",
        new_string: "# Agent instructions",
      },
    });

    expect(
      evaluatePolicy({
        policy: activePolicy,
        event: durable,
        receipts: deriveReceipts(activePolicy, durable),
      }).outcome,
    ).toBe("allow");
    expect(
      evaluatePolicy({
        policy: activePolicy,
        event: documentation,
        receipts: deriveReceipts(activePolicy, documentation),
      }).outcome,
    ).toBe("allow");
  });
});
