import {
  formatClaudeOutput,
  normalizeClaudeEvent,
} from "./claude.js";
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

function failedToolResponse(value: unknown): boolean {
  const output = record(value);
  const exitCode = output?.exit_code ?? output?.exitCode ?? output?.code;
  if (typeof exitCode === "number") {
    return exitCode !== 0;
  }
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value ?? "");
  return /(?:process exited with code|exit(?:ed)? code|exit_status)\D*[1-9]\d*/i.test(
    serialized,
  );
}

export function normalizeCodexEvent(
  raw: unknown,
  now = new Date(),
): NormalizedHookEvent {
  const event = normalizeClaudeEvent(raw, "codex", now);
  if (
    event.stage === "post-tool" &&
    failedToolResponse(event.toolOutput)
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
