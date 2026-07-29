import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DiffStats, Receipt } from "./schema.js";

const execFileAsync = promisify(execFile);

async function git(
  cwd: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return result.stdout;
  } catch {
    return undefined;
  }
}

function parseNumstat(output: string): {
  paths: Set<string>;
  added: number;
  deleted: number;
  complete: boolean;
} {
  const paths = new Set<string>();
  let added = 0;
  let deleted = 0;
  let complete = true;

  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }
    const [addedValue, deletedValue, ...pathParts] = line.split("\t");
    const changedPath = pathParts.join("\t");
    if (!addedValue || !deletedValue || !changedPath) {
      continue;
    }
    paths.add(changedPath);
    if (addedValue === "-" || deletedValue === "-") {
      complete = false;
      continue;
    }
    added += Number.parseInt(addedValue, 10) || 0;
    deleted += Number.parseInt(deletedValue, 10) || 0;
  }

  return { paths, added, deleted, complete };
}

export async function inspectDiff(
  cwd: string,
  receipts: Receipt[],
): Promise<DiffStats> {
  const againstHead = await git(cwd, ["diff", "--numstat", "HEAD", "--"]);
  const unstaged = againstHead ?? (await git(cwd, ["diff", "--numstat", "--"]));
  const parsed = parseNumstat(unstaged ?? "");
  const untracked = await git(cwd, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  if (untracked !== undefined) {
    for (const file of untracked.split(/\r?\n/).filter(Boolean)) {
      parsed.paths.add(file);
      parsed.complete = false;
    }
  }

  if (parsed.paths.size === 0) {
    const editReceipts = receipts.filter((receipt) => receipt.kind === "edit");
    for (const receipt of editReceipts) {
      if (receipt.path) {
        parsed.paths.add(receipt.path);
      }
      if (receipt.changedLines !== undefined) {
        parsed.added += receipt.changedLines;
      } else {
        parsed.complete = false;
      }
    }
  }

  return {
    files: parsed.paths.size,
    added: parsed.added,
    deleted: parsed.deleted,
    complete: parsed.complete,
  };
}
