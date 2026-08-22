import process from "node:process";
import {
  formatClaudeOutput,
  normalizeClaudeEvent,
} from "../adapters/claude.js";
import {
  formatCursorOutput,
  normalizeCursorEvent,
} from "../adapters/cursor.js";
import {
  formatCodexOutput,
  normalizeCodexEvent,
} from "../adapters/codex.js";
import {
  formatPolytokenOutput,
  normalizePolytokenEvent,
  polytokenEventName,
  polytokenProceedOutput,
} from "../adapters/polytoken.js";
import { evaluatePolicy } from "../core/engine.js";
import {
  contextResetReceipt,
  decisionReceipt,
  deriveAcknowledgementReceipts,
  deriveReceipts,
} from "../core/events.js";
import {
  findGitRoot,
  inspectAddedCommentBlocks,
  inspectDiff,
  workingTreeFingerprint,
} from "../core/git.js";
import { eventsPath, findProjectRoot } from "../core/project.js";
import type {
  AgentName,
  NormalizedHookEvent,
  Policy,
  Receipt,
} from "../core/schema.js";
import {
  loadEnforcementPolicy,
  loadUserPolicy,
  userConfigDirectory,
  userEventsPath,
} from "../core/user.js";
import { appendReceipts, readSessionReceipts } from "../core/store.js";
import { hasProjectHooks } from "../install/user.js";

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
  return eventName?.toLowerCase() === "stop";
}

function hookErrorOutput(
  agent: AgentName,
  event: NormalizedHookEvent | undefined,
  nativeEventName: string | undefined,
  message: string,
): Record<string, unknown> {
  const detail = `Codecut could not check this action: ${message}`;
  const recovery =
    "Repair Codecut state, then run `codecut status` and `codecut test`.";
  const stopFailure =
    event === undefined ||
    event.stage === "stop" ||
    isNativeStopEvent(nativeEventName);

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
    return {
      ...polytokenProceedOutput(nativeEventName),
      reason: `${detail} This non-stop action was allowed.`,
    };
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

export async function runHook(
  agent: AgentName,
  options: { userLevel?: boolean } = {},
): Promise<void> {
  let nativeEventName =
    agent === "polytoken" ? process.env.POLYTOKEN_HOOK_EVENT : undefined;
  let event: NormalizedHookEvent | undefined;
  try {
    if (!["claude", "cursor", "codex", "polytoken"].includes(agent)) {
      throw new Error(
        `Unsupported hook agent "${agent}". Use "claude", "cursor", "codex", or "polytoken".`,
      );
    }

    const rawInput = await readStdin();
    const parsedInput = JSON.parse(rawInput);
    if (agent === "polytoken") {
      nativeEventName = polytokenEventName(parsedInput);
    }
    event =
      agent === "cursor"
        ? normalizeCursorEvent(parsedInput)
        : agent === "codex"
          ? normalizeCodexEvent(parsedInput)
          : agent === "polytoken"
            ? normalizePolytokenEvent(parsedInput)
          : normalizeClaudeEvent(parsedInput, agent);
    const proceed = (): void => {
      process.stdout.write(
        `${JSON.stringify(
          agent === "polytoken" ? polytokenProceedOutput(nativeEventName) : {},
        )}\n`,
      );
    };

    const projectRoot = await findProjectRoot(event.cwd);
    let policy: Policy;
    let diffRoot: string;
    let eventsFile: string;

    if (projectRoot) {
      if (
        options.userLevel &&
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
    const diffStats =
      event.stage === "stop" || event.stage === "agent-response"
        ? await inspectDiff(diffRoot, receipts)
        : undefined;
    const addedCommentBlocks =
      event.stage === "stop" ? await inspectAddedCommentBlocks(diffRoot) : [];
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
        `${JSON.stringify(
          agent === "polytoken" ? { outcome: "acknowledged" } : {},
        )}\n`,
      );
      return;
    }
    const decision = evaluatePolicy({
      policy,
      event,
      receipts,
      diffStats,
      addedCommentBlocks,
    });
    const warningAlreadySent =
      decision.outcome === "warn" &&
      warningAlreadyDelivered(
        receipts,
        decision.violations.map((violation) => violation.ruleId),
      );
    await appendReceipts(eventsFile, [decisionReceipt(event, decision)]);

    const outputEvent =
      agent === "polytoken" && warningAlreadySent
        ? { ...event, stopHookActive: true }
        : event;
    const output =
      agent === "cursor"
        ? formatCursorOutput(outputEvent, decision)
        : agent === "codex"
          ? formatCodexOutput(outputEvent, decision)
          : agent === "polytoken"
            ? formatPolytokenOutput(outputEvent, decision)
            : formatClaudeOutput(outputEvent, decision);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Codecut hook error: ${message}\n`);
    process.stdout.write(
      `${JSON.stringify(
        hookErrorOutput(agent, event, nativeEventName, message),
      )}\n`,
    );
  }
}
