import type { SupportedAgentName } from "../core/agents.js";
import type {
  NormalizedHookEvent,
  PolicyDecision,
} from "../core/schema.js";
import {
  formatClaudeOutput,
  normalizeClaudeEvent,
} from "./claude.js";
import {
  formatCodexOutput,
  normalizeCodexEvent,
} from "./codex.js";
import {
  formatCursorOutput,
  normalizeCursorEvent,
} from "./cursor.js";
import {
  formatDevinOutput,
  normalizeDevinEvent,
} from "./devin.js";
import {
  formatOpenCodeOutput,
  normalizeOpenCodeEvent,
  openCodeEventName,
  openCodeProceedOutput,
} from "./opencode.js";
import {
  formatPolytokenOutput,
  normalizePolytokenEvent,
  polytokenEventName,
  polytokenProceedOutput,
} from "./polytoken.js";

type JsonRecord = Record<string, unknown>;

export function nativeEventName(
  agent: SupportedAgentName,
  raw: unknown,
): string | undefined {
  if (agent === "opencode") {
    return openCodeEventName(raw);
  }
  if (agent === "polytoken") {
    return polytokenEventName(raw);
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const input = raw as JsonRecord;
    const value = input.hook_event_name ?? input.hookEventName;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

export function normalizeAgentEvent(
  agent: SupportedAgentName,
  raw: unknown,
): NormalizedHookEvent {
  switch (agent) {
    case "claude":
      return normalizeClaudeEvent(raw, agent);
    case "cursor":
      return normalizeCursorEvent(raw);
    case "codex":
      return normalizeCodexEvent(raw);
    case "devin":
      return normalizeDevinEvent(raw);
    case "opencode":
      return normalizeOpenCodeEvent(raw);
    case "polytoken":
      return normalizePolytokenEvent(raw);
  }
}

export function proceedOutput(
  agent: SupportedAgentName,
  eventName?: string,
): JsonRecord {
  if (agent === "polytoken") {
    return polytokenProceedOutput(eventName);
  }
  if (agent === "opencode") {
    return openCodeProceedOutput();
  }
  return {};
}

export function formatAgentOutput(
  agent: SupportedAgentName,
  event: NormalizedHookEvent,
  decision: PolicyDecision,
): JsonRecord {
  switch (agent) {
    case "claude":
      return formatClaudeOutput(event, decision);
    case "cursor":
      return formatCursorOutput(event, decision);
    case "codex":
      return formatCodexOutput(event, decision);
    case "devin":
      return formatDevinOutput(event, decision);
    case "opencode":
      return formatOpenCodeOutput(event, decision);
    case "polytoken":
      return formatPolytokenOutput(event, decision);
  }
}
