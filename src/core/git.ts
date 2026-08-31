import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import {
  measureAddedComments,
  type AddedCommentStats,
} from "./comment-density.js";
import { groupCommentBlocks, scanComments } from "./comments.js";
import { parseUnifiedDiff } from "./diff.js";
import {
  isCodecutManagedGeneratedFile,
  isCodecutManagedGeneratedPath,
} from "./managed-files.js";
import type { DiffStats, Receipt } from "./schema.js";

export type AddedCommentBlock = {
  path: string;
  comments: string[];
};

export type InspectedAddedComments = {
  blocks: AddedCommentBlock[];
  stats: AddedCommentStats[];
};

const COMMENT_INSPECTION_MAX_BYTES = 1024 * 1024;

const execFileAsync = promisify(execFile);
const FINGERPRINT_SKIPPED_DIRECTORIES = new Set([
  ".codecut",
  ".git",
  "node_modules",
]);

async function isManagedGeneratedProjectFile(
  projectRoot: string,
  relativePath: string,
): Promise<boolean> {
  if (!isCodecutManagedGeneratedPath(relativePath)) {
    return false;
  }
  try {
    const source = await readFile(
      path.resolve(projectRoot, relativePath),
      "utf8",
    );
    return isCodecutManagedGeneratedFile(relativePath, source);
  } catch {
    return false;
  }
}

// A non-Git directory has no tracked-file boundary. Keep its best-effort
// fingerprint useful for small project directories without allowing a hook to
// recursively hash an entire workspace containing several repositories.
const FILESYSTEM_FINGERPRINT_MAX_FILES = 256;
const FILESYSTEM_FINGERPRINT_MAX_DIRECTORIES = 512;
const FILESYSTEM_FINGERPRINT_MAX_BYTES = 16 * 1024 * 1024;
const GIT_DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const GIT_FILE_LIST_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

async function git(
  cwd: string,
  args: string[],
  maxBuffer = GIT_DEFAULT_MAX_BUFFER_BYTES,
): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer,
    });
    return result.stdout;
  } catch {
    return undefined;
  }
}

async function filesystemState(
  cwd: string,
): Promise<{ fingerprint: string | undefined; paths: string[]; git: boolean }> {
  const paths: string[] = [];
  let directoryCount = 0;
  let byteCount = 0;
  const visit = async (directory: string): Promise<boolean> => {
    directoryCount += 1;
    if (directoryCount > FILESYSTEM_FINGERPRINT_MAX_DIRECTORIES) {
      return false;
    }

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
        if (!(await visit(absolutePath))) {
          return false;
        }
        continue;
      }

      paths.push(relativePath);
      if (paths.length > FILESYSTEM_FINGERPRINT_MAX_FILES) {
        return false;
      }
      try {
        byteCount += (await lstat(absolutePath)).size;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      if (byteCount > FILESYSTEM_FINGERPRINT_MAX_BYTES) {
        return false;
      }
    }
    return true;
  };

  if (!(await visit(cwd))) {
    return { fingerprint: undefined, paths: [], git: false };
  }

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
): Promise<{ fingerprint: string | undefined; paths: string[]; git: boolean }> {
  const projectRoot = await realpath(cwd);
  const gitRoot = (
    await git(projectRoot, ["rev-parse", "--show-toplevel"])
  )?.trim();
  if (!gitRoot) {
    return filesystemState(cwd);
  }
  const prefix = path
    .relative(gitRoot, projectRoot)
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
  const listedFiles = await git(
    gitRoot,
    [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      pathspec,
    ],
    GIT_FILE_LIST_MAX_BUFFER_BYTES,
  );
  if (listedFiles === undefined) {
    return filesystemState(cwd);
  }
  const paths = changedPathsFromStatus(status).map((changedPath) =>
    prefix && changedPath.startsWith(`${prefix}/`)
      ? changedPath.slice(prefix.length + 1)
      : changedPath,
  );
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
          if (nestedState.fingerprint === undefined) {
            return { fingerprint: undefined, paths, git: true };
          }
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

function projectRelativePath(
  gitRoot: string,
  cwd: string,
  filePath: string,
): string | undefined {
  const prefix = path
    .relative(gitRoot, cwd)
    .split(path.sep)
    .join("/");
  if (!prefix) {
    return filePath;
  }
  return filePath.startsWith(`${prefix}/`)
    ? filePath.slice(prefix.length + 1)
    : undefined;
}

async function listGitProjectFiles(
  cwd: string,
  modes: string[],
): Promise<string[] | undefined> {
  const projectRoot = await realpath(cwd);
  const gitRoot = (
    await git(projectRoot, ["rev-parse", "--show-toplevel"])
  )?.trim();
  if (!gitRoot) {
    return undefined;
  }
  const prefix = path
    .relative(gitRoot, projectRoot)
    .split(path.sep)
    .join("/");
  const output = await git(
    gitRoot,
    [
      "ls-files",
      "-z",
      ...modes,
      "--exclude-standard",
      "--",
      prefix || ".",
    ],
    GIT_FILE_LIST_MAX_BUFFER_BYTES,
  );
  if (output === undefined) {
    return undefined;
  }
  return [
    ...new Set(
      output
        .split("\0")
        .filter(Boolean)
        .map((filePath) => projectRelativePath(gitRoot, projectRoot, filePath))
        .filter((filePath): filePath is string => Boolean(filePath))
        .filter(
          (filePath) =>
            filePath !== ".codecut" &&
            !filePath.startsWith(".codecut/"),
        ),
    ),
  ].sort();
}

async function countCurrentFileLines(
  cwd: string,
  files: string[],
): Promise<{
  paths: Set<string>;
  added: number;
  complete: boolean;
}> {
  const paths = new Set<string>();
  let added = 0;
  let complete = true;

  for (const filePath of files) {
    const absolutePath = path.resolve(cwd, filePath);
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    paths.add(filePath);
    if (stats.isSymbolicLink()) {
      continue;
    }
    if (!stats.isFile()) {
      complete = false;
      continue;
    }

    let bytes = 0;
    let lineFeeds = 0;
    let lastByte: number | undefined;
    let binary = false;
    for await (const chunk of createReadStream(absolutePath)) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      lastByte = buffer.at(-1);
      if (buffer.includes(0)) {
        binary = true;
        break;
      }
      for (const byte of buffer) {
        if (byte === 10) {
          lineFeeds += 1;
        }
      }
    }
    if (binary) {
      complete = false;
      continue;
    }
    added += lineFeeds + (bytes > 0 && lastByte !== 10 ? 1 : 0);
  }

  return { paths, added, complete };
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

export async function inspectAddedComments(
  cwd: string,
): Promise<InspectedAddedComments> {
  const projectRoot = await realpath(cwd);
  const gitRoot = (
    await git(projectRoot, ["rev-parse", "--show-toplevel"])
  )?.trim();
  if (!gitRoot) {
    return { blocks: [], stats: [] };
  }
  const prefix = path
    .relative(gitRoot, projectRoot)
    .split(path.sep)
    .join("/");
  const head = (
    await git(gitRoot, ["rev-parse", "--verify", "HEAD"])
  )?.trim();
  const diff = head
    ? ((await git(gitRoot, ["diff", "HEAD", "--", prefix || "."])) ?? "")
    : "";

  const blocks: AddedCommentBlock[] = [];
  const stats: AddedCommentStats[] = [];
  for (const file of parseUnifiedDiff(diff)) {
    const relativePath = projectRelativePath(
      gitRoot,
      projectRoot,
      file.path,
    );
    if (!relativePath) {
      continue;
    }
    if (await isManagedGeneratedProjectFile(projectRoot, relativePath)) {
      continue;
    }
    stats.push(measureAddedComments(relativePath, file.addedLines));
    blocks.push(
      ...groupCommentBlocks(scanComments(file.addedLines)).map((block) => ({
        path: relativePath,
        comments: block.map((comment) => comment.text),
      })),
    );
  }

  const currentFiles = await listGitProjectFiles(
    projectRoot,
    head ? ["--others"] : ["--cached", "--others"],
  );
  for (const relativePath of currentFiles ?? []) {
    const absolutePath = path.resolve(projectRoot, relativePath);
    let fileStats;
    try {
      fileStats = await lstat(absolutePath);
    } catch {
      continue;
    }
    if (
      !fileStats.isFile() ||
      fileStats.isSymbolicLink() ||
      fileStats.size > COMMENT_INSPECTION_MAX_BYTES
    ) {
      continue;
    }
    const contents = await readFile(absolutePath);
    if (contents.includes(0)) {
      continue;
    }
    const source = contents.toString("utf8");
    if (isCodecutManagedGeneratedFile(relativePath, source)) {
      continue;
    }
    const lines = source
      .split(/\r?\n/)
      .map((text, index) => ({ line: index + 1, text }));
    stats.push(measureAddedComments(relativePath, lines));
    blocks.push(
      ...groupCommentBlocks(scanComments(lines)).map((block) => ({
        path: relativePath,
        comments: block.map((comment) => comment.text),
      })),
    );
  }
  return { blocks, stats };
}

export async function inspectAddedCommentBlocks(
  cwd: string,
): Promise<AddedCommentBlock[]> {
  return (await inspectAddedComments(cwd)).blocks;
}

export async function inspectDiff(
  cwd: string,
  receipts: Receipt[],
): Promise<DiffStats> {
  const state = await workingTreeState(cwd);
  const parsed = parseNumstat("");
  if (state.git) {
    const projectRoot = await realpath(cwd);
    const gitRoot = (
      await git(projectRoot, ["rev-parse", "--show-toplevel"])
    )?.trim();
    if (!gitRoot) {
      parsed.complete = false;
    } else {
      const prefix = path
        .relative(gitRoot, projectRoot)
        .split(path.sep)
        .join("/");
      const head = (
        await git(gitRoot, ["rev-parse", "--verify", "HEAD"])
      )?.trim();
      if (head) {
        const againstHead = await git(gitRoot, [
          "diff",
          "--numstat",
          "--no-renames",
          "HEAD",
          "--",
          prefix || ".",
        ]);
        if (againstHead === undefined) {
          parsed.complete = false;
        } else {
          const currentDiff = parseNumstat(againstHead);
          for (const filePath of currentDiff.paths) {
            const relativePath = projectRelativePath(
              gitRoot,
              projectRoot,
              filePath,
            );
            if (relativePath) {
              parsed.paths.add(relativePath);
            }
          }
          parsed.added += currentDiff.added;
          parsed.deleted += currentDiff.deleted;
          parsed.complete &&= currentDiff.complete;
        }
        const untracked = await listGitProjectFiles(projectRoot, ["--others"]);
        if (untracked === undefined) {
          parsed.complete = false;
        } else {
          const counted = await countCurrentFileLines(projectRoot, untracked);
          for (const filePath of counted.paths) {
            parsed.paths.add(filePath);
          }
          parsed.added += counted.added;
          parsed.complete &&= counted.complete;
        }
      } else {
        const initialFiles = await listGitProjectFiles(projectRoot, [
          "--cached",
          "--others",
        ]);
        if (initialFiles === undefined) {
          parsed.complete = false;
        } else {
          const counted = await countCurrentFileLines(projectRoot, initialFiles);
          Object.assign(parsed, counted);
        }
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
