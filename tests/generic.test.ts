import { describe, expect, it } from "vitest";
import {
  GENERIC_HOOK_PROTOCOL,
  GENERIC_HOOK_PROTOCOL_VERSION,
  formatGenericOutput,
  genericHookErrorOutput,
  genericHookInputSchema,
  genericHookOutputSchema,
  genericHookProtocolDocument,
  genericProceedOutput,
  normalizeGenericEvent,
} from "../src/adapters/generic.js";
import { isHookAgentName, isSupportedAgentName } from "../src/core/agents.js";
import type {
  HookStage,
  PolicyDecision,
  RuleViolation,
} from "../src/core/schema.js";

const baseInput = {
  protocol: GENERIC_HOOK_PROTOCOL,
  version: GENERIC_HOOK_PROTOCOL_VERSION,
  session_id: "custom-session",
  cwd: "/workspace",
} as const;

describe("generic agent hook protocol", () => {
  it("normalizes a versioned tool event without platform assumptions", () => {
    const event = normalizeGenericEvent(
      {
        ...baseInput,
        event: "post-tool",
        agent_name: "internal-agent.v2",
        tool: {
          name: "shell",
          call_id: "call-1",
          input: { command: "npm test" },
          output: { exitCode: 0, stdout: "5 tests passed" },
        },
      },
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(event).toMatchObject({
      agent: "unknown",
      integrationName: "internal-agent.v2",
      stage: "post-tool",
      sessionId: "custom-session",
      cwd: "/workspace",
      occurredAt: "2026-01-01T00:00:00.000Z",
      toolName: "shell",
      toolCallId: "call-1",
      toolInput: { command: "npm test" },
      toolOutput: { exitCode: 0, stdout: "5 tests passed" },
    });
  });

  it("requires tool details for tool lifecycle events", () => {
    expect(() =>
      genericHookInputSchema.parse({
        ...baseInput,
        event: "pre-tool",
      }),
    ).toThrow("Tool lifecycle events require a tool object");
  });

  it("formats stable machine-readable decisions", () => {
    const event = normalizeGenericEvent({
      ...baseInput,
      event: "pre-tool",
      agent_name: "internal-agent",
      tool: {
        name: "shell",
        input: { command: "ssh runner npm test" },
      },
    });
    const output = formatGenericOutput(event, {
      outcome: "block",
      summary: "1 rule checked · 1 issue",
      violations: [
        {
          ruleId: "local-testing-1",
          directive: "Run tests locally",
          source: {
            path: "AGENTS.md",
            line: 4,
            scope: "project",
            conditional: false,
          },
          severity: "block",
          evidence: "This test would run remotely.",
          recovery: "Run the test locally instead.",
        },
      ],
    });

    expect(genericHookOutputSchema.parse(output)).toEqual(
      expect.objectContaining({
        protocol: GENERIC_HOOK_PROTOCOL,
        version: 1,
        agent_name: "internal-agent",
        action: "deny",
        outcome: "block",
        message: expect.stringContaining("Run tests locally"),
        violations: [
          expect.objectContaining({
            recovery: "Run the test locally instead.",
          }),
        ],
      }),
    );
  });

  it("returns protocol-shaped errors for invalid events", () => {
    expect(
      genericHookOutputSchema.parse(genericHookErrorOutput("bad input")),
    ).toEqual(
      expect.objectContaining({
        action: "deny",
        outcome: "block",
        violations: [],
        error: {
          code: "invalid-event",
          message: expect.stringContaining("bad input"),
        },
      }),
    );
  });

  it.each<[HookStage, PolicyDecision["outcome"], boolean, string]>([
    ["pre-tool", "allow", false, "allow"],
    ["pre-tool", "warn", false, "allow"],
    ["pre-tool", "block", false, "deny"],
    ["post-tool", "block", false, "acknowledge"],
    ["post-tool-failure", "block", false, "acknowledge"],
    ["agent-response", "warn", false, "acknowledge"],
    ["context-reset", "warn", false, "acknowledge"],
    ["stop", "allow", false, "stop"],
    ["stop", "block", false, "continue"],
    ["stop", "warn", false, "continue"],
    ["stop", "warn", true, "stop"],
  ])(
    "maps %s with %s (prior warning: %s) to %s",
    (stage, outcome, stopHookActive, expectedAction) => {
      const event = normalizeGenericEvent({
        ...baseInput,
        event: stage,
        ...(stage === "pre-tool" ||
        stage === "post-tool" ||
        stage === "post-tool-failure"
          ? { tool: { name: "shell" } }
          : {}),
      });
      const violation: RuleViolation = {
        ruleId: "sample-rule",
        directive: "Sample rule",
        source: {
          path: "AGENTS.md",
          scope: "project",
          conditional: false,
        },
        severity: outcome === "block" ? "block" : "warn",
        evidence: "Sample evidence.",
        recovery: "Fix the sample.",
      };
      const output = formatGenericOutput(
        { ...event, stopHookActive },
        {
          outcome,
          summary: "Sample decision",
          violations: outcome === "allow" ? [] : [violation],
        },
      );
      expect(output.action).toBe(expectedAction);
    },
  );

  it("makes proceed and error actions stage-aware", () => {
    const stop = normalizeGenericEvent({ ...baseInput, event: "stop" });
    expect(genericProceedOutput(stop)).toMatchObject({
      action: "stop",
      outcome: "allow",
    });
    expect(genericHookErrorOutput("bad input", "stop")).toMatchObject({
      action: "continue",
      outcome: "block",
    });
    expect(genericHookErrorOutput("bad output", "post-tool")).toMatchObject({
      action: "acknowledge",
      outcome: "warn",
    });
  });

  it("publishes separate JSON Schemas for input and output", () => {
    expect(genericHookProtocolDocument).toMatchObject({
      protocol: GENERIC_HOOK_PROTOCOL,
      version: 1,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        required: expect.arrayContaining(["event", "session_id", "cwd"]),
      },
      outputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        required: expect.arrayContaining(["action", "outcome", "violations"]),
      },
    });
  });

  it("keeps generic hook-only rather than installable", () => {
    expect(isHookAgentName("generic")).toBe(true);
    expect(isSupportedAgentName("generic")).toBe(false);
  });
});
