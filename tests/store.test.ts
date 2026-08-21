import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Receipt } from "../src/core/schema.js";
import { readSessionReceipts } from "../src/core/store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function receipt(sessionId: string): Receipt {
  return {
    version: 1,
    id: `edit-${sessionId}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId,
    kind: "edit",
    path: "src/example.ts",
    changedLines: 1,
  };
}

async function eventsFile(lines: string[]): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "codecut-store-state-"),
  );
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "events.jsonl");
  await writeFile(filePath, `${lines.join("\n")}\n`);
  return filePath;
}

describe("session receipt storage", () => {
  it("isolates malformed partial records owned by another session", async () => {
    const otherSession = JSON.stringify(receipt("session-a")).slice(0, -1);
    const currentReceipt = receipt("session-b");
    const filePath = await eventsFile([
      otherSession,
      JSON.stringify(currentReceipt),
    ]);

    await expect(readSessionReceipts(filePath, "session-b")).resolves.toEqual([
      currentReceipt,
    ]);
  });

  it("rejects malformed partial records owned by the current session", async () => {
    const currentSession = JSON.stringify(receipt("session-b")).slice(0, -1);
    const filePath = await eventsFile([currentSession]);

    await expect(
      readSessionReceipts(filePath, "session-b"),
    ).rejects.toThrow("Event state is malformed");
  });

  it("skips schema-invalid records owned by another session", async () => {
    const currentReceipt = receipt("session-b");
    const filePath = await eventsFile([
      JSON.stringify({ version: 99, sessionId: "session-a" }),
      JSON.stringify(currentReceipt),
    ]);

    await expect(readSessionReceipts(filePath, "session-b")).resolves.toEqual([
      currentReceipt,
    ]);
  });
});
