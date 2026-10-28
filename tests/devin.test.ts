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
import { compilePolicy } from "../src/core/compiler.js";
import { evaluatePolicy } from "../src/core/engine.js";
import { decisionReceipt } from "../src/core/events.js";
import type { PushLintEvidence } from "../src/core/push.js";
import type { PolicyDecision, Receipt } from "../src/core/schema.js";
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

  it("reads project hooks from the top level beside a stray hooks object", async () => {
    const projectRoot = await temporaryDirectory();
    const settingsPath = path.join(projectRoot, ".devin", "hooks.v1.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { hooks: [{ type: "command", command: "echo unrelated" }] },
          ],
        },
      }),
    );

    await installDevinHooks(projectRoot);
    expect(
      (await inspectAgentHooks(projectRoot, "devin")).missingHookEvents,
    ).toEqual([]);
    expect(await hasProjectHooks(projectRoot, "devin", "stop")).toBe(true);

    const installed = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      settingsPath,
      JSON.stringify({
        hooks: Object.fromEntries(
          DEVIN_HOOK_EVENTS.map((event) => [event, installed[event]]),
        ),
      }),
    );
    expect(
      (await inspectAgentHooks(projectRoot, "devin")).missingHookEvents,
    ).toEqual(DEVIN_HOOK_EVENTS);
    expect(await hasProjectHooks(projectRoot, "devin", "stop")).toBe(false);
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

describe("Devin pre-push warnings", () => {
  const findings: PushLintEvidence = {
    status: "findings",
    branch: "main",
    base: "origin/main",
    range: "origin/main..HEAD",
    files: 1,
    findings: [
      {
        check: "comment-quality",
        path: "src/example.ts",
        line: 1,
        message: "todo",
      },
    ],
  };
  const cases: Array<{
    accept: boolean;
    evidence: PushLintEvidence;
    text: string;
  }> = [
    { accept: false, evidence: findings, text: "src/example.ts:1: todo" },
    {
      accept: false,
      evidence: { status: "unverified", reason: "no-base" },
      text: "could not find a local remote-tracking branch",
    },
    {
      accept: true,
      evidence: { status: "unverified", reason: "no-base" },
      text: "could not find a local remote-tracking branch",
    },
    {
      accept: true,
      evidence: { status: "unverified", reason: "git-error" },
      text: "could not run the Git diff",
    },
  ];
  const policy = (accept: boolean) =>
    compilePolicy({
      directives: [
        {
          text: "Push only lint-clean branches",
          source: {
            path: "AGENTS.md",
            line: 1,
            scope: "project",
            conditional: false,
          },
        },
      ],
      sources: ["AGENTS.md"],
      agent: "devin",
      acceptBlockingRules: accept,
    });
  const event = (input: Record<string, unknown>) =>
    normalizeDevinEvent({
      session_id: "session-1",
      cwd: "/tmp/project",
      ...input,
    });
  const push = {
    tool_name: "exec",
    tool_input: { command: "git push" },
  };

  for (const { accept, evidence, text } of cases) {
    const label = `accept=${accept} ${evidence.status}${
      evidence.status === "unverified" ? `/${evidence.reason}` : ""
    }`;

    it(`delivers a ${label} warning after the push`, () => {
      const compiled = policy(accept);
      expect(compiled.rules[0]).toMatchObject({
        type: "require-clean-push",
        mode: "block",
        confirmed: accept,
      });

      const preTool = event({ hook_event_name: "PreToolUse", ...push });
      const preDecision = evaluatePolicy({
        policy: compiled,
        event: preTool,
        receipts: [],
        pushLintEvidence: evidence,
      });
      expect(preDecision.outcome).toBe("warn");
      expect(formatDevinOutput(preTool, preDecision)).toEqual({});
      const receipts: Receipt[] = [
        decisionReceipt(preTool, preDecision, new Date(), false),
      ];

      const postTool = event({
        hook_event_name: "PostToolUse",
        ...push,
        tool_response: { success: true, output: "", error: null },
      });
      const postDecision = evaluatePolicy({
        policy: compiled,
        event: postTool,
        receipts,
      });
      expect(formatDevinOutput(postTool, postDecision)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: expect.stringContaining(text),
        },
      });

      receipts.push(decisionReceipt(postTool, postDecision, new Date(), true));
      expect(
        evaluatePolicy({ policy: compiled, event: postTool, receipts })
          .outcome,
      ).toBe("allow");
    });

    it(`delivers a ${label} warning at stop when no post-tool event arrives`, () => {
      const compiled = policy(accept);
      const preTool = event({ hook_event_name: "PreToolUse", ...push });
      const preDecision = evaluatePolicy({
        policy: compiled,
        event: preTool,
        receipts: [],
        pushLintEvidence: evidence,
      });
      const stop = event({
        hook_event_name: "Stop",
        stop_hook_active: false,
      });
      const stopDecision = evaluatePolicy({
        policy: compiled,
        event: stop,
        receipts: [decisionReceipt(preTool, preDecision, new Date(), false)],
      });

      expect(formatDevinOutput(stop, stopDecision)).toEqual({
        decision: "block",
        reason: expect.stringContaining(text),
      });
    });
  }
});
