import { formatViolationMessage } from "./claude.js";
import { toolOutputFailed } from "../core/events.js";
import {
  normalizedHookEventSchema,
  type NormalizedHookEvent,
  type PolicyDecision,
} from "../core/schema.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenCode hook input must be a JSON object.");
  }
  return value as JsonRecord;
}

function stringValue(input: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function openCodeToolOutputFailed(toolOutput: unknown): boolean {
  if (toolOutput && typeof toolOutput === "object" && !Array.isArray(toolOutput)) {
    const metadata = (toolOutput as JsonRecord).metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      const exit = (metadata as JsonRecord).exit;
      if (typeof exit === "number" && Number.isInteger(exit)) {
        return exit !== 0;
      }
      if ((metadata as JsonRecord).timeout === true) {
        return true;
      }
    }
  }
  return toolOutputFailed(toolOutput);
}

function stageForEvent(
  eventName: string,
  toolOutput: unknown,
): NormalizedHookEvent["stage"] {
  switch (eventName.toLowerCase()) {
    case "tool.execute.before":
      return "pre-tool";
    case "tool.execute.after":
      return openCodeToolOutputFailed(toolOutput)
        ? "post-tool-failure"
        : "post-tool";
    case "session.idle":
      return "stop";
    case "session.compacted":
      return "context-reset";
    default:
      throw new Error(`Unsupported OpenCode plugin event "${eventName}".`);
  }
}

export function openCodeEventName(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return stringValue(raw as JsonRecord, "event", "event_name", "eventName");
}

export function normalizeOpenCodeEvent(
  raw: unknown,
  now = new Date(),
): NormalizedHookEvent {
  const input = record(raw);
  const eventName = openCodeEventName(input);
  if (!eventName) {
    throw new Error('OpenCode hook input is missing an "event" name.');
  }
  const sessionId = stringValue(input, "session_id", "sessionID", "sessionId");
  if (!sessionId) {
    throw new Error(
      "OpenCode hook input is missing a stable session identifier.",
    );
  }
  const toolOutput =
    input.tool_output ?? input.toolOutput ?? input.output ?? input.result;

  return normalizedHookEventSchema.parse({
    agent: "opencode",
    stage: stageForEvent(eventName, toolOutput),
    sessionId,
    cwd:
      stringValue(input, "cwd", "directory", "worktree") ?? process.cwd(),
    occurredAt:
      stringValue(input, "timestamp", "occurred_at") ?? now.toISOString(),
    toolName: stringValue(input, "tool_name", "tool", "toolName"),
    toolCallId: stringValue(
      input,
      "call_id",
      "callID",
      "tool_call_id",
      "toolCallId",
    ),
    toolInput: input.tool_input ?? input.toolInput ?? input.args,
    toolOutput,
    error: stringValue(input, "error", "error_message"),
    stopHookActive:
      input.stop_hook_active === true || input.stopHookActive === true,
    lastAssistantMessage: stringValue(
      input,
      "last_assistant_message",
      "lastAssistantMessage",
    ),
  });
}

export function openCodeProceedOutput(): JsonRecord {
  return { outcome: "allow" };
}

export function formatOpenCodeOutput(
  event: NormalizedHookEvent,
  decision: PolicyDecision,
): JsonRecord {
  const reason =
    decision.outcome === "allow" ? undefined : formatViolationMessage(decision);

  if (event.stage === "pre-tool") {
    return decision.outcome === "block"
      ? { outcome: "deny", reason }
      : {
          outcome: "allow",
          ...(reason ? { reason } : {}),
        };
  }

  if (event.stage === "stop") {
    const shouldContinue =
      decision.outcome === "block" ||
      (decision.outcome === "warn" && !event.stopHookActive);
    return shouldContinue
      ? { outcome: "continue", reason }
      : { outcome: "allow" };
  }

  return {
    outcome: "allow",
    ...(reason ? { reason } : {}),
  };
}
