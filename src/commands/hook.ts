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
  decisionReceipt,
  deriveAcknowledgementReceipts,
  deriveReceipts,
} from "../core/events.js";
import { findGitRoot, inspectDiff } from "../core/git.js";
import { eventsPath, findProjectRoot } from "../core/project.js";
import type { AgentName, Policy } from "../core/schema.js";
import {
  loadEnforcementPolicy,
  loadUserPolicy,
  userConfigDirectory,
  userEventsPath,
} from "../core/user.js";
import { appendReceipts, readSessionReceipts } from "../core/store.js";
import { hasProjectHooks } from "../install/user.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHook(
  agent: AgentName,
  options: { userLevel?: boolean } = {},
): Promise<void> {
  let nativeEventName =
    agent === "polytoken" ? process.env.POLYTOKEN_HOOK_EVENT : undefined;
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
    const event =
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
      if (options.userLevel && (await hasProjectHooks(projectRoot, agent))) {
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
        (await hasProjectHooks(projectRoot, "cursor"))
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

    const newReceipts = deriveReceipts(policy, event);
    await appendReceipts(eventsFile, newReceipts);
    let receipts = await readSessionReceipts(eventsFile, event.sessionId);
    const diffStats =
      event.stage === "stop" || event.stage === "agent-response"
        ? await inspectDiff(diffRoot, receipts)
        : undefined;
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
    });
    const decisionRuleIds = decision.violations
      .map((violation) => violation.ruleId)
      .sort();
    const warningAlreadySent =
      decision.outcome === "warn" &&
      receipts.some(
        (receipt) =>
          receipt.kind === "decision" &&
          receipt.outcome === "warn" &&
          JSON.stringify([...(receipt.ruleIds ?? [])].sort()) ===
            JSON.stringify(decisionRuleIds),
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
    if (agent === "polytoken") {
      process.stdout.write(
        `${JSON.stringify(polytokenProceedOutput(nativeEventName))}\n`,
      );
      return;
    }
    process.stdout.write(
      `${JSON.stringify({
        systemMessage: `Codecut could not check this action and allowed it: ${message}`,
      })}\n`,
    );
  }
}
