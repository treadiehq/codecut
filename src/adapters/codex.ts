import {
  formatClaudeOutput,
  normalizeClaudeEvent,
} from "./claude.js";
import { toolOutputFailed } from "../core/events.js";
import type {
  NormalizedHookEvent,
  PolicyDecision,
} from "../core/schema.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function normalizeCodexEvent(
  raw: unknown,
  now = new Date(),
): NormalizedHookEvent {
  const event = normalizeClaudeEvent(raw, "codex", now);
  if (
    event.stage === "post-tool" &&
    toolOutputFailed(event.toolOutput)
  ) {
    return {
      ...event,
      stage: "post-tool-failure",
      error: "Codex tool response reported a non-zero exit status.",
    };
  }
  return event;
}

export function formatCodexOutput(
  event: NormalizedHookEvent,
  decision: PolicyDecision,
): JsonRecord {
  const output = formatClaudeOutput(event, decision);
  const hookSpecificOutput = record(output.hookSpecificOutput);
  if (
    event.stage === "post-tool-failure" &&
    hookSpecificOutput?.hookEventName === "PostToolUseFailure"
  ) {
    hookSpecificOutput.hookEventName = "PostToolUse";
  }
  return output;
}
