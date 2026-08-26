import process from "node:process";
import {
  genericHookErrorOutput,
  genericHookStage,
} from "../adapters/generic.js";
import {
  formatAgentOutput,
  nativeEventName,
  normalizeAgentEvent,
  proceedOutput,
} from "../adapters/registry.js";
import { evaluatePolicy } from "../core/engine.js";
import {
  contextResetReceipt,
  decisionReceipt,
  deriveAcknowledgementReceipts,
  deriveReceipts,
  extractCommand,
} from "../core/events.js";
import {
  findGitRoot,
  inspectAddedComments,
  inspectDiff,
  workingTreeFingerprint,
} from "../core/git.js";
import { inspectGithubPullRequest } from "../core/github.js";
import { eventsPath, findProjectRoot } from "../core/project.js";
import {
  inspectOutgoingPush,
  type PushLintEvidence,
} from "../core/push.js";
import type {
  NormalizedHookEvent,
  Policy,
  PolicyRule,
  Receipt,
} from "../core/schema.js";
import type { HookAgentName } from "../core/agents.js";
import {
  loadEnforcementPolicy,
  loadUserPolicy,
  userConfigDirectory,
  userEventsPath,
} from "../core/user.js";
import { appendReceipts, readSessionReceipts } from "../core/store.js";
import { hasProjectHooks } from "../install/user.js";
import { runLintCommand } from "./lint.js";

/**
 * Has an identical warning (same rule set) already been delivered — and is it
 * still in the agent's context? A warning stops counting once the context is
 * cleared or compacted (context-reset receipt, recorded from every supported
 * agent's clear/compaction hook events): sessions outlive their context (a
 * clear keeps the session ID), and a permanently suppressed warning never
 * reaches the post-clear agent.
 */
export function warningAlreadyDelivered(
  receipts: Receipt[],
  ruleIds: string[],
): boolean {
  const sortedRuleIds = JSON.stringify([...ruleIds].sort());
  const lastContextReset = receipts
    .filter((receipt) => receipt.kind === "context-reset")
    .map((receipt) => receipt.timestamp)
    .sort()
    .at(-1);
  return receipts.some(
    (receipt) =>
      receipt.kind === "decision" &&
      receipt.outcome === "warn" &&
      receipt.warningDelivered !== false &&
      JSON.stringify([...(receipt.ruleIds ?? [])].sort()) === sortedRuleIds &&
      (lastContextReset === undefined ||
        receipt.timestamp > lastContextReset),
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isNativeStopEvent(eventName: string | undefined): boolean {
  const normalized = eventName?.toLowerCase();
  return normalized === "stop" || normalized === "session.idle";
}

function hookErrorOutput(
  agent: HookAgentName,
  event: NormalizedHookEvent | undefined,
  nativeEventName: string | undefined,
  message: string,
): Record<string, unknown> {
  if (agent === "generic") {
    return genericHookErrorOutput(
      message,
      event?.stage ?? genericHookStage(nativeEventName),
    );
  }
  const detail = `Codecut could not check this action: ${message}`;
  const recovery =
    "Repair Codecut state, then run `codecut status` and `codecut test`.";
  const stopFailure =
    event === undefined ||
    event.stage === "stop" ||
    isNativeStopEvent(nativeEventName);

  if (agent === "opencode") {
    if (event?.stage === "stop" || isNativeStopEvent(nativeEventName)) {
      return { outcome: "continue", reason: `${detail} ${recovery}` };
    }
    if (
      event?.stage === "post-tool" ||
      event?.stage === "post-tool-failure" ||
      event?.stage === "context-reset" ||
      nativeEventName === "tool.execute.after" ||
      nativeEventName === "session.compacted"
    ) {
      return { outcome: "allow", reason: detail };
    }
    return { outcome: "deny", reason: `${detail} ${recovery}` };
  }

  if (agent === "devin") {
    const reason = `${detail} ${recovery}`;
    if (
      event?.stage === "post-tool" ||
      event?.stage === "post-tool-failure" ||
      nativeEventName?.toLowerCase() === "posttooluse"
    ) {
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: reason,
        },
      };
    }
    if (
      event?.stage === "context-reset" ||
      nativeEventName?.toLowerCase() === "postcompaction"
    ) {
      return {};
    }
    return { decision: "block", reason };
  }

  if (stopFailure) {
    const reason = `${detail} ${recovery}`;
    if (agent === "cursor") {
      return { followup_message: reason };
    }
    if (agent === "polytoken") {
      return { outcome: "continue", reason };
    }
    return {
      decision: "block",
      reason,
      systemMessage: detail,
    };
  }

  if (agent === "polytoken") {
    // Polytoken rejects fields that are not valid for the event's fail-open
    // outcome; in particular, `reason` is not valid with `allow` or
    // `acknowledged`. Keep the fallback strictly protocol-shaped.
    return proceedOutput(agent, nativeEventName);
  }
  return {
    systemMessage: `${detail} This non-stop action was allowed.`,
  };
}

function matchingStartReceipt(
  receipts: Receipt[],
  completed: Receipt,
): Receipt | undefined {
  const command = completed.kind === "command";
  const completedKind = command ? "command" : "tool";
  const startKind = command ? "command-start" : "tool-start";
  const sameInvocation = (receipt: Receipt): boolean => {
    if (completed.toolCallId) {
      return receipt.toolCallId === completed.toolCallId;
    }
    return command
      ? receipt.commandFingerprint === completed.commandFingerprint
      : receipt.toolName === completed.toolName;
  };
  const candidates: Receipt[] = [];
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    const prior = receipts[index];
    if (!prior || !sameInvocation(prior)) {
      continue;
    }
    if (prior.kind === completedKind) {
      break;
    }
    if (prior.kind === startKind) {
      candidates.push(prior);
      if (completed.toolCallId) {
        break;
      }
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

async function inspectPrePushLint(
  policy: Policy,
  event: NormalizedHookEvent,
  cwd: string,
): Promise<PushLintEvidence | undefined> {
  if (event.stage !== "pre-tool") {
    return undefined;
  }
  const rules = policy.rules.filter(
    (
      rule,
    ): rule is Extract<PolicyRule, { type: "require-clean-push" }> =>
      rule.enabled &&
      rule.mode !== "off" &&
      rule.type === "require-clean-push",
  );
  if (rules.length === 0) {
    return undefined;
  }
  const command = extractCommand(event.toolInput);
  if (!command) {
    return undefined;
  }
  const target = await inspectOutgoingPush(command, cwd);
  if (!target || target.status === "unverified") {
    return target;
  }

  const checks = [
    ...new Set(rules.flatMap((rule) => rule.checks)),
  ];
  try {
    const result = await runLintCommand({
      cwd: target.cwd,
      range: target.range,
      checks: checks.join(","),
      timeoutMs: 8_000,
      policy,
    });
    const evidence = {
      branch: target.branch,
      base: target.base,
      range: target.range,
      files: result.files,
    };
    return result.findings.length === 0
      ? { status: "clean", ...evidence }
      : {
          status: "findings",
          ...evidence,
          findings: result.findings.map((finding) => ({
            check: finding.check,
            path: finding.path,
            line: finding.line,
            message: finding.message,
          })),
        };
  } catch {
    return { status: "unverified", reason: "git-error" };
  }
}

export async function runHook(
  agent: HookAgentName,
  options: { userLevel?: boolean } = {},
): Promise<void> {
  let nativeName: string | undefined;
  let event: NormalizedHookEvent | undefined;
  try {
    const rawInput = await readStdin();
    const parsedInput = JSON.parse(rawInput);
    nativeName = nativeEventName(agent, parsedInput);
    event = normalizeAgentEvent(agent, parsedInput);
    const proceed = (): void => {
      process.stdout.write(
        `${JSON.stringify(proceedOutput(agent, nativeName, event))}\n`,
      );
    };

    const projectRoot = await findProjectRoot(event.cwd);
    let policy: Policy;
    let diffRoot: string;
    let eventsFile: string;

    if (projectRoot) {
      if (
        options.userLevel &&
        agent !== "generic" &&
        (await hasProjectHooks(projectRoot, agent, event.stage))
      ) {
        // The project's own hooks enforce here; a user-level hook running
        // too would double every check and receipt.
        proceed();
        return;
      }
      const cursorCompatibilityEvent =
        agent === "claude" &&
        parsedInput &&
        typeof parsedInput === "object" &&
        !Array.isArray(parsedInput) &&
        typeof (parsedInput as Record<string, unknown>).cursor_version ===
          "string";
      if (
        cursorCompatibilityEvent &&
        (await hasProjectHooks(projectRoot, "cursor", event.stage))
      ) {
        process.stdout.write("{}\n");
        return;
      }
      const effectivePolicy = await loadEnforcementPolicy(projectRoot);
      policy = effectivePolicy.policy;
      if (effectivePolicy.warning) {
        process.stderr.write(`${effectivePolicy.warning}\n`);
      }
      diffRoot = projectRoot;
      eventsFile = eventsPath(projectRoot);
    } else {
      const userPolicy = await loadUserPolicy(userConfigDirectory());
      if (!userPolicy || userPolicy.rules.length === 0) {
        proceed();
        return;
      }
      policy = userPolicy;
      diffRoot = (await findGitRoot(event.cwd)) ?? event.cwd;
      eventsFile = userEventsPath(diffRoot);
    }

    if (event.stage === "context-reset") {
      // The agent's context was cleared or compacted: record it so
      // suppressed warnings re-arm (see warningAlreadyDelivered), then
      // acknowledge — these events accept no other outcome.
      await appendReceipts(eventsFile, [contextResetReceipt(event)]);
      proceed();
      return;
    }

    let receipts = await readSessionReceipts(eventsFile, event.sessionId);
    const newReceipts = deriveReceipts(policy, event);
    if (
      newReceipts.some(
        (receipt) =>
          receipt.kind === "command" ||
          receipt.kind === "command-start" ||
          receipt.kind === "tool" ||
          receipt.kind === "tool-start",
      )
    ) {
      const stateFingerprint = await workingTreeFingerprint(diffRoot);
      for (const receipt of newReceipts) {
        if (
          receipt.kind === "command" ||
          receipt.kind === "command-start" ||
          receipt.kind === "tool" ||
          receipt.kind === "tool-start"
        ) {
          receipt.stateFingerprint = stateFingerprint;
        }
        if (receipt.kind === "command" || receipt.kind === "tool") {
          const start = matchingStartReceipt(receipts, receipt);
          if (start) {
            receipt.stateBeforeFingerprint = start.stateFingerprint;
          }
        }
      }
    }
    await appendReceipts(eventsFile, newReceipts);
    receipts = [...receipts, ...newReceipts];
    const inspectReadyPr =
      event.stage === "stop" &&
      policy.rules.some(
        (rule) =>
          rule.enabled &&
          rule.mode !== "off" &&
          rule.type === "require-ready-github-pr",
      );
    const [
      diffStats,
      addedComments,
      githubPrEvidence,
      pushLintEvidence,
    ] = await Promise.all([
      event.stage === "stop" || event.stage === "agent-response"
        ? inspectDiff(diffRoot, receipts)
        : undefined,
      event.stage === "stop"
        ? inspectAddedComments(diffRoot)
        : { blocks: [], stats: [] },
      inspectReadyPr ? inspectGithubPullRequest(diffRoot) : undefined,
      inspectPrePushLint(policy, event, diffRoot),
    ]);
    const acknowledgements = deriveAcknowledgementReceipts(
      policy,
      event,
      receipts,
      diffStats,
    );
    await appendReceipts(eventsFile, acknowledgements);
    receipts = [...receipts, ...acknowledgements];
    if (event.stage === "agent-response") {
      process.stdout.write(
        `${JSON.stringify(proceedOutput(agent, nativeName, event))}\n`,
      );
      return;
    }
    const decision = evaluatePolicy({
      policy,
      event,
      receipts,
      diffStats,
      addedCommentBlocks: addedComments.blocks,
      addedCommentStats: addedComments.stats,
      githubPrEvidence,
      pushLintEvidence,
    });
    const warningAlreadySent =
      decision.outcome === "warn" &&
      warningAlreadyDelivered(
        receipts,
        decision.violations.map((violation) => violation.ruleId),
      );
    const outputEvent =
      (agent === "polytoken" ||
        agent === "opencode" ||
        agent === "devin" ||
        agent === "generic") &&
      warningAlreadySent
        ? { ...event, stopHookActive: true }
        : event;
    const output = formatAgentOutput(agent, outputEvent, decision);
    const warningDelivered =
      decision.outcome === "warn" && agent === "polytoken"
        ? typeof output.reason === "string" && output.reason.trim().length > 0
        : decision.outcome === "warn" && agent === "opencode"
          ? output.outcome === "continue" &&
            typeof output.reason === "string" &&
            output.reason.trim().length > 0
          : decision.outcome === "warn" && agent === "devin"
            ? event.stage === "pre-tool"
              ? false
              : true
            : decision.outcome === "warn" && agent === "generic"
              ? typeof output.message === "string" &&
                output.message.trim().length > 0
              : undefined;
    await appendReceipts(eventsFile, [
      decisionReceipt(event, decision, new Date(), warningDelivered),
    ]);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Codecut hook error: ${message}\n`);
    process.stdout.write(
      `${JSON.stringify(
        hookErrorOutput(agent, event, nativeName, message),
      )}\n`,
    );
  }
}
