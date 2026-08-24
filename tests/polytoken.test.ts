import { describe, expect, it } from "vitest";
import {
  formatPolytokenOutput,
  normalizePolytokenEvent,
  polytokenProceedOutput,
} from "../src/adapters/polytoken.js";
import type { PolicyDecision, Receipt } from "../src/core/schema.js";
import {
  mergePolytokenHooks,
  POLYTOKEN_HOOK_COMMAND,
} from "../src/install/polytoken.js";
import { warningAlreadyDelivered } from "../src/commands/hook.js";
import { contextResetReceipt } from "../src/core/events.js";

const blocked: PolicyDecision = {
  outcome: "block",
  summary: "Remote tests are blocked.",
  violations: [
    {
      ruleId: "local-tests",
      directive: "Use local machines for testing",
      source: { path: "AGENTS.md", line: 2, scope: "project" },
      severity: "block",
      evidence: "A remote runner was selected.",
      recovery: "Run tests locally.",
    },
  ],
};
const warning: PolicyDecision = {
  ...blocked,
  outcome: "warn",
  violations: blocked.violations.map((violation) => ({
    ...violation,
    severity: "warn",
  })),
};

describe("native Polytoken integration", () => {
  it("normalizes environment-backed pre-tool events and denies violations", () => {
    const event = normalizePolytokenEvent(
      {
        event: "pre_tool_use",
        matcher_subject: "shell",
        tool_name: "shell",
        input: { command: "ssh runner npm test" },
      },
      new Date("2026-07-29T12:00:00.000Z"),
      {
        POLYTOKEN_SESSION_ID: "session-1",
        POLYTOKEN_PROJECT_DIR: "/tmp/project",
      },
    );

    expect(event).toMatchObject({
      agent: "polytoken",
      stage: "pre-tool",
      sessionId: "session-1",
      cwd: "/tmp/project",
      toolName: "shell",
      toolInput: { command: "ssh runner npm test" },
    });
    expect(formatPolytokenOutput(event, blocked)).toMatchObject({
      outcome: "deny",
      reason: expect.stringContaining("Use local machines for testing"),
    });
  });

  it("surfaces pre-tool warnings while allowing the tool", () => {
    const event = normalizePolytokenEvent(
      {
        event: "pre_tool_use",
        tool_name: "shell",
        input: { command: "ssh runner npm test" },
      },
      new Date("2026-07-29T12:00:00.000Z"),
      {
        POLYTOKEN_SESSION_ID: "session-1",
        POLYTOKEN_PROJECT_DIR: "/tmp/project",
      },
    );

    expect(formatPolytokenOutput(event, warning)).toEqual({
      outcome: "allow",
    });
  });

  it("continues the agent loop when stop checks need recovery", () => {
    const event = normalizePolytokenEvent(
      { event: "stop" },
      new Date(),
      {
        POLYTOKEN_SESSION_ID: "session-1",
        POLYTOKEN_PROJECT_DIR: "/tmp/project",
      },
    );

    expect(formatPolytokenOutput(event, blocked)).toMatchObject({
      outcome: "continue",
      reason: expect.stringContaining("Run tests locally"),
    });
    expect(formatPolytokenOutput(event, warning).outcome).toBe("continue");
    expect(
      formatPolytokenOutput(
        { ...event, stopHookActive: true },
        warning,
      ).outcome,
    ).toBe("stop");
  });

  it("uses valid fail-open outcomes for Polytoken event types", () => {
    expect(polytokenProceedOutput("pre_tool_use")).toEqual({
      outcome: "allow",
    });
    expect(polytokenProceedOutput("stop")).toEqual({ outcome: "stop" });
    expect(polytokenProceedOutput("post_tool_use")).toEqual({
      outcome: "acknowledged",
    });
    // post_clear / post_compaction accept only `allow`.
    expect(polytokenProceedOutput("post_clear")).toEqual({ outcome: "allow" });
    expect(polytokenProceedOutput("post_compaction")).toEqual({
      outcome: "allow",
    });
  });

  it("keeps fail-open output free of unsupported advisory fields", () => {
    for (const eventName of [
      "pre_tool_use",
      "post_tool_use",
      "post_tool_use_failure",
      "post_model_turn",
      "post_clear",
      "post_compaction",
    ]) {
      expect(polytokenProceedOutput(eventName)).not.toHaveProperty("reason");
    }
  });

  it("normalizes context-reset events and always allows them", () => {
    for (const eventName of ["post_clear", "post_compaction"]) {
      const event = normalizePolytokenEvent(
        { event: eventName, session_id: "session-1", cwd: "/tmp/project" },
        new Date("2026-07-29T12:00:00.000Z"),
        {},
      );
      expect(event.stage).toBe("context-reset");
      expect(formatPolytokenOutput(event, warning)).toEqual({
        outcome: "allow",
      });
    }
  });

  it("merges project hooks without replacing unrelated configuration", () => {
    const existing = [
      {
        name: "log-edits",
        event: "post_tool_use",
        matcher: "file_edit_*",
        handler: { bash: "cat >> /tmp/edits.log" },
      },
    ];
    const first = mergePolytokenHooks(existing);
    const second = mergePolytokenHooks(first.settings);

    expect(first.changedEvents).toHaveLength(7);
    expect(second.changedEvents).toHaveLength(0);
    expect(first.settings).toHaveLength(8);
    expect(first.settings[0]).toEqual(existing[0]);
    expect(
      (
        first.settings[1] as {
          handler: { bash: string };
        }
      ).handler.bash,
    ).toBe(POLYTOKEN_HOOK_COMMAND);
  });
});

describe("warning delivery dedup", () => {
  const warnReceipt = (timestamp: string, ruleIds: string[]): Receipt => ({
    version: 1,
    id: "receipt-1",
    timestamp,
    sessionId: "session-1",
    kind: "decision",
    outcome: "warn",
    ruleIds,
  });

  it("suppresses an identical warning for as long as its context survives", () => {
    // No timer: a warning delivered hours ago still suppresses until a
    // context reset says the agent lost it.
    expect(
      warningAlreadyDelivered(
        [warnReceipt("2026-07-29T01:00:00.000Z", ["comment-quality-1"])],
        ["comment-quality-1"],
      ),
    ).toBe(true);
  });

  it("does not suppress warnings for a different rule set", () => {
    expect(
      warningAlreadyDelivered(
        [warnReceipt("2026-07-29T12:00:00.000Z", ["other-rule"])],
        ["comment-quality-1"],
      ),
    ).toBe(false);
  });

  it("re-warns after a context reset", () => {
    const contextReset = (timestamp: string): Receipt => ({
      version: 1,
      id: "receipt-reset",
      timestamp,
      sessionId: "session-1",
      kind: "context-reset",
    });
    const warned = warnReceipt("2026-07-29T11:50:00.000Z", [
      "comment-quality-1",
    ]);

    // A clear/compaction after the warning discards it from the agent's
    // context, so it no longer suppresses.
    expect(
      warningAlreadyDelivered(
        [warned, contextReset("2026-07-29T11:55:00.000Z")],
        ["comment-quality-1"],
      ),
    ).toBe(false);

    // A reset before the warning leaves the delivered warning in context.
    expect(
      warningAlreadyDelivered(
        [contextReset("2026-07-29T11:45:00.000Z"), warned],
        ["comment-quality-1"],
      ),
    ).toBe(true);
  });

  it("uses processing time when an agent sends a stale reset timestamp", () => {
    const processedAt = new Date("2026-07-29T12:00:02.000Z");
    const event = normalizePolytokenEvent(
      {
        event: "post_clear",
        session_id: "session-1",
        cwd: "/tmp/project",
        timestamp: "2026-07-29T12:00:00.500Z",
      },
      processedAt,
      {},
    );
    const reset = contextResetReceipt(event, processedAt);
    const warned = warnReceipt("2026-07-29T12:00:01.000Z", [
      "comment-quality-1",
    ]);

    expect(event.occurredAt).toBe("2026-07-29T12:00:00.500Z");
    expect(reset.timestamp).toBe("2026-07-29T12:00:02.000Z");
    expect(
      warningAlreadyDelivered([warned, reset], ["comment-quality-1"]),
    ).toBe(false);
  });
});
