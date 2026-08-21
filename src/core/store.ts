import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { receiptSchema, type Receipt } from "./schema.js";

function partialSessionId(line: string): string | undefined {
  const match =
    /(?:^\s*\{|,)\s*"sessionId"\s*:\s*("(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*")/.exec(
      line,
    );
  if (!match?.[1]) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(match[1]);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function malformedEventState(
  eventsFile: string,
  lineNumber: number,
  error: unknown,
): Error {
  return new Error(
    `Event state is malformed at ${eventsFile}:${lineNumber}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

export async function appendReceipts(
  eventsFile: string,
  receipts: Receipt[],
): Promise<void> {
  if (receipts.length === 0) {
    return;
  }

  await mkdir(path.dirname(eventsFile), { recursive: true });
  const body = `${receipts.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`;
  await appendFile(eventsFile, body, { encoding: "utf8", mode: 0o600 });
}

export async function readSessionReceipts(
  eventsFile: string,
  sessionId: string,
): Promise<Receipt[]> {
  let content: string;
  try {
    content = await readFile(eventsFile, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  const receipts: Receipt[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const owner = partialSessionId(line);
      if (owner !== undefined && owner !== sessionId) {
        continue;
      }
      throw malformedEventState(eventsFile, index + 1, error);
    }
    const owner =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).sessionId
        : undefined;
    if (typeof owner === "string" && owner !== sessionId) {
      continue;
    }
    const result = receiptSchema.safeParse(parsed);
    if (!result.success) {
      throw malformedEventState(
        eventsFile,
        index + 1,
        new Error(result.error.message),
      );
    }
    receipts.push(result.data);
  }

  return receipts.sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
}
