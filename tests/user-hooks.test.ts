import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { userEventsPath, userStateDirectory } from "../src/core/user.js";
import {
  hasProjectHooks,
  installUserHooks,
  userHookCommand,
} from "../src/install/user.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("user hook command", () => {
  it("resolves the global binary and passes the user flag", () => {
    const command = userHookCommand("cursor");
    expect(command).toContain("command -v codecut");
    expect(command).toContain("hook --agent cursor --user");
    expect(command).not.toContain(".codecut/runtime");
  });
});

describe("user-level hook install", () => {
  it("writes cursor hooks into the home directory with the user command", async () => {
    const home = await temporaryDirectory(".codecut-home-");

    const result = await installUserHooks("cursor", home);

    expect(result.settingsPath).toBe(
      path.join(home, ".cursor", "hooks.json"),
    );
    const settings = JSON.parse(
      await readFile(result.settingsPath, "utf8"),
    ) as { hooks: Record<string, Array<{ command: string }>> };
    expect(Object.keys(settings.hooks)).toEqual([
      "preToolUse",
      "postToolUse",
      "postToolUseFailure",
      "afterAgentResponse",
      "stop",
    ]);
    for (const definitions of Object.values(settings.hooks)) {
      expect(definitions).toHaveLength(1);
      expect(definitions[0]?.command).toContain(
        "hook --agent cursor --user",
      );
    }
  });

  it("is idempotent and preserves unrelated hooks", async () => {
    const home = await temporaryDirectory(".codecut-home-");
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: "command", command: "my-tool" }] }] },
      }),
      "utf8",
    );

    const first = await installUserHooks("claude", home);
    const second = await installUserHooks("claude", home);

    expect(first.addedEvents.length).toBeGreaterThan(0);
    expect(second.addedEvents).toEqual([]);
    const settings = JSON.parse(
      await readFile(first.settingsPath, "utf8"),
    ) as { hooks: { Stop: unknown[] } };
    expect(JSON.stringify(settings.hooks.Stop)).toContain("my-tool");
    expect(JSON.stringify(settings.hooks.Stop)).toContain(
      "hook --agent claude --user",
    );
  });
});

describe("project hook detection", () => {
  it("detects installed project hooks per agent", async () => {
    const projectRoot = await temporaryDirectory(".codecut-project-");
    await mkdir(path.join(projectRoot, ".cursor"), { recursive: true });
    await writeFile(
      path.join(projectRoot, ".cursor", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          stop: [{ command: '"$CODECUT_ROOT/.codecut/runtime/codecut" hook --agent cursor' }],
        },
      }),
      "utf8",
    );

    expect(await hasProjectHooks(projectRoot, "cursor")).toBe(true);
    expect(await hasProjectHooks(projectRoot, "cursor", "stop")).toBe(true);
    expect(
      await hasProjectHooks(projectRoot, "cursor", "pre-tool"),
    ).toBe(false);
    expect(await hasProjectHooks(projectRoot, "claude")).toBe(false);
    expect(await hasProjectHooks(projectRoot, "unknown")).toBe(false);
  });

  it("inspects executable command fields without matching metadata", async () => {
    const cursorRoot = await temporaryDirectory(".codecut-project-");
    await mkdir(path.join(cursorRoot, ".cursor"), { recursive: true });
    const cursorSettings = path.join(cursorRoot, ".cursor", "hooks.json");
    await writeFile(
      cursorSettings,
      JSON.stringify({
        version: 1,
        hooks: {
          stop: [
            {
              description:
                "Previously used codecut, now using an internal tool",
              command: "internal-tool hook --agent cursor",
            },
            {
              description: "codecut hook --agent cursor documentation",
              command: "echo hello",
            },
          ],
        },
      }),
      "utf8",
    );

    expect(await hasProjectHooks(cursorRoot, "cursor")).toBe(false);
    expect(await hasProjectHooks(cursorRoot, "cursor", "stop")).toBe(false);

    await writeFile(
      cursorSettings,
      JSON.stringify({
        version: 1,
        hooks: {
          stop: [{ command: "papercut hook --agent cursor" }],
        },
      }),
      "utf8",
    );
    expect(await hasProjectHooks(cursorRoot, "cursor", "stop")).toBe(true);

    const polytokenRoot = await temporaryDirectory(".codecut-project-");
    await mkdir(path.join(polytokenRoot, ".polytoken"), { recursive: true });
    await writeFile(
      path.join(polytokenRoot, ".polytoken", "hooks.json"),
      JSON.stringify([
        {
          event: "stop",
          _comment: "Previously used codecut",
          handler: { bash: "internal-tool hook --agent polytoken" },
        },
      ]),
      "utf8",
    );
    expect(
      await hasProjectHooks(polytokenRoot, "polytoken", "stop"),
    ).toBe(false);
    await writeFile(
      path.join(polytokenRoot, ".polytoken", "hooks.json"),
      JSON.stringify([
        {
          name: "codecut-stop",
          event: "stop",
          handler: { bash: "codecut hook --agent polytoken" },
        },
      ]),
      "utf8",
    );
    expect(
      await hasProjectHooks(polytokenRoot, "polytoken", "stop"),
    ).toBe(true);
  });
});

describe("user state paths", () => {
  it("prefers XDG_STATE_HOME and hashes the state root", () => {
    const stateDirectory = userStateDirectory({ XDG_STATE_HOME: "/tmp/state" });
    expect(stateDirectory).toBe(path.join("/tmp/state", "codecut"));

    const first = userEventsPath("/repos/a", stateDirectory);
    const second = userEventsPath("/repos/a", stateDirectory);
    const other = userEventsPath("/repos/b", stateDirectory);
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first.startsWith(stateDirectory)).toBe(true);
    expect(first.endsWith(".jsonl")).toBe(true);
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is unset", () => {
    expect(userStateDirectory({})).toContain(
      path.join(".local", "state", "codecut"),
    );
  });

  it("uses one events file for symlinked and physical state roots", async () => {
    const root = await temporaryDirectory(".codecut-symlink-");
    const physicalRoot = path.join(root, "physical");
    const symlinkRoot = path.join(root, "symlink");
    const stateDirectory = path.join(root, "state");
    await mkdir(physicalRoot);
    await symlink(
      physicalRoot,
      symlinkRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(userEventsPath(symlinkRoot, stateDirectory)).toBe(
      userEventsPath(physicalRoot, stateDirectory),
    );
  });
});
