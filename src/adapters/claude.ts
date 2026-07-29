import {
  normalizedHookEventSchema,
  type AgentName,
  type NormalizedHookEvent,
  type PolicyDecision,
  type RuleViolation,
} from "../core/schema.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hook input must be a JSON object");
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
    case "pretooluse":
    case "pre-tool-use":
      return "pre-tool";
    case "posttooluse":
    case "post-tool-use":
      return "post-tool";
    case "posttoolusefailure":
    case "post-tool-use-failure":
      return "post-tool-failure";
    case "afteragentresponse":
    case "agent-response":
      return "agent-response";
    case "stop":
      return "stop";
    default:
      throw new Error(`Unsupported hook event "${eventName}".`);
  }
}

export function normalizeClaudeEvent(
  raw: unknown,
  agent: AgentName = "claude",
  now = new Date(),
): NormalizedHookEvent {
  const input = record(raw);
  const eventName = stringValue(input, "hook_event_name", "hookEventName");
  if (!eventName) {
    throw new Error('Hook input is missing "hook_event_name".');
  }

  return normalizedHookEventSchema.parse({
    agent,
    stage: stageForEvent(eventName),
    sessionId:
      stringValue(input, "session_id", "conversation_id", "sessionId") ??
      "unknown-session",
    cwd: stringValue(input, "cwd", "workspace_root") ?? process.cwd(),
    occurredAt:
      stringValue(input, "timestamp", "occurred_at") ?? now.toISOString(),
    toolName: stringValue(input, "tool_name", "toolName"),
    toolInput: input.tool_input ?? input.toolInput,
    toolOutput:
      input.tool_response ??
      input.tool_output ??
      input.toolOutput ??
      input.result,
    error: stringValue(input, "error_message", "error"),
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
      "last_assistant_message",
      "lastAssistantMessage",
      "text",
    ),
  });
}

function sourceLabel(violation: RuleViolation): string {
  const line = violation.source.line ? `:${violation.source.line}` : "";
  return `${violation.source.path}${line}`;
}

export function formatViolationMessage(decision: PolicyDecision): string {
  const testRulePrefixes = [
    "require-passing-tests-",
    "verification-evidence-",
    "local-testing-",
  ];
  const isTestBundle =
    decision.violations.length > 1 &&
    decision.violations.every((item) =>
      testRulePrefixes.some((prefix) => item.ruleId.startsWith(prefix)),
    ) &&
    decision.violations.some((item) =>
      item.ruleId.startsWith("require-passing-tests-"),
    );

  if (isTestBundle) {
    const local = decision.violations.some((item) =>
      item.ruleId.startsWith("local-testing-"),
    );
    return [
      `Codecut needs a passing${local ? " local" : ""} test.`,
      `Run the relevant unit tests${local ? " locally" : ""} and make sure they pass.`,
      "",
      `This clears ${decision.violations.length} rules:`,
      ...decision.violations.map((item) => `- ${item.directive}`),
    ].join("\n");
  }

  const details = decision.violations.map(
    (item, index) => {
      const source =
        item.source.scope === "generated" ? "" : ` (${sourceLabel(item)})`;
      return (
        `${index + 1}. ${item.directive}${source}\n` +
        `   Why: ${item.evidence}\n` +
        `   Fix: ${item.recovery}`
      );
    },
  );
  const issueLabel = decision.violations.length === 1 ? "issue" : "issues";
  return [
    `Codecut found ${decision.violations.length} ${issueLabel}.`,
    ...details,
  ].join("\n");
}

export function formatClaudeOutput(
  event: NormalizedHookEvent,
  decision: PolicyDecision,
): JsonRecord {
  if (event.stage === "pre-tool") {
    if (decision.outcome === "block") {
      return {
        systemMessage: decision.summary,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: formatViolationMessage(decision),
        },
      };
    }
    if (decision.outcome === "warn") {
      return {
        systemMessage: decision.summary,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          additionalContext: formatViolationMessage(decision),
        },
      };
    }
    return {};
  }

  if (event.stage === "post-tool" || event.stage === "post-tool-failure") {
    if (decision.outcome === "allow") {
      return {};
    }
    return {
      systemMessage: decision.summary,
      hookSpecificOutput: {
        hookEventName:
          event.stage === "post-tool"
            ? "PostToolUse"
            : "PostToolUseFailure",
        additionalContext: formatViolationMessage(decision),
      },
    };
  }

  if (event.stage === "agent-response") {
    return {};
  }

  if (decision.outcome === "block") {
    return {
      decision: "block",
      reason: formatViolationMessage(decision),
      systemMessage: decision.summary,
    };
  }

  if (decision.outcome === "warn" && !event.stopHookActive) {
    return {
      systemMessage: decision.summary,
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: formatViolationMessage(decision),
      },
    };
  }

  return {
    systemMessage:
      decision.outcome === "warn"
        ? `${decision.summary}. Codecut already sent this warning, so it will not stop the agent again.`
        : decision.summary,
  };
}
