import {
  formatViolationMessage,
  normalizeClaudeEvent,
} from "./claude.js";
import type {
  NormalizedHookEvent,
  PolicyDecision,
} from "../core/schema.js";

type JsonRecord = Record<string, unknown>;

export function normalizeCursorEvent(
  raw: unknown,
  now = new Date(),
): NormalizedHookEvent {
  return normalizeClaudeEvent(raw, "cursor", now);
}

export function formatCursorOutput(
  event: NormalizedHookEvent,
  decision: PolicyDecision,
): JsonRecord {
  const message = formatViolationMessage(decision);

  if (event.stage === "pre-tool") {
    if (decision.outcome === "block") {
      return {
        permission: "deny",
        user_message: decision.summary,
        agent_message: message,
      };
    }
    if (decision.outcome === "warn") {
      return {
        permission: "allow",
        user_message: decision.summary,
        agent_message: message,
      };
    }
    return { permission: "allow" };
  }

  if (event.stage === "post-tool") {
    return decision.outcome === "allow"
      ? {}
      : { additional_context: message };
  }

  if (event.stage === "post-tool-failure") {
    return {};
  }

  if (
    decision.outcome === "block" ||
    (decision.outcome === "warn" && event.loopCount === 0)
  ) {
    return {
      followup_message: message,
    };
  }

  return {};
}
