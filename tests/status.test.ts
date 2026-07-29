import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getStatus } from "../src/commands/status.js";
import { compilePolicy } from "../src/core/compiler.js";
import { writePolicy } from "../src/core/project.js";
import { installClaudeHooks } from "../src/install/claude.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("hook health status", () => {
  it("reports a missing lifecycle hook instead of a false healthy status", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "codecut-status-"),
    );
    temporaryDirectories.push(projectRoot);
    await writePolicy(
      projectRoot,
      compilePolicy({
        directives: [],
        sources: [],
        agent: "claude",
        acceptBlockingRules: false,
      }),
    );
    const installed = await installClaudeHooks(projectRoot);
    const settings = JSON.parse(
      await readFile(installed.settingsPath, "utf8"),
    ) as { hooks: Record<string, unknown> };
    delete settings.hooks.Stop;
    await writeFile(installed.settingsPath, JSON.stringify(settings));

    const status = await getStatus(projectRoot);

    expect(status.hooksInstalled).toBe(false);
    expect(status.missingHookEvents).toEqual(["Stop"]);
    expect(status.installedHookEvents).toHaveLength(3);
  });
});
