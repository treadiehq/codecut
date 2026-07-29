import { z } from "zod";

export const agentNameSchema = z.enum([
  "claude",
  "cursor",
  "codex",
  "polytoken",
  "unknown",
]);
export type AgentName = z.infer<typeof agentNameSchema>;

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
  (value) => {
    try {
      new RegExp(value);
      return true;
    } catch {
      return false;
    }
  },
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

const commentQualityRuleSchema = z.object({
  ...ruleBase,
  type: z.literal("comment-quality"),
  filePatterns: z.array(regexPatternSchema).min(1),
  bannedPatterns: z.array(regexPatternSchema).min(1),
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
]);
export type HookStage = z.infer<typeof hookStageSchema>;

export const normalizedHookEventSchema = z.object({
  agent: agentNameSchema,
  stage: hookStageSchema,
  sessionId: z.string().min(1),
  cwd: z.string().min(1),
  occurredAt: z.string().datetime(),
  toolName: z.string().optional(),
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
  kind: z.enum(["edit", "command", "decision", "acknowledgement"]),
  path: z.string().optional(),
  changedLines: z.number().int().nonnegative().optional(),
  command: z.string().optional(),
  commandFingerprint: z.string().regex(/^sha256:[a-f0-9]{12}$/).optional(),
  toolName: z.string().optional(),
  success: z.boolean().optional(),
  isTest: z.boolean().optional(),
  isVerification: z.boolean().optional(),
  location: z.enum(["local", "remote", "unknown"]).optional(),
  warningCount: z.number().int().nonnegative().optional(),
  outcome: z.enum(["allow", "warn", "block"]).optional(),
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
};

export type PolicyDecision = {
  outcome: "allow" | "warn" | "block";
  violations: RuleViolation[];
  summary: string;
};
