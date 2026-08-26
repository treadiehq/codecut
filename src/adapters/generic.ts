import { z } from "zod";
import {
  hookStageSchema,
  normalizedHookEventSchema,
  type HookStage,
  type NormalizedHookEvent,
  type PolicyDecision,
} from "../core/schema.js";
import { formatViolationMessage } from "./claude.js";

export const GENERIC_HOOK_PROTOCOL = "codecut.agent-hook";
export const GENERIC_HOOK_PROTOCOL_VERSION = 1;

const integrationNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

const genericToolSchema = z
  .object({
    name: z.string().min(1),
    call_id: z.string().min(1).optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.string().min(1).optional(),
  })
  .strict();

const genericHookInputBaseSchema = z
  .object({
    protocol: z.literal(GENERIC_HOOK_PROTOCOL),
    version: z.literal(GENERIC_HOOK_PROTOCOL_VERSION),
    event: hookStageSchema,
    session_id: z.string().min(1),
    cwd: z.string().min(1),
    agent_name: integrationNameSchema.optional(),
    tool: genericToolSchema.optional(),
    assistant_message: z.string().min(1).optional(),
  })
  .strict();

export const genericHookInputSchema = genericHookInputBaseSchema.refine(
  (input) =>
    !["pre-tool", "post-tool", "post-tool-failure"].includes(input.event) ||
    input.tool !== undefined,
  {
    message:
      "Tool lifecycle events require a tool object with at least a name.",
    path: ["tool"],
  },
);

const genericViolationSchema = z
  .object({
    directive: z.string().min(1),
    severity: z.enum(["warn", "block"]),
    evidence: z.string().min(1),
    recovery: z.string().min(1),
  })
  .strict();

export const genericHookOutputSchema = z
  .object({
    protocol: z.literal(GENERIC_HOOK_PROTOCOL),
    version: z.literal(GENERIC_HOOK_PROTOCOL_VERSION),
    agent_name: integrationNameSchema.optional(),
    action: z.enum(["allow", "deny", "acknowledge", "continue", "stop"]),
    outcome: z.enum(["allow", "warn", "block"]),
    summary: z.string().min(1),
    message: z.string().min(1).optional(),
    violations: z.array(genericViolationSchema),
    error: z
      .object({
        code: z.literal("invalid-event"),
        message: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export type GenericHookInput = z.infer<typeof genericHookInputSchema>;
export type GenericHookOutput = z.infer<typeof genericHookOutputSchema>;

export const genericHookProtocolDocument = {
  protocol: GENERIC_HOOK_PROTOCOL,
  version: GENERIC_HOOK_PROTOCOL_VERSION,
  inputSchema: {
    ...z.toJSONSchema(genericHookInputBaseSchema, {
      target: "draft-2020-12",
    }),
    title: "Codecut generic agent hook input",
    allOf: [
      {
        if: {
          properties: {
            event: {
              enum: ["pre-tool", "post-tool", "post-tool-failure"],
            },
          },
          required: ["event"],
        },
        then: { required: ["tool"] },
      },
    ],
  },
  outputSchema: {
    ...z.toJSONSchema(genericHookOutputSchema, {
      target: "draft-2020-12",
    }),
    title: "Codecut generic agent hook output",
  },
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function genericEventName(raw: unknown): string | undefined {
  const event = record(raw)?.event;
  return typeof event === "string" ? event : undefined;
}

export function genericHookStage(
  eventName: string | undefined,
): HookStage | undefined {
  const result = hookStageSchema.safeParse(eventName);
  return result.success ? result.data : undefined;
}

export function normalizeGenericEvent(
  raw: unknown,
  now = new Date(),
): NormalizedHookEvent {
  const input = genericHookInputSchema.parse(raw);
  return normalizedHookEventSchema.parse({
    agent: "unknown",
    integrationName: input.agent_name,
    stage: input.event,
    sessionId: input.session_id,
    cwd: input.cwd,
    occurredAt: now.toISOString(),
    toolName: input.tool?.name,
    toolCallId: input.tool?.call_id,
    toolInput: input.tool?.input,
    toolOutput: input.tool?.output,
    error: input.tool?.error,
    stopHookActive: false,
    loopCount: 0,
    lastAssistantMessage: input.assistant_message,
  });
}

function actionFor(
  stage: HookStage | undefined,
  outcome: PolicyDecision["outcome"],
  stopHookActive = false,
): GenericHookOutput["action"] {
  if (stage === "pre-tool") {
    return outcome === "block" ? "deny" : "allow";
  }
  if (
    stage === "post-tool" ||
    stage === "post-tool-failure" ||
    stage === "agent-response" ||
    stage === "context-reset"
  ) {
    return "acknowledge";
  }
  if (stage === "stop") {
    return outcome === "block" || (outcome === "warn" && !stopHookActive)
      ? "continue"
      : "stop";
  }
  return outcome === "block" ? "deny" : "allow";
}

function outputForDecision(
  event: NormalizedHookEvent | undefined,
  decision: PolicyDecision,
): GenericHookOutput {
  return genericHookOutputSchema.parse({
    protocol: GENERIC_HOOK_PROTOCOL,
    version: GENERIC_HOOK_PROTOCOL_VERSION,
    agent_name: event?.integrationName,
    action: actionFor(event?.stage, decision.outcome, event?.stopHookActive),
    outcome: decision.outcome,
    summary: decision.summary,
    ...(decision.outcome === "allow"
      ? {}
      : { message: formatViolationMessage(decision) }),
    violations: decision.violations.map((violation) => ({
      directive: violation.directive,
      severity: violation.severity,
      evidence: violation.evidence,
      recovery: violation.recovery,
    })),
  });
}

export function formatGenericOutput(
  event: NormalizedHookEvent,
  decision: PolicyDecision,
): GenericHookOutput {
  return outputForDecision(event, decision);
}

export function genericProceedOutput(
  event?: NormalizedHookEvent,
): GenericHookOutput {
  return outputForDecision(event, {
    outcome: "allow",
    summary: "No active Codecut rules",
    violations: [],
  });
}

export function genericHookErrorOutput(
  message: string,
  stage?: HookStage,
): GenericHookOutput {
  const detail = `Codecut could not check this event: ${message}`;
  const action = actionFor(stage, "block");
  const outcome =
    action === "acknowledge" ? ("warn" as const) : ("block" as const);
  return genericHookOutputSchema.parse({
    protocol: GENERIC_HOOK_PROTOCOL,
    version: GENERIC_HOOK_PROTOCOL_VERSION,
    action,
    outcome,
    summary: "Codecut could not check this event",
    message: detail,
    violations: [],
    error: {
      code: "invalid-event",
      message: detail,
    },
  });
}
