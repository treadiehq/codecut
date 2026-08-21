import { formatViolationMessage } from "./claude.js";
import {
  normalizedHookEventSchema,
  type NormalizedHookEvent,
  type PolicyDecision,
} from "../core/schema.js";

type JsonRecord = Record<string, unknown>;
type Environment = Record<string, string | undefined>;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Polytoken hook input must be a JSON object.");
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

function stageForEvent(eventName: string): NormalizedHookEvent["stage"] {
  switch (eventName.toLowerCase()) {
    case "pre_tool_use":
      return "pre-tool";
    case "post_tool_use":
      return "post-tool";
    case "post_tool_use_failure":
      return "post-tool-failure";
    case "post_model_turn":
      return "agent-response";
    case "stop":
      return "stop";
    default:
      throw new Error(`Unsupported Polytoken hook event "${eventName}".`);
  }
}

export function polytokenEventName(
  raw: unknown,
  environment: Environment = process.env,
): string | undefined {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const input = raw as JsonRecord;
    const eventName = stringValue(
      input,
      "event",
      "event_name",
      "hook_event_name",
    );
    if (eventName) {
      return eventName;
    }
  }
  return environment.POLYTOKEN_HOOK_EVENT;
}

export function normalizePolytokenEvent(
  raw: unknown,
  now = new Date(),
  environment: Environment = process.env,
): NormalizedHookEvent {
  const input = record(raw);
  const eventName = polytokenEventName(input, environment);
  if (!eventName) {
    throw new Error(
      'Polytoken hook input is missing an event name and POLYTOKEN_HOOK_EVENT is not set.',
    );
  }
  const sessionId =
    stringValue(input, "session_id", "sessionId") ??
    environment.POLYTOKEN_SESSION_ID;
  if (!sessionId) {
    throw new Error(
      "Polytoken hook input is missing a stable session identifier.",
    );
  }

  return normalizedHookEventSchema.parse({
    agent: "polytoken",
    stage: stageForEvent(eventName),
    sessionId,
    cwd:
      stringValue(input, "cwd", "project_dir", "project_path") ??
      environment.POLYTOKEN_PROJECT_DIR ??
      environment.POLYTOKEN_PROJECT_PATH ??
      process.cwd(),
    occurredAt:
      stringValue(input, "timestamp", "occurred_at") ?? now.toISOString(),
    toolName:
      stringValue(input, "tool_name", "toolName", "matcher_subject") ??
      environment.POLYTOKEN_HOOK_MATCHER_SUBJECT,
    toolCallId: stringValue(
      input,
      "tool_use_id",
      "tool_call_id",
      "toolCallId",
      "call_id",
    ),
    toolInput: input.input ?? input.tool_input ?? input.toolInput,
    toolOutput:
      input.output ??
      input.result ??
      input.response ??
      input.tool_output ??
      input.toolOutput,
    error: stringValue(input, "error", "error_message", "message"),
    stopHookActive:
      input.stop_hook_active === true || input.stopHookActive === true,
    loopCount:
      typeof input.loop_count === "number"
        ? input.loop_count
        : typeof input.loopCount === "number"
          ? input.loopCount
          : 0,
    lastAssistantMessage: stringValue(
      input,
      "assistant_message",
      "last_assistant_message",
      "model_output",
      "text",
      "output",
    ),
  });
}

export function polytokenProceedOutput(eventName?: string): JsonRecord {
  switch (eventName?.toLowerCase()) {
    case "pre_tool_use":
      return { outcome: "allow" };
    case "stop":
      return { outcome: "stop" };
    default:
      return { outcome: "acknowledged" };
  }
}

export function formatPolytokenOutput(
  event: NormalizedHookEvent,
  decision: PolicyDecision,
): JsonRecord {
  if (event.stage === "pre-tool") {
    if (decision.outcome === "block") {
      return { outcome: "deny", reason: formatViolationMessage(decision) };
    }
    if (decision.outcome === "warn") {
      return { outcome: "allow", reason: formatViolationMessage(decision) };
    }
    return { outcome: "allow" };
  }

  if (event.stage === "stop") {
    return decision.outcome === "allow" ||
      (decision.outcome === "warn" && event.stopHookActive)
      ? { outcome: "stop" }
      : { outcome: "continue", reason: formatViolationMessage(decision) };
  }

  return { outcome: "acknowledged" };
}
