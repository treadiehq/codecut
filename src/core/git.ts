import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { DiffStats, Receipt } from "./schema.js";

const execFileAsync = promisify(execFile);
const FINGERPRINT_SKIPPED_DIRECTORIES = new Set([
  ".codecut",
  ".git",
  "node_modules",
]);

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

async function filesystemState(
  cwd: string,
): Promise<{ fingerprint: string; paths: string[]; git: boolean }> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        FINGERPRINT_SKIPPED_DIRECTORIES.has(entry.name)
      ) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(cwd, absolutePath);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else {
        paths.push(relativePath);
      }
    }
  };
  await visit(cwd);
  const hash = createHash("sha256");
  hash.update("filesystem\0");
  for (const filePath of paths) {
    await hashPath(hash, cwd, filePath);
  }
  return {
    fingerprint: `sha256:${hash.digest("hex").slice(0, 16)}`,
    paths: [],
    git: false,
  };
}

function changedPathsFromStatus(output: string): string[] {
  const paths = new Set<string>();
  const records = output.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) {
      continue;
    }
    const status = record.slice(0, 2);
    paths.add(record.slice(3));
    if (/[RC]/.test(status)) {
      const originalPath = records[index + 1];
      if (originalPath) {
        paths.add(originalPath);
        index += 1;
      }
    }
  }
  return [...paths].sort();
}

async function hashPath(
  hash: ReturnType<typeof createHash>,
  cwd: string,
  relativePath: string,
): Promise<void> {
  const absolutePath = path.resolve(cwd, relativePath);
  try {
    const stats = await lstat(absolutePath);
    hash.update(`path\0${relativePath}\0`);
    hash.update(`mode\0${stats.mode}\0`);
    if (stats.isSymbolicLink()) {
      hash.update(`link\0${await readlink(absolutePath)}\0`);
      return;
    }
    if (stats.isFile()) {
      hash.update("file\0");
      for await (const chunk of createReadStream(absolutePath)) {
        hash.update(chunk as Buffer);
      }
      return;
    }
    hash.update(`other\0${stats.size}\0${stats.mtimeMs}\0`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function workingTreeState(
  cwd: string,
): Promise<{ fingerprint: string; paths: string[]; git: boolean }> {
  const gitRoot = (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
  if (!gitRoot) {
    return filesystemState(cwd);
  }
  const prefix = path
    .relative(gitRoot, cwd)
    .split(path.sep)
    .join("/");
  const pathspec = prefix || ".";
  const status = await git(gitRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    pathspec,
  ]);
  if (status === undefined) {
    return filesystemState(cwd);
  }

  const hash = createHash("sha256");
  const listedFiles = await git(gitRoot, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    pathspec,
  ]);
  if (listedFiles === undefined) {
    return filesystemState(cwd);
  }
  hash.update("git-files\0");
  const files = [...new Set(listedFiles.split("\0").filter(Boolean))]
    .filter((file) => {
      const projectRelative =
        prefix && file.startsWith(`${prefix}/`)
          ? file.slice(prefix.length + 1)
          : file;
      return (
        projectRelative !== ".codecut" &&
        !projectRelative.startsWith(".codecut/")
      );
    })
    .sort();
  for (const file of files) {
    const absolutePath = path.resolve(gitRoot, file);
    try {
      const stats = await lstat(absolutePath);
      if (stats.isDirectory()) {
        const nestedRoot = (
          await git(absolutePath, ["rev-parse", "--show-toplevel"])
        )?.trim();
        if (nestedRoot && path.resolve(nestedRoot) === absolutePath) {
          const nestedState = await workingTreeState(absolutePath);
          hash.update(`nested\0${file}\0${nestedState.fingerprint}\0`);
          continue;
        }
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    await hashPath(hash, gitRoot, file);
  }
  const paths = changedPathsFromStatus(status).map((changedPath) =>
    prefix && changedPath.startsWith(`${prefix}/`)
      ? changedPath.slice(prefix.length + 1)
      : changedPath,
  );
  return {
    fingerprint: `sha256:${hash.digest("hex").slice(0, 16)}`,
    paths,
    git: true,
  };
}

export async function workingTreeFingerprint(
  cwd: string,
): Promise<string | undefined> {
  return (await workingTreeState(cwd)).fingerprint;
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

export async function findGitRoot(cwd: string): Promise<string | undefined> {
  const output = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = output?.trim();
  return root && root.length > 0 ? root : undefined;
}

export async function inspectDiff(
  cwd: string,
  receipts: Receipt[],
): Promise<DiffStats> {
  const state = await workingTreeState(cwd);
  const parsed = parseNumstat("");
  if (state.git) {
    const againstHead = await git(cwd, [
      "diff",
      "--numstat",
      "--no-renames",
      "HEAD",
      "--",
    ]);
    const unstaged =
      againstHead ??
      (await git(cwd, ["diff", "--numstat", "--no-renames", "--"]));
    Object.assign(parsed, parseNumstat(unstaged ?? ""));
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
  } else {
    parsed.complete = false;
  }
  for (const changedPath of state.paths) {
    parsed.paths.add(changedPath);
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
    fingerprint: state.fingerprint,
  };
}
