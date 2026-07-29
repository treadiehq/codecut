import { readFile } from "node:fs/promises";
import path from "node:path";
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
import { evaluatePolicy } from "../core/engine.js";
import {
  decisionReceipt,
  deriveAcknowledgementReceipts,
  deriveReceipts,
} from "../core/events.js";
import { inspectDiff } from "../core/git.js";
import { findProjectRoot, loadPolicy } from "../core/project.js";
import type { AgentName } from "../core/schema.js";
import { appendReceipts, readSessionReceipts } from "../core/store.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function hasNativeCursorHooks(projectRoot: string): Promise<boolean> {
  try {
    const hooks = await readFile(
      path.join(projectRoot, ".cursor", "hooks.json"),
      "utf8",
    );
    return hooks.includes("codecut") && hooks.includes("hook --agent cursor");
  } catch {
    return false;
  }
}

export async function runHook(agent: AgentName): Promise<void> {
  try {
    if (!["claude", "cursor", "codex"].includes(agent)) {
      throw new Error(
        `Unsupported hook agent "${agent}". Use "claude", "cursor", or "codex".`,
      );
    }

    const rawInput = await readStdin();
    const parsedInput = JSON.parse(rawInput);
    const event =
      agent === "cursor"
        ? normalizeCursorEvent(parsedInput)
        : agent === "codex"
          ? normalizeCodexEvent(parsedInput)
          : normalizeClaudeEvent(parsedInput, agent);
    const projectRoot = await findProjectRoot(event.cwd);
    if (!projectRoot) {
      process.stdout.write("{}\n");
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
      (await hasNativeCursorHooks(projectRoot))
    ) {
      process.stdout.write("{}\n");
      return;
    }

    const policy = await loadPolicy(projectRoot);
    const newReceipts = deriveReceipts(policy, event);
    await appendReceipts(projectRoot, newReceipts);
    let receipts = await readSessionReceipts(projectRoot, event.sessionId);
    const diffStats =
      event.stage === "stop" || event.stage === "agent-response"
        ? await inspectDiff(projectRoot, receipts)
        : undefined;
    const acknowledgements = deriveAcknowledgementReceipts(
      policy,
      event,
      receipts,
      diffStats,
    );
    await appendReceipts(projectRoot, acknowledgements);
    receipts = [...receipts, ...acknowledgements];
    if (event.stage === "agent-response") {
      process.stdout.write("{}\n");
      return;
    }
    const decision = evaluatePolicy({
      policy,
      event,
      receipts,
      diffStats,
    });
    await appendReceipts(projectRoot, [decisionReceipt(event, decision)]);

    const output =
      agent === "cursor"
        ? formatCursorOutput(event, decision)
        : agent === "codex"
          ? formatCodexOutput(event, decision)
          : formatClaudeOutput(event, decision);
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify({
        systemMessage: `Codecut could not check this action and allowed it: ${message}`,
      })}\n`,
    );
  }
}
