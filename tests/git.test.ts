import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectAddedCommentBlocks,
  inspectAddedComments,
  inspectDiff,
  workingTreeFingerprint,
} from "../src/core/git.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("working-tree fingerprints", () => {
  it("changes when untracked file content changes and restores after removal", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "codecut-git-state-"),
    );
    temporaryDirectories.push(directory);
    await execFileAsync("git", ["init", "--quiet"], { cwd: directory });

    const clean = await workingTreeFingerprint(directory);
    const filePath = path.join(directory, "example.ts");
    await writeFile(filePath, "export const value = 1;\n");
    const firstEdit = await workingTreeFingerprint(directory);
    await writeFile(filePath, "export const value = 2;\n");
    const secondEdit = await workingTreeFingerprint(directory);
    await rm(filePath);
    const restored = await workingTreeFingerprint(directory);

    expect(clean).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(firstEdit).not.toBe(clean);
    expect(secondEdit).not.toBe(firstEdit);
    expect(restored).toBe(clean);
  });

  it("does not change when identical content is staged or committed", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "codecut-git-metadata-"),
    );
    temporaryDirectories.push(directory);
    await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(
      path.join(directory, "example.ts"),
      "export const value = 1;\n",
    );

    const untracked = await workingTreeFingerprint(directory);
    await execFileAsync("git", ["add", "example.ts"], { cwd: directory });
    const staged = await workingTreeFingerprint(directory);
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Codecut Test",
        "-c",
        "user.email=codecut@example.com",
        "commit",
        "--quiet",
        "-m",
        "initial",
      ],
      { cwd: directory },
    );
    const committed = await workingTreeFingerprint(directory);

    expect(staged).toBe(untracked);
    expect(committed).toBe(untracked);
  });

  it("counts staged and unstaged content before the initial commit", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "codecut-initial-diff-"),
    );
    temporaryDirectories.push(directory);
    await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
    const filePath = path.join(directory, "massive.ts");
    await writeFile(
      filePath,
      Array.from({ length: 300 }, (_, index) => `export const a${index} = 1;`)
        .join("\n")
        .concat("\n"),
    );
    await execFileAsync("git", ["add", "massive.ts"], { cwd: directory });
    await writeFile(
      filePath,
      Array.from({ length: 600 }, (_, index) => `export const a${index} = 1;`)
        .join("\n")
        .concat("\n"),
    );

    const diff = await inspectDiff(directory, []);

    expect(diff).toMatchObject({
      files: 1,
      added: 600,
      deleted: 0,
      complete: true,
    });
    await expect(inspectAddedComments(directory)).resolves.toMatchObject({
      stats: [
        { path: "massive.ts", sourceLines: 600, commentLines: 0 },
      ],
    });
  });

  it("counts untracked text files after commits exist", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "codecut-untracked-diff-"),
    );
    temporaryDirectories.push(directory);
    await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
    await writeFile(path.join(directory, "README.md"), "# Example\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: directory });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Codecut Test",
        "-c",
        "user.email=codecut@example.com",
        "commit",
        "--quiet",
        "-m",
        "initial",
      ],
      { cwd: directory },
    );
    await writeFile(
      path.join(directory, "generated.ts"),
      Array.from(
        { length: 550 },
        (_, index) => `export const generated${index} = 1;`,
      )
        .join("\n")
        .concat("\n"),
    );

    const diff = await inspectDiff(directory, []);

    expect(diff).toMatchObject({
      files: 1,
      added: 550,
      deleted: 0,
      complete: true,
    });
    await expect(inspectAddedComments(directory)).resolves.toMatchObject({
      stats: [
        { path: "generated.ts", sourceLines: 550, commentLines: 0 },
      ],
    });
  });

  it("tracks content when the policy root is below the Git root", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "codecut-nested-git-state-"),
    );
    temporaryDirectories.push(directory);
    await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
    const projectRoot = path.join(directory, "packages", "app");
    await mkdir(projectRoot, { recursive: true });
    const filePath = path.join(projectRoot, "example.ts");
    await writeFile(filePath, "export const value = 1;\n");

    const first = await workingTreeFingerprint(projectRoot);
    await writeFile(filePath, "export const value = 2;\n");
    const second = await workingTreeFingerprint(projectRoot);

    expect(second).not.toBe(first);
  });

  it("scopes and normalizes diffs below the Git root", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "codecut-nested-git-diff-"),
    );
    temporaryDirectories.push(directory);
    await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
    const projectRoot = path.join(directory, "packages", "app");
    const projectSource = path.join(projectRoot, "src");
    const siblingRoot = path.join(directory, "packages", "other");
    await Promise.all([
      mkdir(projectSource, { recursive: true }),
      mkdir(siblingRoot, { recursive: true }),
    ]);
    const projectFile = path.join(projectSource, "example.ts");
    const siblingFile = path.join(siblingRoot, "outside.ts");
    await Promise.all([
      writeFile(projectFile, "export const value = 1;\n"),
      writeFile(siblingFile, "export const outside = 1;\n"),
    ]);
    await execFileAsync("git", ["add", "."], { cwd: directory });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Codecut Test",
        "-c",
        "user.email=codecut@example.com",
        "commit",
        "--quiet",
        "-m",
        "initial",
      ],
      { cwd: directory },
    );

    await Promise.all([
      writeFile(
        projectFile,
        "// Per the prompt, keep this workaround.\nexport const value = 2;\n",
      ),
      writeFile(
        siblingFile,
        "// Per the prompt, ignore this sibling.\nexport const outside = 2;\n",
      ),
    ]);

    await expect(inspectDiff(projectRoot, [])).resolves.toMatchObject({
      files: 1,
      added: 2,
      deleted: 1,
      complete: true,
    });
    await expect(inspectAddedCommentBlocks(projectRoot)).resolves.toEqual([
      {
        path: "src/example.ts",
        comments: ["Per the prompt, keep this workaround."],
      },
    ]);
    await expect(inspectAddedComments(projectRoot)).resolves.toEqual({
      blocks: [
        {
          path: "src/example.ts",
          comments: ["Per the prompt, keep this workaround."],
        },
      ],
      stats: [
        { path: "src/example.ts", sourceLines: 2, commentLines: 1 },
      ],
    });
  });

  it("fingerprints non-Git projects without including Codecut state", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "codecut-filesystem-state-"),
    );
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "example.ts");
    await writeFile(filePath, "export const value = 1;\n");
    const first = await workingTreeFingerprint(directory);
    await writeFile(filePath, "export const value = 2;\n");
    const second = await workingTreeFingerprint(directory);
    await mkdir(path.join(directory, ".codecut"), { recursive: true });
    await writeFile(
      path.join(directory, ".codecut", "events.jsonl"),
      "changing runtime state\n",
    );
    const withState = await workingTreeFingerprint(directory);

    expect(first).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(second).not.toBe(first);
    expect(withState).toBe(second);
  });

  it("skips fingerprints for oversized non-Git directories", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "codecut-large-filesystem-state-"),
    );
    temporaryDirectories.push(directory);
    await Promise.all(
      Array.from({ length: 257 }, (_, index) =>
        writeFile(path.join(directory, `file-${index}.txt`), `${index}\n`),
      ),
    );

    await expect(workingTreeFingerprint(directory)).resolves.toBeUndefined();
  });
});
