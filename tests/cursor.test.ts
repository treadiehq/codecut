import { describe, expect, it } from "vitest";
import {
  formatCursorOutput,
  normalizeCursorEvent,
} from "../src/adapters/cursor.js";
import type { PolicyDecision } from "../src/core/schema.js";
import {
  CURSOR_HOOK_COMMAND,
  mergeCursorHooks,
} from "../src/install/cursor.js";

const blocked: PolicyDecision = {
  outcome: "block",
  summary: "remote tests are blocked",
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

const missingLocalTests: PolicyDecision = {
  outcome: "block",
  summary: "7 rules checked · 3 issues · verification needed",
  violations: [
    {
      ruleId: "require-passing-tests-example",
      directive: "All unit tests must pass",
      source: { path: "starter policy", scope: "generated" },
      severity: "block",
      evidence: "No passing test was found after the last change.",
      recovery: "Run the relevant unit tests and make sure they pass.",
    },
    {
      ruleId: "verification-evidence-example",
      directive: "Verify your work",
      source: { path: "starter policy", scope: "generated" },
      severity: "warn",
      evidence: "No successful check was found after the last change.",
      recovery: "Run a check successfully.",
    },
    {
      ruleId: "local-testing-example",
      directive: "Run tests locally",
      source: { path: "starter policy", scope: "generated" },
      severity: "block",
      evidence: "No local test was found after the last change.",
      recovery: "Run the relevant tests locally.",
    },
  ],
};

describe("native Cursor integration", () => {
  it("captures completed agent responses for acknowledgement checks", () => {
    const event = normalizeCursorEvent({
      hook_event_name: "afterAgentResponse",
      conversation_id: "conversation-1",
      workspace_roots: ["/tmp/project"],
      text: "The larger scope is necessary because this is an initial migration.",
    });

    expect(event).toMatchObject({
      stage: "agent-response",
      cwd: "/tmp/project",
      lastAssistantMessage:
        "The larger scope is necessary because this is an initial migration.",
    });
  });

  it("normalizes and denies a preToolUse event", () => {
    const event = normalizeCursorEvent({
      hook_event_name: "preToolUse",
      conversation_id: "conversation-1",
      cwd: "/tmp/project",
      tool_name: "Shell",
      tool_input: { command: "ssh runner npm test" },
    });

    expect(event).toMatchObject({
      agent: "cursor",
      stage: "pre-tool",
      sessionId: "conversation-1",
      toolName: "Shell",
    });
    expect(formatCursorOutput(event, blocked)).toMatchObject({
      permission: "deny",
      user_message: "remote tests are blocked",
    });
  });

  it("returns a stop follow-up so Cursor can recover", () => {
    const event = normalizeCursorEvent({
      hook_event_name: "stop",
      conversation_id: "conversation-1",
      workspace_roots: ["/tmp/project"],
      loop_count: 0,
      status: "completed",
    });

    expect(formatCursorOutput(event, blocked).followup_message).toContain(
      "Run tests locally",
    );
  });

  it("combines related test issues into one clear action", () => {
    const event = normalizeCursorEvent({
      hook_event_name: "stop",
      conversation_id: "conversation-1",
      workspace_roots: ["/tmp/project"],
      loop_count: 0,
      status: "completed",
    });

    expect(formatCursorOutput(event, missingLocalTests).followup_message).toBe(
      [
        "Codecut needs a passing local test.",
        "Run the relevant unit tests locally and make sure they pass.",
        "",
        "This clears 3 rules:",
        "- All unit tests must pass",
        "- Verify your work",
        "- Run tests locally",
      ].join("\n"),
    );
  });

  it("merges native hooks without replacing unrelated configuration", () => {
    const existing = {
      version: 1,
      hooks: {
        preToolUse: [{ command: "./existing.sh", matcher: "Read" }],
        postToolUse: [
          { command: "papercut hook --agent cursor", matcher: "Shell" },
        ],
      },
    };
    const first = mergeCursorHooks(existing);
    const second = mergeCursorHooks(first.settings);

    expect(first.changedEvents).toHaveLength(5);
    expect(second.changedEvents).toHaveLength(0);
    const preToolHooks = (
      first.settings.hooks as Record<string, Array<Record<string, unknown>>>
    ).preToolUse;
    expect(preToolHooks).toHaveLength(2);
    expect(preToolHooks?.[1]?.command).toBe(CURSOR_HOOK_COMMAND);
    expect(
      (first.settings.hooks as Record<string, unknown[]>).afterAgentResponse,
    ).toHaveLength(1);
    expect(JSON.stringify(first.settings)).not.toContain("papercut");
  });
});
