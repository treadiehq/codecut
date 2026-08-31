import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatDevinOutput,
  normalizeDevinEvent,
} from "../src/adapters/devin.js";
import type { PolicyDecision } from "../src/core/schema.js";
import {
  devinUserConfigPath,
  DEVIN_HOOK_COMMAND,
  DEVIN_HOOK_EVENTS,
  installDevinHooks,
  mergeDevinHooks,
} from "../src/install/devin.js";
import { inspectAgentHooks } from "../src/install/registry.js";
import {
  hasProjectHooks,
  installUserHooks,
} from "../src/install/user.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codecut-devin-"));
  temporaryDirectories.push(directory);
  return directory;
}

const blocked: PolicyDecision = {
  outcome: "block",
  summary: "Remote tests are blocked.",
  violations: [
    {
      ruleId: "local-tests",
      directive: "Use local machines for testing",
      source: { path: "AGENTS.md", line: 2, scope: "project" },
      severity: "block",
      evidence: "A remote runner was selected.",
      recovery: "Run tests locally.",
    },
  ],
};

const warning: PolicyDecision = {
  ...blocked,
  outcome: "warn",
  violations: blocked.violations.map((violation) => ({
    ...violation,
    severity: "warn",
  })),
};

describe("native Devin integration", () => {
  it("normalizes environment-backed events and blocks with Devin output", () => {
    const event = normalizeDevinEvent(
      {
        hook_event_name: "PreToolUse",
        session_id: "session-1",
        prompt_id: "prompt-1",
        tool_name: "exec",
        tool_input: { command: "ssh runner npm test" },
      },
      new Date("2026-08-26T12:00:00.000Z"),
      { DEVIN_PROJECT_DIR: "/tmp/project" },
    );

    expect(event).toMatchObject({
      agent: "devin",
      stage: "pre-tool",
      sessionId: "session-1",
      cwd: "/tmp/project",
      toolName: "exec",
      toolInput: { command: "ssh runner npm test" },
    });
    expect(formatDevinOutput(event, blocked)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("Use local machines for testing"),
    });
  });

  it("normalizes failed tool responses and injects recovery context", () => {
    const event = normalizeDevinEvent({
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      cwd: "/tmp/project",
      tool_name: "exec",
      tool_input: { command: "npm test" },
      tool_response: {
        success: false,
        output: "1 test failed",
        error: "exit status 1",
      },
    });

    expect(event.stage).toBe("post-tool-failure");
    expect(formatDevinOutput(event, warning)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: expect.stringContaining("Run tests locally"),
      },
    });
  });

  it("continues stop warnings once and re-arms after compaction", () => {
    const stop = normalizeDevinEvent({
      hook_event_name: "Stop",
      session_id: "session-1",
      cwd: "/tmp/project",
      stop_hook_active: false,
    });
    const compacted = normalizeDevinEvent({
      hook_event_name: "PostCompaction",
      session_id: "session-1",
      cwd: "/tmp/project",
    });

    expect(formatDevinOutput(stop, warning).decision).toBe("block");
    expect(
      formatDevinOutput({ ...stop, stopHookActive: true }, warning),
    ).toEqual({});
    expect(formatDevinOutput(compacted, blocked)).toEqual({});
    expect(compacted.stage).toBe("context-reset");
  });

  it("merges standalone project hooks idempotently", async () => {
    const existing = {
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: "./existing-hook.sh" }],
        },
      ],
    };
    const first = mergeDevinHooks(existing);
    const second = mergeDevinHooks(first.hooks);

    expect(first.changedEvents).toEqual(DEVIN_HOOK_EVENTS);
    expect(second.changedEvents).toEqual([]);
    expect(first.hooks.UserPromptSubmit).toEqual(existing.UserPromptSubmit);

    const projectRoot = await temporaryDirectory();
    const installed = await installDevinHooks(projectRoot);
    const repeated = await installDevinHooks(projectRoot);
    const hooks = JSON.parse(
      await readFile(installed.settingsPath, "utf8"),
    ) as Record<string, unknown>;

    expect(installed.settingsPath).toBe(
      path.join(projectRoot, ".devin", "hooks.v1.json"),
    );
    expect(repeated.addedEvents).toEqual([]);
    expect(Object.keys(hooks)).toEqual(DEVIN_HOOK_EVENTS);
    expect(
      (
        hooks.PreToolUse as Array<{
          hooks: Array<{ command: string }>;
        }>
      )[0]?.hooks[0]?.command,
    ).toBe(DEVIN_HOOK_COMMAND);

    const health = await inspectAgentHooks(projectRoot, "devin");
    expect(health.missingHookEvents).toEqual([]);
    expect(await hasProjectHooks(projectRoot, "devin", "stop")).toBe(true);
  });

  it("preserves user configuration and installs nested global hooks", async () => {
    const home = await temporaryDirectory();
    const configHome = path.join(home, "config");
    const configPath = path.join(configHome, "devin", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ agent: { model: "example-model" } }),
    );
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    try {
      const installed = await installUserHooks("devin", home);
      const config = JSON.parse(
        await readFile(installed.settingsPath, "utf8"),
      ) as {
        agent: { model: string };
        hooks: Record<string, unknown>;
      };

      expect(installed.settingsPath).toBe(configPath);
      expect(config.agent.model).toBe("example-model");
      expect(Object.keys(config.hooks)).toEqual(DEVIN_HOOK_EVENTS);
      const command = (
        config.hooks.PreToolUse as Array<{
          hooks: Array<{ command: string }>;
        }>
      )[0]?.hooks[0]?.command;
      expect(command).toContain("command -v codecut");
      expect(command).toContain('CODECUT_BIN="$HOME/.local/bin/codecut"');
      expect(command).toContain(
        '"$CODECUT_BIN" hook --agent devin --user',
      );

      const health = await inspectAgentHooks(home, "devin", {
        userLevel: true,
      });
      expect(health.missingHookEvents).toEqual([]);
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previous;
      }
    }
  });

  it("uses Devin's documented Windows config path", () => {
    expect(
      devinUserConfigPath(
        "C:\\Users\\demo",
        { APPDATA: "C:\\Users\\demo\\AppData\\Roaming" },
        "win32",
      ),
    ).toBe(
      path.join(
        "C:\\Users\\demo\\AppData\\Roaming",
        "devin",
        "config.json",
      ),
    );
  });

  it("refuses to overwrite malformed project hooks", async () => {
    const projectRoot = await temporaryDirectory();
    const settingsPath = path.join(projectRoot, ".devin", "hooks.v1.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, "{not valid json");

    await expect(installDevinHooks(projectRoot)).rejects.toThrow(
      "Cannot update .devin/hooks.v1.json safely",
    );
    expect(await readFile(settingsPath, "utf8")).toBe("{not valid json");
  });

  it("refuses to replace an invalid user hooks field", async () => {
    const home = await temporaryDirectory();
    const settingsPath = path.join(home, ".config", "devin", "config.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ hooks: [] }));

    await expect(
      installDevinHooks(home, { userLevel: true, settingsPath }),
    ).rejects.toThrow('user config "hooks" must contain a JSON object');
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
      hooks: [],
    });
  });
});
