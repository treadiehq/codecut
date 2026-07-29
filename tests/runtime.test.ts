import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installRuntime,
  RUNTIME_RELATIVE_PATH,
} from "../src/install/runtime.js";
import {
  LEGACY_PROJECT_DIRECTORY,
  migrateLegacyProjectDirectory,
  PROJECT_DIRECTORY,
} from "../src/core/project.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("persistent runtime installation", () => {
  it("copies atomically and skips an unchanged runtime", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "codecut-runtime-"),
    );
    temporaryDirectories.push(projectRoot);
    const source = path.join(projectRoot, "source.mjs");
    await writeFile(source, "#!/usr/bin/env node\nconsole.log('ok');\n");

    const first = await installRuntime(projectRoot, source);
    const second = await installRuntime(projectRoot, source);

    expect(first.updated).toBe(true);
    expect(second.updated).toBe(false);
    expect(first.runtimePath).toBe(
      path.join(projectRoot, RUNTIME_RELATIVE_PATH),
    );
    expect(await readFile(first.runtimePath, "utf8")).toContain("console.log");
    expect((await stat(first.runtimePath)).mode & 0o111).not.toBe(0);
  });

  it("migrates the legacy project directory without its old runtime", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "codecut-migration-"),
    );
    temporaryDirectories.push(projectRoot);
    const legacyRuntime = path.join(
      projectRoot,
      LEGACY_PROJECT_DIRECTORY,
      "runtime",
      "papercut.cjs",
    );
    await mkdir(path.dirname(legacyRuntime), { recursive: true });
    await writeFile(legacyRuntime, "legacy");
    await writeFile(
      path.join(projectRoot, LEGACY_PROJECT_DIRECTORY, "policy.json"),
      "{}",
    );

    expect(await migrateLegacyProjectDirectory(projectRoot)).toBe(true);
    await expect(
      access(path.join(projectRoot, PROJECT_DIRECTORY, "policy.json")),
    ).resolves.toBeUndefined();
    await expect(access(legacyRuntime)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
