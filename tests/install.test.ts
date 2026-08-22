import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  expectedHookCommand,
  installClaudeHooks,
} from "../src/install/claude.js";
import { initializeProject } from "../src/commands/init.js";
import { loadPolicy } from "../src/core/project.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codecut-install-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Claude hook installation", () => {
  it("preserves existing hooks and installs idempotently", async () => {
    const projectRoot = await temporaryDirectory();
    const claudeDirectory = path.join(projectRoot, ".claude");
    await mkdir(claudeDirectory, { recursive: true });
    await writeFile(
      path.join(claudeDirectory, "settings.json"),
      JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: {
          PreToolUse: [
            {
              matcher: "Read",
              hooks: [{ type: "command", command: "./existing-hook.sh" }],
            },
            {
              matcher: "Shell",
              hooks: [
                {
                  type: "command",
                  command: "papercut hook --agent claude",
                },
              ],
            },
          ],
        },
      }),
    );

    const first = await installClaudeHooks(projectRoot);
    const second = await installClaudeHooks(projectRoot);
    const settings = JSON.parse(
      await readFile(path.join(claudeDirectory, "settings.json"), "utf8"),
    ) as {
      permissions: { allow: string[] };
      hooks: Record<string, unknown[]>;
    };

    expect(first.addedEvents).toHaveLength(5);
    expect(second.addedEvents).toHaveLength(0);
    expect(settings.permissions.allow).toEqual(["Read"]);
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(JSON.stringify(settings)).not.toContain("papercut");
    expect(expectedHookCommand()).toContain(".codecut/runtime/codecut");
    expect(expectedHookCommand()).not.toContain("node ");
  });

  it("refuses to overwrite malformed settings", async () => {
    const projectRoot = await temporaryDirectory();
    const claudeDirectory = path.join(projectRoot, ".claude");
    await mkdir(claudeDirectory, { recursive: true });
    await writeFile(
      path.join(claudeDirectory, "settings.json"),
      "{not valid json",
    );

    await expect(installClaudeHooks(projectRoot)).rejects.toThrow(
      "Cannot update .claude/settings.json safely",
    );
    expect(
      await readFile(path.join(claudeDirectory, "settings.json"), "utf8"),
    ).toBe("{not valid json");
  });

  it("does not leave a partial policy when initialization validation fails", async () => {
    const projectRoot = await temporaryDirectory();
    const claudeDirectory = path.join(projectRoot, ".claude");
    await mkdir(claudeDirectory, { recursive: true });
    await writeFile(
      path.join(claudeDirectory, "settings.json"),
      "{not valid json",
    );
    await writeFile(
      path.join(projectRoot, "CLAUDE.md"),
      "- All unit tests must pass\n",
    );

    await expect(
      initializeProject({
        cwd: projectRoot,
        agent: "claude",
        accept: true,
        force: false,
      }),
    ).rejects.toThrow("Cannot update .claude/settings.json safely");
    await expect(
      access(path.join(projectRoot, ".codecut", "policy.json")),
    ).rejects.toThrow();
  });

  it("activates an existing project policy with --accept", async () => {
    const projectRoot = await temporaryDirectory();
    await writeFile(
      path.join(projectRoot, "CLAUDE.md"),
      "- All unit tests must pass\n",
    );
    const initial = await initializeProject({
      cwd: projectRoot,
      agent: "claude",
      accept: false,
      force: false,
    });
    expect(initial.blockingRulesConfirmed).toBe(false);

    const accepted = await initializeProject({
      cwd: projectRoot,
      agent: "claude",
      accept: true,
      force: false,
    });

    expect(accepted.policyCreated).toBe(false);
    expect(accepted.policyUpdated).toBe(true);
    expect(accepted.blockingRulesConfirmed).toBe(true);
    expect(
      (await loadPolicy(projectRoot)).rules
        .filter((rule) => rule.mode === "block")
        .every((rule) => rule.confirmed),
    ).toBe(true);
  });
});
