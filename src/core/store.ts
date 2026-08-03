import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { receiptSchema, type Receipt } from "./schema.js";

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
  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    try {
      const result = receiptSchema.safeParse(JSON.parse(line));
      if (result.success && result.data.sessionId === sessionId) {
        receipts.push(result.data);
      }
    } catch {
      // A partial or malformed line must not disable enforcement for valid lines.
    }
  }

  return receipts.sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
}
