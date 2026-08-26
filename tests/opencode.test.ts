import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatOpenCodeOutput,
  normalizeOpenCodeEvent,
} from "../src/adapters/opencode.js";
import { extractEditedPaths } from "../src/core/events.js";
import type { PolicyDecision } from "../src/core/schema.js";
import {
  inspectOpenCodePlugin,
  installOpenCodeHooks,
  OPENCODE_HOOK_EVENTS,
  openCodePluginPath,
} from "../src/install/opencode.js";
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "codecut-opencode-"));
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

describe("native OpenCode integration", () => {
  it("normalizes tool events and denies blocking pre-tool decisions", () => {
    const event = normalizeOpenCodeEvent(
      {
        event: "tool.execute.before",
        session_id: "session-1",
        cwd: "/tmp/project",
        tool_name: "bash",
        call_id: "call-1",
        tool_input: { command: "ssh runner npm test" },
      },
      new Date("2026-08-26T12:00:00.000Z"),
    );

    expect(event).toMatchObject({
      agent: "opencode",
      stage: "pre-tool",
      sessionId: "session-1",
      cwd: "/tmp/project",
      toolName: "bash",
      toolCallId: "call-1",
      toolInput: { command: "ssh runner npm test" },
    });
    expect(formatOpenCodeOutput(event, blocked)).toMatchObject({
      outcome: "deny",
      reason: expect.stringContaining("Use local machines for testing"),
    });
  });

  it("detects OpenCode command failures from structured tool metadata", () => {
    const event = normalizeOpenCodeEvent({
      event: "tool.execute.after",
      session_id: "session-1",
      cwd: "/tmp/project",
      tool_name: "bash",
      call_id: "call-1",
      tool_input: { command: "npm test" },
      tool_output: {
        title: "npm test",
        output: "1 test failed",
        metadata: { exit: 1, truncated: false },
      },
    });

    expect(event.stage).toBe("post-tool-failure");
  });

  it("recognizes OpenCode camel-case edit paths", () => {
    const event = normalizeOpenCodeEvent({
      event: "tool.execute.after",
      session_id: "session-1",
      cwd: "/tmp/project",
      tool_name: "write",
      call_id: "call-1",
      tool_input: {
        filePath: "src/example.ts",
        content: "export const value = 1;",
      },
      tool_output: { output: "Done", metadata: {} },
    });

    expect(extractEditedPaths(event)).toEqual(["src/example.ts"]);
  });

  it("continues an idle session once for warnings and until fixed for blocks", () => {
    const idle = normalizeOpenCodeEvent({
      event: "session.idle",
      session_id: "session-1",
      cwd: "/tmp/project",
    });

    expect(formatOpenCodeOutput(idle, warning).outcome).toBe("continue");
    expect(
      formatOpenCodeOutput({ ...idle, stopHookActive: true }, warning).outcome,
    ).toBe("allow");
    expect(
      formatOpenCodeOutput({ ...idle, stopHookActive: true }, blocked).outcome,
    ).toBe("continue");
  });

  it("installs a valid project plugin idempotently", async () => {
    const projectRoot = await temporaryDirectory();

    const first = await installOpenCodeHooks(projectRoot);
    const second = await installOpenCodeHooks(projectRoot);
    const source = await readFile(first.settingsPath, "utf8");

    expect(first.settingsPath).toBe(
      path.join(projectRoot, ".opencode", "plugins", "codecut.js"),
    );
    expect(first.addedEvents).toEqual(OPENCODE_HOOK_EVENTS);
    expect(second.addedEvents).toEqual([]);
    expect(await inspectOpenCodePlugin(first.settingsPath)).toEqual(
      OPENCODE_HOOK_EVENTS,
    );
    expect(source).toContain('Bun.spawn(');
    expect(source).toContain('client.session.promptAsync({');
    expect(source).toContain('join(directory, ".codecut", "runtime"');
    expect(
      spawnSync(process.execPath, ["--check", first.settingsPath], {
        encoding: "utf8",
      }).status,
    ).toBe(0);

    const health = await inspectAgentHooks(projectRoot, "opencode");
    expect(health.missingHookEvents).toEqual([]);

    await writeFile(
      first.settingsPath,
      source.replaceAll('"session.compacted"', '"session.compacted-disabled"'),
    );
    const incomplete = await inspectAgentHooks(projectRoot, "opencode");
    expect(incomplete.missingHookEvents).toEqual(["session.compacted"]);
  });

  it("bridges OpenCode hooks to the Codecut process and resumes idle sessions", async () => {
    const projectRoot = await temporaryDirectory();
    const installed = await installOpenCodeHooks(projectRoot);
    const payloads: Record<string, unknown>[] = [];
    const outputs = [
      { outcome: "allow" },
      { outcome: "continue", reason: "Run the local tests." },
    ];
    const previousBun = (globalThis as { Bun?: unknown }).Bun;
    (globalThis as { Bun?: unknown }).Bun = {
      spawn: () => {
        let input = "";
        return {
          stdin: {
            write: (value: string) => {
              input += value;
            },
            end: () => {
              payloads.push(JSON.parse(input) as Record<string, unknown>);
            },
          },
          stdout: JSON.stringify(outputs.shift()),
          stderr: "",
          exited: Promise.resolve(0),
        };
      },
    };

    const prompts: unknown[] = [];
    try {
      const module = (await import(
        /* @vite-ignore */
        `${pathToFileURL(installed.settingsPath).href}?test=${Date.now()}`
      )) as {
        CodecutPlugin: (input: {
          client: unknown;
          directory: string;
        }) => Promise<Record<string, (...args: unknown[]) => Promise<void>>>;
      };
      const plugin = await module.CodecutPlugin({
        directory: projectRoot,
        client: {
          app: { log: async () => undefined },
          session: {
            messages: async () => ({
              data: [
                {
                  info: { role: "assistant" },
                  parts: [{ type: "text", text: "Implementation complete." }],
                },
              ],
            }),
            promptAsync: async (input: unknown) => {
              prompts.push(input);
            },
          },
        },
      });

      await plugin["tool.execute.before"]?.(
        { sessionID: "session-1", tool: "bash", callID: "call-1" },
        { args: { command: "npm test" } },
      );
      await plugin.event?.({
        event: {
          type: "session.idle",
          properties: { sessionID: "session-1" },
        },
      });
    } finally {
      (globalThis as { Bun?: unknown }).Bun = previousBun;
    }

    expect(payloads).toEqual([
      expect.objectContaining({
        event: "tool.execute.before",
        session_id: "session-1",
        tool_input: { command: "npm test" },
        cwd: projectRoot,
      }),
      expect.objectContaining({
        event: "session.idle",
        session_id: "session-1",
        stop_hook_active: false,
        last_assistant_message: "Implementation complete.",
        cwd: projectRoot,
      }),
    ]);
    expect(prompts).toEqual([
      expect.objectContaining({
        path: { id: "session-1" },
        body: {
          parts: [
            {
              type: "text",
              text: "Run the local tests.",
              synthetic: true,
            },
          ],
        },
      }),
    ]);
  });

  it("installs a global plugin through XDG config for user rules", async () => {
    const home = await temporaryDirectory();
    const configHome = path.join(home, "config");
    const pluginPath = openCodePluginPath(home, {
      userLevel: true,
      environment: { XDG_CONFIG_HOME: configHome },
    });
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configHome;
    try {
      const installed = await installUserHooks("opencode", home);
      const source = await readFile(installed.settingsPath, "utf8");

      expect(installed.settingsPath).toBe(pluginPath);
      expect(source).toContain('process.env.CODECUT_BIN || "codecut"');
      expect(source).toContain('"opencode", "--user"');
      expect(source).not.toContain('join(directory, ".codecut", "runtime"');
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previous;
      }
    }
  });

  it("refuses to replace an unrelated plugin with the reserved filename", async () => {
    const projectRoot = await temporaryDirectory();
    const pluginPath = openCodePluginPath(projectRoot);
    await mkdir(path.dirname(pluginPath), { recursive: true });
    await writeFile(
      pluginPath,
      "export const CodecutPlugin = async () => ({})\n",
    );

    await expect(installOpenCodeHooks(projectRoot)).rejects.toThrow(
      "is not managed by Codecut",
    );
    expect(await readFile(pluginPath, "utf8")).toBe(
      "export const CodecutPlugin = async () => ({})\n",
    );
  });

  it("detects project plugins by lifecycle stage", async () => {
    const projectRoot = await temporaryDirectory();
    await installOpenCodeHooks(projectRoot);

    expect(await hasProjectHooks(projectRoot, "opencode")).toBe(true);
    expect(await hasProjectHooks(projectRoot, "opencode", "pre-tool")).toBe(
      true,
    );
    expect(await hasProjectHooks(projectRoot, "opencode", "stop")).toBe(true);
    expect(
      await hasProjectHooks(projectRoot, "opencode", "agent-response"),
    ).toBe(false);
  });
});
