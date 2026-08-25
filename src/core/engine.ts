import {
  extractAddedCommentBlocksByPath,
  extractCommand,
  receiptMatchesDiffState,
} from "./events.js";
import { matchesAny } from "./patterns.js";
import type { AddedCommentBlock } from "./git.js";
import type {
  DiffStats,
  NormalizedHookEvent,
  Policy,
  PolicyDecision,
  PolicyRule,
  Receipt,
  RuleViolation,
} from "./schema.js";

function severity(rule: PolicyRule): "warn" | "block" {
  return rule.mode === "block" && rule.confirmed ? "block" : "warn";
}

function violation(
  rule: PolicyRule,
  evidence: string,
  recovery: string,
): RuleViolation {
  return {
    ruleId: rule.id,
    directive: rule.directive,
    source: rule.source,
    severity: severity(rule),
    evidence,
    recovery,
  };
}

function after(receipt: Receipt, timestamp: string | undefined): boolean {
  return !timestamp || receipt.timestamp >= timestamp;
}

function latest(receipts: Receipt[]): Receipt | undefined {
  return [...receipts].sort((left, right) =>
    right.timestamp.localeCompare(left.timestamp),
  )[0];
}

function matchesTestRule(
  receipt: Receipt,
  rule: Extract<
    PolicyRule,
    { type: "require-passing-tests" | "local-testing" }
  >,
): boolean {
  if (receipt.testRuleIds !== undefined) {
    return receipt.testRuleIds.includes(rule.id);
  }
  const patterns =
    rule.type === "require-passing-tests"
      ? rule.commandPatterns
      : rule.testCommandPatterns;
  return Boolean(receipt.isTest) || matchesAny(receipt.command ?? "", patterns);
}

function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function evaluatePreTool(
  policy: Policy,
  event: NormalizedHookEvent,
): RuleViolation[] {
  const command = extractCommand(event.toolInput) ?? "";
  const toolIntent = `${event.toolName ?? ""} ${
    event.toolInput === undefined ? "" : JSON.stringify(event.toolInput)
  }`;
  const violations: RuleViolation[] = [];

  for (const rule of policy.rules) {
    if (!rule.enabled || rule.mode === "off" || rule.type !== "local-testing") {
      continue;
    }

    const looksLikeTest =
      matchesAny(command, rule.testCommandPatterns) ||
      /(?:^|[^a-z])tests?(?:[^a-z]|$)/i.test(toolIntent);
    const looksRemote =
      matchesAny(command, rule.remoteCommandPatterns) ||
      matchesAny(event.toolName ?? "", rule.remoteToolPatterns);
    if (looksLikeTest && looksRemote) {
      violations.push(
        violation(
          rule,
          `This test would run remotely through ${event.toolName ?? "an unknown tool"}.`,
          "Run the test locally instead.",
        ),
      );
    }
  }

  return violations;
}

function evaluatePostTool(
  policy: Policy,
  event: NormalizedHookEvent,
  receipts: Receipt[],
): RuleViolation[] {
  if (event.stage !== "post-tool") {
    return [];
  }

  const violations: RuleViolation[] = [];
  const currentCommand = latest(
    receipts.filter(
      (receipt) =>
        receipt.kind === "command" &&
        receipt.timestamp === event.occurredAt,
    ),
  );
  if (currentCommand?.warningCount) {
    for (const rule of policy.rules) {
      if (
        !rule.enabled ||
        rule.mode === "off" ||
        rule.type !== "warnings-as-errors" ||
        (!currentCommand.isVerification &&
          !matchesAny(currentCommand.command ?? "", rule.commandPatterns))
      ) {
        continue;
      }
      violations.push(
        violation(
          rule,
          `${countLabel(currentCommand.warningCount, "warning")} found in the check output.`,
          "Fix the warnings, then rerun the same command.",
        ),
      );
    }
  }

  const addedCommentBlocks = extractAddedCommentBlocksByPath(event);
  for (const rule of policy.rules) {
    if (
      !rule.enabled ||
      rule.mode === "off" ||
      rule.type !== "comment-quality"
    ) {
      continue;
    }
    const commentViolation = evaluateCommentQuality(rule, addedCommentBlocks);
    if (commentViolation) {
      violations.push(commentViolation);
    }
  }

  return violations;
}

function evaluateCommentQuality(
  rule: Extract<PolicyRule, { type: "comment-quality" }>,
  blocks: AddedCommentBlock[],
): RuleViolation | undefined {
  const matchingBlocks = blocks.filter((block) =>
    matchesAny(block.path, rule.filePatterns),
  );
  const matches = matchingBlocks.flatMap((block) =>
    block.comments.filter((comment) => matchesAny(comment, rule.bannedPatterns)),
  );
  const longBlocks =
    rule.maxCommentLines === undefined
      ? []
      : matchingBlocks.filter(
          (block) => block.comments.length > rule.maxCommentLines!,
        );
  if (matches.length === 0 && longBlocks.length === 0) {
    return undefined;
  }

  const evidence = [
    matches.length > 0
      ? `${countLabel(matches.length, "new code comment")} mentions temporary agent context.`
      : "",
    longBlocks.length > 0 && rule.maxCommentLines !== undefined
      ? `${countLabel(longBlocks.length, "new code comment")} runs longer than ${countLabel(rule.maxCommentLines, "line")}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  const recovery = [
    matches.length > 0
      ? "Remove temporary agent context; do not mention prompts, instructions, tickets, or temporary files."
      : "",
    longBlocks.length > 0 && rule.maxCommentLines !== undefined
      ? `Run a subagent to review and de-slopify the comment, then shorten it to at most ${countLabel(rule.maxCommentLines, "line")}.`
      : "",
    "Keep only lasting code constraints.",
  ]
    .filter(Boolean)
    .join(" ");
  return violation(rule, evidence, recovery);
}

function evaluateStop(
  policy: Policy,
  receipts: Receipt[],
  diffStats: DiffStats | undefined,
  addedCommentBlocks: AddedCommentBlock[] = [],
): RuleViolation[] {
  const violations: RuleViolation[] = [];
  const edits = receipts.filter((receipt) => receipt.kind === "edit");
  const latestEdit = latest(edits)?.timestamp;
  const workingStateChanged = Boolean(
    diffStats?.fingerprint &&
      receipts.some(
        (receipt) =>
          ((receipt.kind === "command" ||
            receipt.kind === "command-start" ||
            receipt.kind === "tool" ||
            receipt.kind === "tool-start") &&
            receipt.stateFingerprint !== undefined &&
            receipt.stateFingerprint !== diffStats.fingerprint) ||
          ((receipt.kind === "command" || receipt.kind === "tool") &&
            receipt.stateFingerprint !== undefined &&
            receipt.stateBeforeFingerprint === undefined &&
            !diffStats.complete) ||
          ((receipt.kind === "command" || receipt.kind === "tool") &&
            receipt.stateBeforeFingerprint !== undefined &&
            receipt.stateBeforeFingerprint !== diffStats.fingerprint),
      ),
  );
  const hasChanges = Boolean(
    latestEdit ||
      (diffStats && diffStats.files > 0) ||
      workingStateChanged,
  );
  const commandsAfterEdit = receipts.filter(
    (receipt) => receipt.kind === "command" && after(receipt, latestEdit),
  );
  const commandsForCurrentState = diffStats?.fingerprint
    ? commandsAfterEdit.filter(
        (receipt) =>
          receipt.stateFingerprint === diffStats.fingerprint &&
          receipt.stateBeforeFingerprint === receipt.stateFingerprint,
      )
    : commandsAfterEdit;

  for (const rule of policy.rules) {
    if (!rule.enabled || rule.mode === "off") {
      continue;
    }

    if (rule.type === "require-passing-tests" && hasChanges) {
      const latestTest = latest(
        commandsForCurrentState.filter(
          (receipt) => matchesTestRule(receipt, rule),
        ),
      );
      if (!latestTest?.success) {
        violations.push(
          violation(
            rule,
            latestTest
              ? "The latest test failed after the last change."
              : "No passing test was found after the last change.",
            "Run the relevant unit tests and make sure they pass.",
          ),
        );
      }
      continue;
    }

    if (rule.type === "warnings-as-errors" && hasChanges) {
      const latestVerification = latest(
        commandsForCurrentState.filter(
          (receipt) =>
            receipt.isVerification ||
            matchesAny(receipt.command ?? "", rule.commandPatterns),
        ),
      );
      if (
        latestVerification?.success &&
        (latestVerification.warningCount ?? 0) > 0
      ) {
        violations.push(
          violation(
            rule,
            `${countLabel(latestVerification.warningCount ?? 0, "warning")} remain in the latest check output.`,
            "Fix the warnings, then rerun the check.",
          ),
        );
      }
      continue;
    }

    if (rule.type === "local-testing" && hasChanges) {
      const latestTest = latest(
        commandsForCurrentState.filter(
          (receipt) => matchesTestRule(receipt, rule),
        ),
      );
      if (!latestTest || latestTest.location !== "local") {
        violations.push(
          violation(
            rule,
            latestTest
              ? `The latest test ran at ${latestTest.location ?? "an unknown location"}, not locally.`
              : "No local test was found after the last change.",
            "Run the relevant tests locally.",
          ),
        );
      }
      continue;
    }

    if (rule.type === "verification-evidence" && hasChanges) {
      const latestVerification = latest(
        commandsForCurrentState.filter(
          (receipt) =>
            receipt.isVerification ||
            matchesAny(receipt.command ?? "", rule.commandPatterns),
        ),
      );
      if (!latestVerification?.success) {
        violations.push(
          violation(
            rule,
            latestVerification
              ? "The latest check failed."
              : "No successful test, lint, typecheck, or build was found after the last change.",
            "Run a test, lint, typecheck, or build successfully and cite the result.",
          ),
        );
      }
      continue;
    }

    if (rule.type === "comment-quality") {
      const commentViolation = evaluateCommentQuality(rule, addedCommentBlocks);
      if (commentViolation) {
        violations.push(commentViolation);
      }
      continue;
    }

    if (rule.type === "blast-radius" && diffStats) {
      const changedLines = diffStats.added + diffStats.deleted;
      const acknowledged = receipts.some(
        (receipt) =>
          receipt.kind === "acknowledgement" &&
          after(receipt, latestEdit) &&
          receiptMatchesDiffState(receipt, diffStats) &&
          receipt.ruleIds?.includes(rule.id) &&
          receipt.diffFiles === diffStats.files &&
          receipt.diffChangedLines === changedLines,
      );
      if (acknowledged) {
        continue;
      }
      if (
        diffStats.files > rule.maxFiles ||
        changedLines > rule.maxChangedLines ||
        (rule.mode === "block" &&
          diffStats.files > 0 &&
          !diffStats.complete)
      ) {
        violations.push(
          violation(
            rule,
            diffStats.complete
              ? `Current changes span ${countLabel(diffStats.files, "file")} and ${countLabel(changedLines, "line")}.`
              : `Current changes span ${countLabel(diffStats.files, "file")}, but Codecut could not determine a complete line count.`,
            `Reduce the change to at most ${rule.maxFiles} files and ${rule.maxChangedLines} lines, or explain the larger scope in the final response. The explanation applies until the changes change.`,
          ),
        );
      }
    }
  }

  return violations;
}

function summarize(
  policy: Policy,
  receipts: Receipt[],
  diffStats: DiffStats | undefined,
  violations: RuleViolation[],
): string {
  const activeRules = policy.rules.filter(
    (rule) => rule.enabled && rule.mode !== "off",
  );
  const advisoryRules = activeRules.filter(
    (rule) => rule.type === "advisory",
  ).length;
  const edits = receipts.filter((receipt) => receipt.kind === "edit");
  const latestEdit = latest(edits)?.timestamp;
  const hasWorkingDiff = Boolean(diffStats && diffStats.files > 0);
  const latestVerification = latest(
    receipts.filter(
      (receipt) =>
        receipt.kind === "command" &&
        receipt.isVerification &&
        receipt.success &&
        after(receipt, latestEdit),
    ),
  );

  const parts = [
    `${countLabel(activeRules.length, "rule")} checked`,
    violations.length === 0
      ? "no issues"
      : countLabel(violations.length, "issue"),
  ];
  if (latestEdit || hasWorkingDiff) {
    parts.push(latestVerification ? "verification passed" : "verification needed");
  }
  if (advisoryRules > 0) {
    parts.push(`${countLabel(advisoryRules, "rule")} advice-only`);
  }
  if (diffStats) {
    const changedLines = diffStats.added + diffStats.deleted;
    parts.push(
      `${countLabel(diffStats.files, "file")}, ${countLabel(changedLines, "line")} changed${diffStats.complete ? "" : " (partial count)"}`,
    );
  }
  return parts.join(" · ");
}

export function evaluatePolicy(options: {
  policy: Policy;
  event: NormalizedHookEvent;
  receipts: Receipt[];
  diffStats?: DiffStats;
  addedCommentBlocks?: AddedCommentBlock[];
}): PolicyDecision {
  const violations =
    options.event.stage === "pre-tool"
      ? evaluatePreTool(options.policy, options.event)
      : options.event.stage === "stop"
        ? evaluateStop(
            options.policy,
            options.receipts,
            options.diffStats,
            options.addedCommentBlocks,
          )
        : evaluatePostTool(options.policy, options.event, options.receipts);

  const outcome = violations.some((item) => item.severity === "block")
    ? "block"
    : violations.length > 0
      ? "warn"
      : "allow";

  return {
    outcome,
    violations,
    summary: summarize(
      options.policy,
      options.receipts,
      options.diffStats,
      violations,
    ),
  };
}
