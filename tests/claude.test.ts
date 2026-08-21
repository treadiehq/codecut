import { describe, expect, it } from "vitest";
import {
  formatClaudeOutput,
  normalizeClaudeEvent,
} from "../src/adapters/claude.js";
import type { PolicyDecision } from "../src/core/schema.js";

describe("Claude hook adapter", () => {
  it("normalizes PreToolUse input", () => {
    const event = normalizeClaudeEvent({
      hook_event_name: "PreToolUse",
      session_id: "session-1",
      cwd: "/tmp/project",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(event).toMatchObject({
      agent: "claude",
      stage: "pre-tool",
      sessionId: "session-1",
      toolName: "Bash",
      toolInput: { command: "npm test" },
    });
  });

  it("normalizes SessionStart (clear/compact) as a context reset", () => {
    const event = normalizeClaudeEvent({
      hook_event_name: "SessionStart",
      session_id: "session-1",
      cwd: "/tmp/project",
      source: "clear",
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    expect(event.stage).toBe("context-reset");
  });

  it("returns a deny decision before a blocked tool call", () => {
    const event = normalizeClaudeEvent({
      hook_event_name: "PreToolUse",
      session_id: "session-1",
      cwd: "/tmp/project",
      tool_name: "Bash",
      tool_input: { command: "ssh runner npm test" },
    });
    const decision: PolicyDecision = {
      outcome: "block",
      summary: "one violation",
      violations: [
        {
          ruleId: "local-tests",
          directive: "Use local machines for testing",
          source: { path: "CLAUDE.md", line: 4, scope: "project" },
          severity: "block",
          evidence: "Remote runner selected.",
          recovery: "Run npm test locally.",
        },
      ],
    };

    expect(formatClaudeOutput(event, decision)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
  });

  it("blocks Stop with evidence and recovery", () => {
    const event = normalizeClaudeEvent({
      hook_event_name: "Stop",
      session_id: "session-1",
      cwd: "/tmp/project",
      stop_hook_active: false,
    });
    const decision: PolicyDecision = {
      outcome: "block",
      summary: "tests missing",
      violations: [
        {
          ruleId: "tests",
          directive: "All tests must pass",
          source: { path: "CLAUDE.md", line: 3, scope: "project" },
          severity: "block",
          evidence: "No passing tests.",
          recovery: "Run npm test.",
        },
      ],
    };

    const output = formatClaudeOutput(event, decision);
    expect(output.decision).toBe("block");
    expect(output.reason).toContain("CLAUDE.md:3");
    expect(output.reason).toContain("Run npm test");
  });
});
