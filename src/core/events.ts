import { createHash, randomUUID } from "node:crypto";
import { groupCommentBlocks, scanComments } from "./comments.js";
import {
  countWarningLines,
  matchesAny,
} from "./patterns.js";
import type {
  DiffStats,
  NormalizedHookEvent,
  Policy,
  PolicyDecision,
  Receipt,
} from "./schema.js";

function objectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

export function extractCommand(input: unknown): string | undefined {
  const command = objectValue(input, "command") ?? objectValue(input, "cmd");
  return typeof command === "string" ? command : undefined;
}

function stringifyOutput(value: unknown, depth = 0): string {
  if (depth > 4 || value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      depth < 4 &&
      ((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]")))
    ) {
      try {
        return stringifyOutput(JSON.parse(trimmed), depth + 1);
      } catch {
        // Treat non-JSON tool output as plain text.
      }
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((item) => stringifyOutput(item, depth + 1))
      .join("\n");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferredKeys = [
      "stdout",
      "stderr",
      "output",
      "content",
      "text",
      "message",
    ];
    const preferred = preferredKeys
      .filter((key) => key in record)
      .map((key) => stringifyOutput(record[key], depth + 1))
      .join("\n");
    if (preferred.length > 0) {
      return preferred;
    }
    return Object.values(record)
      .slice(0, 50)
      .map((item) => stringifyOutput(item, depth + 1))
      .join("\n");
  }
  return "";
}

function commandFingerprint(command: string): string {
  const digest = createHash("sha256").update(command).digest("hex").slice(0, 12);
  return `sha256:${digest}`;
}

export function extractEditedPaths(event: NormalizedHookEvent): string[] {
  const paths = new Set<string>();
  for (const key of ["file_path", "path", "notebook_path"]) {
    const value = objectValue(event.toolInput, key);
    if (typeof value === "string") {
      paths.add(value);
    }
  }

  const command = extractCommand(event.toolInput);
  if (command && /(?:\*\*\* (?:Add|Update|Delete) File: )/.test(command)) {
    for (const match of command.matchAll(
      /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
    )) {
      if (match[1]) {
        paths.add(match[1].trim());
      }
    }
  }
  return [...paths];
}

function addedText(event: NormalizedHookEvent): string {
  const command = extractCommand(event.toolInput);
  if (command?.includes("*** Begin Patch")) {
    return command
      .split(/\r?\n/)
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .join("\n");
  }

  const content =
    objectValue(event.toolInput, "new_string") ??
    objectValue(event.toolInput, "content");
  return typeof content === "string" ? content : "";
}

export function extractAddedComments(event: NormalizedHookEvent): string[] {
  if (!isEditTool(event.toolName)) {
    return [];
  }

  return scanComments(
    addedText(event)
      .split(/\r?\n/)
      .map((text, index) => ({ line: index + 1, text })),
  ).map((comment) => comment.text);
}

export function extractAddedCommentBlocks(
  event: NormalizedHookEvent,
): string[][] {
  if (!isEditTool(event.toolName)) {
    return [];
  }

  return groupCommentBlocks(
    scanComments(
      addedText(event)
        .split(/\r?\n/)
        .map((text, index) => ({ line: index + 1, text })),
    ),
  ).map((block) => block.map((comment) => comment.text));
}

function estimatedChangedLines(event: NormalizedHookEvent): number | undefined {
  const command = extractCommand(event.toolInput);
  if (command?.includes("*** Begin Patch")) {
    return command
      .split(/\r?\n/)
      .filter(
        (line) =>
          (/^[+-]/.test(line) && !/^(?:\+\+\+|---|\*\*\*)/.test(line)),
      ).length;
  }

  const content =
    objectValue(event.toolInput, "content") ??
    objectValue(event.toolInput, "new_string");
  if (typeof content === "string") {
    return content.split(/\r?\n/).length;
  }
  return undefined;
}

function isCommandTool(toolName: string | undefined): boolean {
  return Boolean(toolName && /(?:bash|shell|terminal|exec)/i.test(toolName));
}

function isEditTool(toolName: string | undefined): boolean {
  return Boolean(
    toolName &&
      /^(?:Edit|Write|MultiEdit|NotebookEdit|apply[_-]?patch)$/i.test(toolName),
  );
}

export function deriveReceipts(
  policy: Policy,
  event: NormalizedHookEvent,
): Receipt[] {
  if (!["post-tool", "post-tool-failure"].includes(event.stage)) {
    return [];
  }

  const receipts: Receipt[] = [];
  if (isEditTool(event.toolName) && event.stage === "post-tool") {
    const paths = extractEditedPaths(event);
    const changedLines = estimatedChangedLines(event);
    for (const editedPath of paths.length > 0 ? paths : ["unknown"]) {
      receipts.push({
        version: 1,
        id: randomUUID(),
        timestamp: event.occurredAt,
        sessionId: event.sessionId,
        kind: "edit",
        path: editedPath,
        changedLines,
        toolName: event.toolName,
      });
    }
  }

  const command = extractCommand(event.toolInput);
  if (!command && !isCommandTool(event.toolName)) {
    return receipts;
  }

  const testPatterns = policy.rules
    .filter((rule) => rule.type === "require-passing-tests")
    .flatMap((rule) => rule.commandPatterns);
  const testOutputPatterns = policy.rules
    .filter((rule) => rule.type === "require-passing-tests")
    .flatMap((rule) => rule.testOutputPatterns);
  const verificationPatterns = policy.rules
    .filter(
      (rule) =>
        rule.type === "verification-evidence" ||
        rule.type === "warnings-as-errors",
    )
    .flatMap((rule) => rule.commandPatterns);
  const warningPatterns = policy.rules
    .filter((rule) => rule.type === "warnings-as-errors")
    .flatMap((rule) => rule.warningPatterns);
  const remoteCommandPatterns = policy.rules
    .filter((rule) => rule.type === "local-testing")
    .flatMap((rule) => rule.remoteCommandPatterns);
  const remoteToolPatterns = policy.rules
    .filter((rule) => rule.type === "local-testing")
    .flatMap((rule) => rule.remoteToolPatterns);

  const rawCommand = command ?? event.toolName ?? "unknown command";
  const output = stringifyOutput(event.toolOutput).slice(0, 200_000);
  const remote =
    matchesAny(rawCommand, remoteCommandPatterns) ||
    matchesAny(event.toolName ?? "", remoteToolPatterns);
  const isVerification = matchesAny(rawCommand, verificationPatterns);
  const isTest =
    matchesAny(rawCommand, testPatterns) ||
    (event.stage === "post-tool" &&
      isVerification &&
      matchesAny(output, testOutputPatterns));

  receipts.push({
    version: 1,
    id: randomUUID(),
    timestamp: event.occurredAt,
    sessionId: event.sessionId,
    kind: "command",
    commandFingerprint: commandFingerprint(rawCommand),
    toolName: event.toolName,
    success: event.stage === "post-tool",
    isTest,
    isVerification,
    location: remote ? "remote" : command ? "local" : "unknown",
    warningCount: countWarningLines(output, warningPatterns),
  });

  return receipts;
}

function isBlastRadiusJustification(message: string): boolean {
  const normalized = message.trim();
  return (
    normalized.length >= 30 &&
    /\b(?:because|since|due to|intentional|necessary|required|initial|greenfield|migration|rename|refactor|scaffold|generated)\b/i.test(
      normalized,
    ) &&
    /\b(?:scope|diff|change|files?|lines?|repository|implementation|migration|rename|refactor|scaffold)\b/i.test(
      normalized,
    )
  );
}

export function deriveAcknowledgementReceipts(
  policy: Policy,
  event: NormalizedHookEvent,
  receipts: Receipt[],
  diffStats: DiffStats | undefined,
): Receipt[] {
  const message = event.lastAssistantMessage;
  if (!message || !diffStats || !isBlastRadiusJustification(message)) {
    return [];
  }

  const blastRuleIds = new Set(
    policy.rules
      .filter(
        (rule) =>
          rule.enabled && rule.mode !== "off" && rule.type === "blast-radius",
      )
      .map((rule) => rule.id),
  );
  const latestEdit = [...receipts]
    .filter((receipt) => receipt.kind === "edit")
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
  const pendingDecision = [...receipts]
    .filter(
      (receipt) =>
        receipt.kind === "decision" &&
        receipt.ruleIds?.some((ruleId) => blastRuleIds.has(ruleId)),
    )
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
  if (
    !pendingDecision ||
    (latestEdit && pendingDecision.timestamp < latestEdit.timestamp)
  ) {
    return [];
  }

  const changedLines = diffStats.added + diffStats.deleted;
  const alreadyAcknowledged = receipts.some(
    (receipt) =>
      receipt.kind === "acknowledgement" &&
      receipt.timestamp >= pendingDecision.timestamp &&
      receipt.diffFiles === diffStats.files &&
      receipt.diffChangedLines === changedLines &&
      receipt.ruleIds?.some((ruleId) => blastRuleIds.has(ruleId)),
  );
  if (alreadyAcknowledged) {
    return [];
  }

  return [
    {
      version: 1,
      id: randomUUID(),
      timestamp: event.occurredAt,
      sessionId: event.sessionId,
      kind: "acknowledgement",
      ruleIds: pendingDecision.ruleIds?.filter((ruleId) =>
        blastRuleIds.has(ruleId),
      ),
      diffFiles: diffStats.files,
      diffChangedLines: changedLines,
    },
  ];
}

export function decisionReceipt(
  event: NormalizedHookEvent,
  decision: PolicyDecision,
): Receipt {
  return {
    version: 1,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: event.sessionId,
    kind: "decision",
    outcome: decision.outcome,
    ruleIds: decision.violations.map((violation) => violation.ruleId),
  };
}
