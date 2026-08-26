import { z } from "zod";
import { SUPPORTED_AGENT_NAMES } from "./agents.js";
import { compilePattern } from "./patterns.js";

export const LINT_CHECKS = [
  "comment-quality",
  "todo-comments",
  "debug-artifacts",
  "blast-radius",
] as const;
export const lintCheckSchema = z.enum(LINT_CHECKS);
export type LintCheck = z.infer<typeof lintCheckSchema>;

export const agentNameSchema = z.enum([
  ...SUPPORTED_AGENT_NAMES,
  "unknown",
]);
export type AgentName = z.infer<typeof agentNameSchema>;
export type { SupportedAgentName } from "./agents.js";

export const directiveSourceSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  scope: z.enum(["project", "user", "generated"]).default("project"),
  conditional: z.boolean().default(false),
});
export type DirectiveSource = z.infer<typeof directiveSourceSchema>;

export const directiveSchema = z.object({
  text: z.string().min(1),
  source: directiveSourceSchema,
});
export type Directive = z.infer<typeof directiveSchema>;

const ruleBase = {
  id: z.string().min(1),
  directive: z.string().min(1),
  source: directiveSourceSchema,
  mode: z.enum(["warn", "block", "off"]).default("warn"),
  confirmed: z.boolean().default(false),
  enabled: z.boolean().default(true),
};

const regexPatternSchema = z.string().min(1).refine(
  // compilePattern understands the `(?-i)` case-sensitivity prefix that a
  // bare `new RegExp` would reject.
  (value) => compilePattern(value) !== undefined,
  { message: "must be a valid regular expression" },
);

const passingTestsRuleSchema = z.object({
  ...ruleBase,
  type: z.literal("require-passing-tests"),
  commandPatterns: z.array(regexPatternSchema).min(1),
  testOutputPatterns: z.array(regexPatternSchema).default([]),
});

const warningsAsErrorsRuleSchema = z.object({
  ...ruleBase,
  type: z.literal("warnings-as-errors"),
  commandPatterns: z.array(regexPatternSchema).min(1),
  warningPatterns: z.array(regexPatternSchema).min(1),
});

const localTestingRuleSchema = z.object({
  ...ruleBase,
  type: z.literal("local-testing"),
  testCommandPatterns: z.array(regexPatternSchema).min(1),
  remoteCommandPatterns: z.array(regexPatternSchema).min(1),
  remoteToolPatterns: z.array(regexPatternSchema).default([]),
});

const blastRadiusRuleSchema = z.object({
  ...ruleBase,
  type: z.literal("blast-radius"),
  maxFiles: z.number().int().positive().default(12),
  maxChangedLines: z.number().int().positive().default(500),
});

const verificationEvidenceRuleSchema = z.object({
  ...ruleBase,
  type: z.literal("verification-evidence"),
  commandPatterns: z.array(regexPatternSchema).min(1),
});

const readyGithubPrRuleSchema = z.object({
  ...ruleBase,
  type: z.literal("require-ready-github-pr"),
});

const cleanPushRuleSchema = z.object({
  ...ruleBase,
  type: z.literal("require-clean-push"),
  checks: z.array(lintCheckSchema).min(1).default([...LINT_CHECKS]),
});

const commentQualityRuleSchema = z.object({
  ...ruleBase,
  type: z.literal("comment-quality"),
  filePatterns: z.array(regexPatternSchema).min(1),
  bannedPatterns: z.array(regexPatternSchema).min(1),
  maxCommentLines: z.number().int().positive().optional(),
  maxCommentPercentage: z.number().min(0).max(100).optional(),
  minAddedLinesForCommentPercentage: z.number().int().positive().default(20),
});

const metaComplianceRuleSchema = z.object({
  ...ruleBase,
  type: z.literal("meta-compliance"),
});

const advisoryRuleSchema = z.object({
  ...ruleBase,
  type: z.literal("advisory"),
});

export const policyRuleSchema = z.discriminatedUnion("type", [
  passingTestsRuleSchema,
  warningsAsErrorsRuleSchema,
  localTestingRuleSchema,
  blastRadiusRuleSchema,
  verificationEvidenceRuleSchema,
  readyGithubPrRuleSchema,
  cleanPushRuleSchema,
  commentQualityRuleSchema,
  metaComplianceRuleSchema,
  advisoryRuleSchema,
]);
export type PolicyRule = z.infer<typeof policyRuleSchema>;

export const policySchema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  agents: z.array(agentNameSchema).min(1),
  sources: z.array(z.string()),
  rules: z.array(policyRuleSchema),
});
export type Policy = z.infer<typeof policySchema>;

export const hookStageSchema = z.enum([
  "pre-tool",
  "post-tool",
  "post-tool-failure",
  "agent-response",
  "stop",
  // The agent's conversation context was cleared or compacted: prior
  // in-context deliveries (e.g. warnings) may no longer be visible to it.
  "context-reset",
]);
export type HookStage = z.infer<typeof hookStageSchema>;

export const normalizedHookEventSchema = z.object({
  agent: agentNameSchema,
  integrationName: z.string().min(1).max(64).optional(),
  stage: hookStageSchema,
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  occurredAt: z.string().datetime(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  toolInput: z.unknown().optional(),
  toolOutput: z.unknown().optional(),
  error: z.string().optional(),
  stopHookActive: z.boolean().default(false),
  loopCount: z.number().int().nonnegative().default(0),
  lastAssistantMessage: z.string().optional(),
});
export type NormalizedHookEvent = z.infer<typeof normalizedHookEventSchema>;

export const receiptSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  sessionId: z.string().min(1),
  kind: z.enum([
    "edit",
    "tool-start",
    "tool",
    "command-start",
    "command",
    "decision",
    "acknowledgement",
    "context-reset",
  ]),
  path: z.string().optional(),
  changedLines: z.number().int().nonnegative().optional(),
  command: z.string().optional(),
  commandFingerprint: z.string().regex(/^sha256:[a-f0-9]{12}$/).optional(),
  stateFingerprint: z.string().regex(/^sha256:[a-f0-9]{16}$/).optional(),
  stateBeforeFingerprint: z
    .string()
    .regex(/^sha256:[a-f0-9]{16}$/)
    .optional(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  success: z.boolean().optional(),
  isTest: z.boolean().optional(),
  testRuleIds: z.array(z.string()).optional(),
  isVerification: z.boolean().optional(),
  location: z.enum(["local", "remote", "unknown"]).optional(),
  warningCount: z.number().int().nonnegative().optional(),
  outcome: z.enum(["allow", "warn", "block"]).optional(),
  warningDelivered: z.boolean().optional(),
  ruleIds: z.array(z.string()).optional(),
  diffFiles: z.number().int().nonnegative().optional(),
  diffChangedLines: z.number().int().nonnegative().optional(),
});
export type Receipt = z.infer<typeof receiptSchema>;

export type RuleViolation = {
  ruleId: string;
  directive: string;
  source: DirectiveSource;
  severity: "warn" | "block";
  evidence: string;
  recovery: string;
};

export type DiffStats = {
  files: number;
  added: number;
  deleted: number;
  complete: boolean;
  fingerprint?: string;
};

export type PolicyDecision = {
  outcome: "allow" | "warn" | "block";
  violations: RuleViolation[];
  summary: string;
};
