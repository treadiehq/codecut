import { describe, expect, it } from "vitest";
import {
  formatPolytokenOutput,
  normalizePolytokenEvent,
  polytokenProceedOutput,
} from "../src/adapters/polytoken.js";
import type { PolicyDecision } from "../src/core/schema.js";
import {
  mergePolytokenHooks,
  POLYTOKEN_HOOK_COMMAND,
} from "../src/install/polytoken.js";

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

    expect(first.changedEvents).toHaveLength(5);
    expect(second.changedEvents).toHaveLength(0);
    expect(first.settings).toHaveLength(6);
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
