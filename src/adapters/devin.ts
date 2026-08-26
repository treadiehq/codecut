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
    throw new Error("Devin hook input must be a JSON object.");
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

function stageForEvent(
  eventName: string,
  toolOutput: unknown,
): NormalizedHookEvent["stage"] {
  switch (eventName.toLowerCase()) {
    case "pretooluse":
      return "pre-tool";
    case "posttooluse":
      return toolOutputFailed(toolOutput) ? "post-tool-failure" : "post-tool";
    case "stop":
      return "stop";
    case "postcompaction":
      return "context-reset";
    default:
      throw new Error(`Unsupported Devin hook event "${eventName}".`);
  }
}

export function normalizeDevinEvent(
  raw: unknown,
  now = new Date(),
  environment: NodeJS.ProcessEnv = process.env,
): NormalizedHookEvent {
  const input = record(raw);
  const eventName = stringValue(input, "hook_event_name", "hookEventName");
  if (!eventName) {
    throw new Error('Devin hook input is missing "hook_event_name".');
  }
  const sessionId = stringValue(input, "session_id", "sessionId");
  if (!sessionId) {
    throw new Error("Devin hook input is missing a stable session identifier.");
  }
  const toolOutput =
    input.tool_response ??
    input.tool_output ??
    input.toolOutput ??
    input.result;

  return normalizedHookEventSchema.parse({
    agent: "devin",
    stage: stageForEvent(eventName, toolOutput),
    sessionId,
    cwd:
      stringValue(input, "cwd", "project_dir", "project_path") ??
      environment.DEVIN_PROJECT_DIR ??
      process.cwd(),
    occurredAt:
      stringValue(input, "timestamp", "occurred_at") ?? now.toISOString(),
    toolName: stringValue(input, "tool_name", "toolName"),
    toolCallId: stringValue(
      input,
      "tool_use_id",
      "tool_call_id",
      "toolCallId",
      "call_id",
    ),
    toolInput: input.tool_input ?? input.toolInput,
    toolOutput,
    error:
      stringValue(input, "error", "error_message") ??
      (toolOutput &&
      typeof toolOutput === "object" &&
      !Array.isArray(toolOutput)
        ? stringValue(toolOutput as JsonRecord, "error")
        : undefined),
    stopHookActive:
      input.stop_hook_active === true || input.stopHookActive === true,
    lastAssistantMessage: stringValue(
      input,
      "last_assistant_message",
      "lastAssistantMessage",
    ),
  });
}

export function formatDevinOutput(
  event: NormalizedHookEvent,
  decision: PolicyDecision,
): JsonRecord {
  if (event.stage === "pre-tool") {
    return decision.outcome === "block"
      ? {
          decision: "block",
          reason: formatViolationMessage(decision),
        }
      : {};
  }

  if (event.stage === "post-tool" || event.stage === "post-tool-failure") {
    return decision.outcome === "allow"
      ? {}
      : {
          hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext: formatViolationMessage(decision),
          },
        };
  }

  if (event.stage === "context-reset") {
    return {};
  }

  if (
    decision.outcome === "block" ||
    (decision.outcome === "warn" && !event.stopHookActive)
  ) {
    return {
      decision: "block",
      reason: formatViolationMessage(decision),
    };
  }

  return {};
}
