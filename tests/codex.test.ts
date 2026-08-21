import { describe, expect, it } from "vitest";
import {
  formatCodexOutput,
  normalizeCodexEvent,
} from "../src/adapters/codex.js";
import type { PolicyDecision } from "../src/core/schema.js";
import {
  CODEX_HOOK_COMMAND,
  mergeCodexHooks,
} from "../src/install/codex.js";

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

describe("native Codex integration", () => {
  it("normalizes and denies a PreToolUse event", () => {
    const event = normalizeCodexEvent({
      hook_event_name: "PreToolUse",
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: "/tmp/project",
      tool_name: "Bash",
      tool_input: { command: "ssh runner npm test" },
    });

    expect(event).toMatchObject({
      agent: "codex",
      stage: "pre-tool",
      sessionId: "session-1",
      toolName: "Bash",
    });
    expect(formatCodexOutput(event, blocked)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });
  });

  it("recognizes failed Bash responses from PostToolUse", () => {
    const event = normalizeCodexEvent({
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      cwd: "/tmp/project",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "Process exited with code 1\nTests failed",
    });

    expect(event.stage).toBe("post-tool-failure");
    expect(event.error).toContain("non-zero exit");
  });

  it("merges project hooks without replacing unrelated configuration", () => {
    const existing = {
      description: "Existing hooks",
      hooks: {
        PreToolUse: [
          {
            matcher: "WebSearch",
            hooks: [{ type: "command", command: "./existing.sh" }],
          },
        ],
      },
    };
    const first = mergeCodexHooks(existing);
    const second = mergeCodexHooks(first.settings);

    expect(first.changedEvents).toHaveLength(4);
    expect(second.changedEvents).toHaveLength(0);
    const preToolHooks = (
      first.settings.hooks as Record<string, Array<Record<string, unknown>>>
    ).PreToolUse;
    expect(preToolHooks).toHaveLength(2);
    const handlers = preToolHooks?.[1]?.hooks as
      | Array<Record<string, unknown>>
      | undefined;
    expect(handlers?.[0]?.command).toBe(CODEX_HOOK_COMMAND);
    expect(first.settings.description).toBe("Existing hooks");
  });
});
