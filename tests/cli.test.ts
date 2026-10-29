import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionStartTime } from "../src/commands/hook.js";
import { compilePolicy } from "../src/core/compiler.js";
import { ensureLocalLogIgnored, writePolicy } from "../src/core/project.js";
import type { Receipt } from "../src/core/schema.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("setup defaults", () => {
  it("installs user-level Claude checks when no scope is given", async () => {
    const repositoryRoot = process.cwd();
    const home = await mkdtemp(
      path.join(repositoryRoot, ".codecut-cli-home-"),
    );
    temporaryDirectories.push(home);
    const configHome = path.join(home, "config");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repositoryRoot, "src", "cli.ts"),
        "setup",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: configHome,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("hooks (claude): installed");
    expect(result.stdout).toContain("policy: compiled (1 rules)");

    const settings = JSON.parse(
      await readFile(path.join(home, ".claude", "settings.json"), "utf8"),
    ) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(settings.hooks)).toContain("Stop");

    const policy = JSON.parse(
      await readFile(path.join(configHome, "codecut", "policy.json"), "utf8"),
    ) as { rules: Array<{ type: string; mode: string }> };
    expect(policy.rules).toEqual([
      expect.objectContaining({ type: "comment-quality", mode: "warn" }),
    ]);
  });
});

describe("hook error enforcement", () => {
  it("fails closed when a hook event cannot be normalized", () => {
    const repositoryRoot = process.cwd();
    const cases = [
      { agent: "claude", expected: { decision: "block" } },
      {
        agent: "cursor",
        expected: {
          followup_message: expect.stringContaining(
            "Codecut could not check this action",
          ),
        },
      },
      { agent: "devin", expected: { decision: "block" } },
      { agent: "opencode", expected: { outcome: "deny" } },
      { agent: "polytoken", expected: { outcome: "continue" } },
    ];

    for (const testCase of cases) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(repositoryRoot, "src", "cli.ts"),
          "hook",
          "--agent",
          testCase.agent,
        ],
        {
          cwd: repositoryRoot,
          input: "not valid JSON",
          encoding: "utf8",
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject(testCase.expected);
      expect(result.stderr).toContain("Codecut hook error");
    }
  });

  it("keeps stop hooks active when event state is malformed", async () => {
    const repositoryRoot = process.cwd();
    const projectRoot = await mkdtemp(
      path.join(repositoryRoot, ".codecut-hook-error-"),
    );
    temporaryDirectories.push(projectRoot);
    const codecutDirectory = path.join(projectRoot, ".codecut");
    await mkdir(codecutDirectory, { recursive: true });
    await writeFile(
      path.join(codecutDirectory, "policy.json"),
      await readFile(
        path.join(repositoryRoot, ".codecut", "policy.json"),
        "utf8",
      ),
    );
    await writeFile(
      path.join(codecutDirectory, "events.jsonl"),
      "not valid JSON\n",
    );

    const cases = [
      {
        agent: "claude",
        input: {
          hook_event_name: "Stop",
          session_id: "broken-state",
          cwd: projectRoot,
        },
        expected: { decision: "block" },
      },
      {
        agent: "cursor",
        input: {
          hook_event_name: "stop",
          conversation_id: "broken-state",
          cwd: projectRoot,
        },
        expected: {
          followup_message: expect.stringContaining("Event state is malformed"),
        },
      },
      {
        agent: "polytoken",
        input: {
          event: "stop",
          session_id: "broken-state",
          cwd: projectRoot,
        },
        expected: {
          outcome: "continue",
          reason: expect.stringContaining("Event state is malformed"),
        },
      },
      {
        agent: "devin",
        input: {
          hook_event_name: "Stop",
          session_id: "broken-state",
          cwd: projectRoot,
        },
        expected: {
          decision: "block",
          reason: expect.stringContaining("Event state is malformed"),
        },
      },
      {
        agent: "opencode",
        input: {
          event: "session.idle",
          session_id: "broken-state",
          cwd: projectRoot,
        },
        expected: {
          outcome: "continue",
          reason: expect.stringContaining("Event state is malformed"),
        },
      },
    ];

    for (const testCase of cases) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(repositoryRoot, "src", "cli.ts"),
          "hook",
          "--agent",
          testCase.agent,
        ],
        {
          cwd: repositoryRoot,
          input: JSON.stringify(testCase.input),
          encoding: "utf8",
          env: {
            ...process.env,
            XDG_CONFIG_HOME: path.join(projectRoot, "config"),
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject(testCase.expected);
      expect(result.stderr).toContain("Codecut hook error");
    }
  });

  it("enforces pre-tool rules despite another session's malformed state", async () => {
    const repositoryRoot = process.cwd();
    const projectRoot = await mkdtemp(
      path.join(repositoryRoot, ".codecut-cross-session-"),
    );
    temporaryDirectories.push(projectRoot);
    await writePolicy(
      projectRoot,
      compilePolicy({
        directives: [
          {
            text: "Use local machines for testing",
            source: {
              path: "AGENTS.md",
              line: 1,
              scope: "project",
              conditional: false,
            },
          },
        ],
        sources: ["AGENTS.md"],
        agent: "claude",
        acceptBlockingRules: true,
      }),
    );
    await writeFile(
      path.join(projectRoot, ".codecut", "events.jsonl"),
      '{"version":1,"id":"broken","timestamp":"2026-01-01T00:00:00.000Z","sessionId":"session-a"\n',
    );

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repositoryRoot, "src", "cli.ts"),
        "hook",
        "--agent",
        "claude",
      ],
      {
        cwd: repositoryRoot,
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "session-b",
          cwd: projectRoot,
          tool_name: "Bash",
          tool_input: { command: "ssh runner npm test" },
        }),
        encoding: "utf8",
        env: {
          ...process.env,
          XDG_CONFIG_HOME: path.join(projectRoot, "config"),
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(result.stderr).not.toContain("Codecut hook error");
  });
});

describe("generic agent hook protocol", () => {
  it("blocks a custom agent through the canonical JSON contract", async () => {
    const repositoryRoot = process.cwd();
    const projectRoot = await mkdtemp(
      path.join(repositoryRoot, ".codecut-generic-hook-"),
    );
    temporaryDirectories.push(projectRoot);
    await writePolicy(
      projectRoot,
      compilePolicy({
        directives: [
          {
            text: "Use local machines for testing",
            source: {
              path: "AGENTS.md",
              line: 1,
              scope: "project",
              conditional: false,
            },
          },
        ],
        sources: ["AGENTS.md"],
        agent: "unknown",
        acceptBlockingRules: true,
      }),
    );

    const runHook = (input: Record<string, unknown>) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(repositoryRoot, "src", "cli.ts"),
          "hook",
          "--agent",
          "generic",
        ],
        {
          cwd: repositoryRoot,
          input: JSON.stringify(input),
          encoding: "utf8",
          env: {
            ...process.env,
            XDG_CONFIG_HOME: path.join(projectRoot, "config"),
          },
        },
      );

    const blocked = runHook({
      protocol: "codecut.agent-hook",
      version: 1,
      event: "pre-tool",
      session_id: "custom-session",
      cwd: projectRoot,
      agent_name: "company-agent",
      tool: {
        name: "shell",
        call_id: "call-1",
        input: { command: "ssh runner npm test" },
      },
    });
    expect(blocked.status, blocked.stderr).toBe(0);
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      protocol: "codecut.agent-hook",
      version: 1,
      agent_name: "company-agent",
      action: "deny",
      outcome: "block",
      message: expect.stringContaining("Run the test locally"),
      violations: [
        expect.objectContaining({
          severity: "block",
          recovery: "Run the test locally instead.",
        }),
      ],
    });

    const invalid = runHook({
      protocol: "codecut.agent-hook",
      version: 2,
      event: "stop",
      session_id: "custom-session",
      cwd: projectRoot,
    });
    expect(invalid.status).toBe(0);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      protocol: "codecut.agent-hook",
      version: 1,
      action: "continue",
      outcome: "block",
      error: { code: "invalid-event" },
    });
    expect(invalid.stderr).toContain("Codecut hook error");
  });

  it("does not suppress the first stop warning after a pre-tool advisory", async () => {
    const repositoryRoot = process.cwd();
    const projectRoot = await mkdtemp(
      path.join(repositoryRoot, ".codecut-generic-advisory-"),
    );
    temporaryDirectories.push(projectRoot);
    await writeFile(
      path.join(projectRoot, "source.ts"),
      "export const changed = true;\n",
    );
    await writePolicy(
      projectRoot,
      compilePolicy({
        directives: [
          {
            text: "Use local machines for testing",
            source: {
              path: "AGENTS.md",
              line: 1,
              scope: "project",
              conditional: false,
            },
          },
        ],
        sources: ["AGENTS.md"],
        agent: "unknown",
        acceptBlockingRules: false,
      }),
    );

    const runHook = (input: Record<string, unknown>) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(repositoryRoot, "src", "cli.ts"),
          "hook",
          "--agent",
          "generic",
        ],
        {
          cwd: repositoryRoot,
          input: JSON.stringify(input),
          encoding: "utf8",
          env: {
            ...process.env,
            XDG_CONFIG_HOME: path.join(projectRoot, "config"),
          },
        },
      );
    const baseInput = {
      protocol: "codecut.agent-hook",
      version: 1,
      session_id: "advisory-session",
      cwd: projectRoot,
      agent_name: "company-agent",
    };

    const preTool = runHook({
      ...baseInput,
      event: "pre-tool",
      tool: {
        name: "shell",
        call_id: "call-1",
        input: { command: "ssh runner npm test" },
      },
    });
    expect(preTool.status, preTool.stderr).toBe(0);
    expect(JSON.parse(preTool.stdout)).toMatchObject({
      action: "allow",
      outcome: "warn",
      message: expect.stringContaining("Run the test locally"),
    });

    const firstStop = runHook({ ...baseInput, event: "stop" });
    expect(firstStop.status, firstStop.stderr).toBe(0);
    expect(JSON.parse(firstStop.stdout)).toMatchObject({
      action: "continue",
      outcome: "warn",
      message: expect.stringContaining("Run the relevant tests locally"),
    });

    const repeatedStop = runHook({ ...baseInput, event: "stop" });
    expect(repeatedStop.status, repeatedStop.stderr).toBe(0);
    expect(JSON.parse(repeatedStop.stdout)).toMatchObject({
      action: "stop",
      outcome: "warn",
    });
  });

  it("prints machine-readable generic protocol schemas", () => {
    const repositoryRoot = process.cwd();
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repositoryRoot, "src", "cli.ts"),
        "hook",
        "--agent",
        "generic",
        "--schema",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      protocol: "codecut.agent-hook",
      version: 1,
      inputSchema: {
        title: "Codecut generic agent hook input",
      },
      outputSchema: {
        title: "Codecut generic agent hook output",
      },
    });
  });

  it("returns stop when no policy requires more work", async () => {
    const repositoryRoot = process.cwd();
    const projectRoot = await mkdtemp(
      path.join(repositoryRoot, ".codecut-generic-empty-"),
    );
    temporaryDirectories.push(projectRoot);
    await writePolicy(projectRoot, {
      ...compilePolicy({
        directives: [],
        sources: [],
        agent: "unknown",
        acceptBlockingRules: true,
      }),
      rules: [],
    });
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repositoryRoot, "src", "cli.ts"),
        "hook",
        "--agent",
        "generic",
      ],
      {
        cwd: repositoryRoot,
        input: JSON.stringify({
          protocol: "codecut.agent-hook",
          version: 1,
          event: "stop",
          session_id: "custom-session",
          cwd: projectRoot,
        }),
        encoding: "utf8",
        env: {
          ...process.env,
          XDG_CONFIG_HOME: path.join(projectRoot, "config"),
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: "stop",
      outcome: "allow",
    });
  });

  it("continues once for a stop warning without looping forever", async () => {
    const repositoryRoot = process.cwd();
    const projectRoot = await mkdtemp(
      path.join(repositoryRoot, ".codecut-generic-warning-"),
    );
    temporaryDirectories.push(projectRoot);
    const policy = compilePolicy({
      directives: [],
      sources: [],
      agent: "unknown",
      acceptBlockingRules: true,
    });
    await writePolicy(projectRoot, {
      ...policy,
      rules: policy.rules.filter(
        (rule) => rule.type === "verification-evidence",
      ),
    });
    const runStop = () =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(repositoryRoot, "src", "cli.ts"),
          "hook",
          "--agent",
          "generic",
        ],
        {
          cwd: repositoryRoot,
          input: JSON.stringify({
            protocol: "codecut.agent-hook",
            version: 1,
            event: "stop",
            session_id: "warning-session",
            cwd: projectRoot,
          }),
          encoding: "utf8",
          env: {
            ...process.env,
            XDG_CONFIG_HOME: path.join(projectRoot, "config"),
          },
        },
      );

    const first = runStop();
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      action: "continue",
      outcome: "warn",
    });

    const repeated = runStop();
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      action: "stop",
      outcome: "warn",
    });
  });

  it("delivers a Devin stop warning first raised while the stop hook was active", async () => {
    const repositoryRoot = process.cwd();
    const projectRoot = await mkdtemp(
      path.join(repositoryRoot, ".codecut-devin-stop-warning-"),
    );
    temporaryDirectories.push(projectRoot);
    const policy = compilePolicy({
      directives: [],
      sources: [],
      agent: "devin",
      acceptBlockingRules: true,
    });
    await writePolicy(projectRoot, {
      ...policy,
      rules: policy.rules.filter(
        (rule) => rule.type === "verification-evidence",
      ),
    });
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await writeFile(
      path.join(projectRoot, "src", "example.ts"),
      "export const example = true;\n",
    );
    const runStop = (stopHookActive: boolean) => {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(repositoryRoot, "src", "cli.ts"),
          "hook",
          "--agent",
          "devin",
        ],
        {
          cwd: repositoryRoot,
          input: JSON.stringify({
            hook_event_name: "Stop",
            session_id: "devin-stop-warning",
            cwd: projectRoot,
            stop_hook_active: stopHookActive,
          }),
          encoding: "utf8",
          env: {
            ...process.env,
            XDG_CONFIG_HOME: path.join(projectRoot, "config"),
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };

    expect(runStop(true)).toEqual({});
    expect(runStop(false)).toEqual({
      decision: "block",
      reason: expect.stringContaining("Verify"),
    });
    expect(runStop(false)).toEqual({});
  });

  it("starts the session at its first pre-tool receipt, not a stop decision", () => {
    const receipt = (kind: Receipt["kind"], timestamp: string): Receipt => ({
      version: 1,
      id: `${kind}-${timestamp}`,
      timestamp,
      sessionId: "session-1",
      kind,
    });

    expect(
      sessionStartTime([
        receipt("decision", "2026-01-01T00:00:01.000Z"),
        receipt("decision", "2026-01-01T00:00:05.000Z"),
      ]),
    ).toBeUndefined();
    expect(
      sessionStartTime([
        receipt("decision", "2026-01-01T00:00:01.000Z"),
        receipt("command-start", "2026-01-01T00:00:03.000Z"),
        receipt("tool-start", "2026-01-01T00:00:02.000Z"),
        receipt("edit", "2026-01-01T00:00:04.000Z"),
      ]),
    ).toEqual(new Date("2026-01-01T00:00:02.000Z"));
  });

  it("does not charge a session for deletions it inherited", async () => {
    const repositoryRoot = process.cwd();
    // Outside this repository, so only the fixture's own Git state counts.
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "codecut-inherited-deletion-"),
    );
    temporaryDirectories.push(projectRoot);
    const git = (...args: string[]) =>
      spawnSync(
        "git",
        [
          "-c",
          "user.name=Codecut Test",
          "-c",
          "user.email=codecut@example.com",
          ...args,
        ],
        { cwd: projectRoot, encoding: "utf8" },
      );
    expect(git("init", "--quiet").status).toBe(0);
    await writePolicy(projectRoot, {
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      agents: ["claude"],
      sources: ["CLAUDE.md"],
      rules: [
        {
          id: "blast-radius-small",
          type: "blast-radius",
          directive: "Keep changes small",
          source: { path: "CLAUDE.md", scope: "project", conditional: false },
          mode: "warn",
          confirmed: true,
          enabled: true,
          maxFiles: 5,
          maxChangedLines: 5,
        },
      ],
    });
    await ensureLocalLogIgnored(projectRoot);
    await writeFile(path.join(projectRoot, "inherited.txt"), "line\n".repeat(10));
    await writeFile(path.join(projectRoot, "session.txt"), "line\n".repeat(8));
    expect(git("add", ".").status).toBe(0);
    expect(git("commit", "--quiet", "-m", "initial").status).toBe(0);
    await rm(path.join(projectRoot, "inherited.txt"));

    const runHook = (input: Record<string, unknown>) => {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(repositoryRoot, "src", "cli.ts"),
          "hook",
          "--agent",
          "claude",
        ],
        {
          cwd: repositoryRoot,
          input: JSON.stringify({
            session_id: "inherited-deletion",
            cwd: projectRoot,
            ...input,
          }),
          encoding: "utf8",
          env: {
            ...process.env,
            XDG_CONFIG_HOME: path.join(projectRoot, "config"),
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      return JSON.stringify(JSON.parse(result.stdout));
    };
    const stop = { hook_event_name: "Stop", stop_hook_active: false };

    runHook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    expect(runHook(stop)).not.toContain("Keep changes small");

    await rm(path.join(projectRoot, "session.txt"));
    expect(runHook(stop)).toContain("Keep changes small");
  });

  it("does not make generic a native setup target", () => {
    const repositoryRoot = process.cwd();
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repositoryRoot, "src", "cli.ts"),
        "status",
        "--agent",
        "generic",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsupported agent");
    expect(result.stderr).not.toContain("generic,");
  });
});

describe("GitHub PR completion gate", () => {
  it("asks Cursor to mark a draft PR ready before completion", async () => {
    const repositoryRoot = process.cwd();
    const projectRoot = await mkdtemp(
      path.join(repositoryRoot, ".codecut-ready-pr-"),
    );
    const fakeBin = await mkdtemp(path.join(repositoryRoot, ".codecut-bin-"));
    temporaryDirectories.push(projectRoot, fakeBin);
    await writeFile(
      path.join(projectRoot, "example.ts"),
      "export const example = true;\n",
    );
    const git = (args: string[]) =>
      spawnSync("git", args, {
        cwd: projectRoot,
        encoding: "utf8",
      });
    expect(
      git(["init", "--quiet", "--initial-branch", "feature/example"]).status,
    ).toBe(0);
    expect(git(["add", "example.ts"]).status).toBe(0);
    expect(
      git([
        "-c",
        "user.name=Codecut Test",
        "-c",
        "user.email=codecut@example.com",
        "commit",
        "--quiet",
        "-m",
        "initial",
      ]).status,
    ).toBe(0);
    const head = git(["rev-parse", "HEAD"]).stdout.trim();

    await writePolicy(
      projectRoot,
      compilePolicy({
        directives: [
          {
            text: "Open a non-draft PR",
            source: {
              path: "AGENTS.md",
              line: 1,
              scope: "project",
              conditional: false,
            },
          },
        ],
        sources: ["AGENTS.md"],
        agent: "cursor",
        acceptBlockingRules: true,
      }),
    );

    const fakeGh = path.join(fakeBin, "gh");
    await writeFile(
      fakeGh,
      [
        "#!/usr/bin/env node",
        "const isDraft = process.env.FAKE_GH_DRAFT === '1';",
        "const headRefOid = process.env.FAKE_GH_HEAD;",
        "console.log(JSON.stringify([{",
        "  isDraft,",
        "  headRefOid,",
        "  url: 'https://github.com/example/repository/pull/42'",
        "}]));",
        "",
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);

    const runHook = (draft: boolean) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(repositoryRoot, "src", "cli.ts"),
          "hook",
          "--agent",
          "cursor",
        ],
        {
          cwd: repositoryRoot,
          input: JSON.stringify({
            hook_event_name: "stop",
            conversation_id: "ready-pr",
            cwd: projectRoot,
            loop_count: 0,
            status: "completed",
          }),
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
            FAKE_GH_DRAFT: draft ? "1" : "0",
            FAKE_GH_HEAD: head,
            XDG_CONFIG_HOME: path.join(projectRoot, "config"),
          },
        },
      );

    const draft = runHook(true);
    expect(draft.status, draft.stderr).toBe(0);
    expect(JSON.parse(draft.stdout)).toMatchObject({
      followup_message: expect.stringContaining("gh pr ready"),
    });

    const ready = runHook(false);
    expect(ready.status, ready.stderr).toBe(0);
    expect(JSON.parse(ready.stdout)).toEqual({});
  });
});

describe("pre-push lint gate", () => {
  it("blocks a push with deterministic findings and allows the fixed diff", async () => {
    const repositoryRoot = process.cwd();
    const projectRoot = await mkdtemp(
      path.join(repositoryRoot, ".codecut-clean-push-"),
    );
    const remoteRoot = await mkdtemp(
      path.join(repositoryRoot, ".codecut-clean-push-remote-"),
    );
    temporaryDirectories.push(projectRoot, remoteRoot);
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await writeFile(
      path.join(projectRoot, "src", "example.ts"),
      "export const example = true;\n",
    );

    const git = (args: string[], cwd = projectRoot) =>
      spawnSync("git", args, { cwd, encoding: "utf8" });
    expect(
      git(["init", "--quiet", "--initial-branch", "main"], projectRoot).status,
    ).toBe(0);
    expect(git(["init", "--bare", "--quiet"], remoteRoot).status).toBe(0);
    expect(git(["add", "src/example.ts"]).status).toBe(0);
    expect(
      git([
        "-c",
        "user.name=Codecut Test",
        "-c",
        "user.email=codecut@example.com",
        "commit",
        "--quiet",
        "-m",
        "initial",
      ]).status,
    ).toBe(0);
    expect(git(["remote", "add", "origin", remoteRoot]).status).toBe(0);
    expect(git(["push", "--quiet", "-u", "origin", "main"]).status).toBe(0);

    await writePolicy(
      projectRoot,
      compilePolicy({
        directives: [
          {
            text: "Require clean Codecut lint for git push",
            source: {
              path: "AGENTS.md",
              line: 1,
              scope: "project",
              conditional: false,
            },
          },
        ],
        sources: ["AGENTS.md"],
        agent: "cursor",
        acceptBlockingRules: true,
      }),
    );
    await writeFile(
      path.join(projectRoot, "src", "example.ts"),
      'export const example = true;\nconsole.log("debug");\n',
    );
    expect(git(["add", ".codecut/policy.json", "src/example.ts"]).status).toBe(0);
    expect(
      git([
        "-c",
        "user.name=Codecut Test",
        "-c",
        "user.email=codecut@example.com",
        "commit",
        "--quiet",
        "-m",
        "add debug change",
      ]).status,
    ).toBe(0);

    const runHook = () =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(repositoryRoot, "src", "cli.ts"),
          "hook",
          "--agent",
          "cursor",
        ],
        {
          cwd: repositoryRoot,
          input: JSON.stringify({
            hook_event_name: "preToolUse",
            conversation_id: "clean-push",
            cwd: projectRoot,
            tool_name: "Shell",
            tool_input: { command: "git push" },
          }),
          encoding: "utf8",
          env: {
            ...process.env,
            XDG_CONFIG_HOME: path.join(projectRoot, "config"),
          },
        },
      );

    const blocked = runHook();
    expect(blocked.status, blocked.stderr).toBe(0);
    expect(JSON.parse(blocked.stdout)).toMatchObject({
      permission: "deny",
      agent_message: expect.stringContaining("src/example.ts:2"),
    });

    await writeFile(
      path.join(projectRoot, "src", "example.ts"),
      "export const example = true;\n",
    );
    expect(git(["add", "src/example.ts"]).status).toBe(0);
    expect(
      git([
        "-c",
        "user.name=Codecut Test",
        "-c",
        "user.email=codecut@example.com",
        "commit",
        "--quiet",
        "-m",
        "remove debug change",
      ]).status,
    ).toBe(0);

    const allowed = runHook();
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(JSON.parse(allowed.stdout)).toEqual({ permission: "allow" });
  });

  it("delivers a Devin pre-push warning once, after the push", async () => {
    const repositoryRoot = process.cwd();
    // Outside this repository, so the push cannot be inspected.
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "codecut-devin-push-"),
    );
    temporaryDirectories.push(projectRoot);
    await writePolicy(
      projectRoot,
      compilePolicy({
        directives: [
          {
            text: "Require clean Codecut lint for git push",
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
        acceptBlockingRules: true,
      }),
    );

    const runHook = (input: Record<string, unknown>) => {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(repositoryRoot, "src", "cli.ts"),
          "hook",
          "--agent",
          "devin",
        ],
        {
          cwd: repositoryRoot,
          input: JSON.stringify({
            session_id: "devin-push",
            cwd: projectRoot,
            tool_name: "exec",
            tool_input: { command: "git push" },
            ...input,
          }),
          encoding: "utf8",
          env: {
            ...process.env,
            XDG_CONFIG_HOME: path.join(projectRoot, "config"),
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    const postToolUse = {
      hook_event_name: "PostToolUse",
      tool_response: { success: false, output: "", error: "not a repo" },
    };

    expect(runHook({ hook_event_name: "PreToolUse" })).toEqual({});
    expect(runHook(postToolUse)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: expect.stringContaining(
          "not a Git repository",
        ),
      },
    });
    expect(runHook(postToolUse)).toEqual({});
  });
});

describe("command state tracking", () => {
  it("links post-tool receipts to their pre-tool working state", async () => {
    const repositoryRoot = process.cwd();
    const projectRoot = await mkdtemp(
      path.join(repositoryRoot, ".codecut-command-state-"),
    );
    temporaryDirectories.push(projectRoot);
    const codecutDirectory = path.join(projectRoot, ".codecut");
    await mkdir(codecutDirectory, { recursive: true });
    await writeFile(
      path.join(codecutDirectory, "policy.json"),
      await readFile(
        path.join(repositoryRoot, ".codecut", "policy.json"),
        "utf8",
      ),
    );
    const runHook = (hookEventName: string, toolOutput?: unknown) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(repositoryRoot, "src", "cli.ts"),
          "hook",
          "--agent",
          "cursor",
        ],
        {
          cwd: repositoryRoot,
          input: JSON.stringify({
            hook_event_name: hookEventName,
            conversation_id: "command-state",
            cwd: projectRoot,
            tool_name: "Shell",
            tool_input: { command: "npm test" },
            ...(toolOutput === undefined ? {} : { tool_output: toolOutput }),
          }),
          encoding: "utf8",
          env: {
            ...process.env,
            XDG_CONFIG_HOME: path.join(projectRoot, "config"),
          },
        },
      );

    expect(runHook("preToolUse").status).toBe(0);
    expect(
      runHook("postToolUse", {
        exitCode: 0,
        stdout: "5 tests passed",
      }).status,
    ).toBe(0);
    expect(runHook("preToolUse").status).toBe(0);
    expect(runHook("preToolUse").status).toBe(0);
    expect(
      runHook("postToolUse", {
        exitCode: 0,
        stdout: "5 tests passed",
      }).status,
    ).toBe(0);

    const receipts = (
      await readFile(path.join(codecutDirectory, "events.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const start = receipts.find(
      (receipt) => receipt.kind === "command-start",
    );
    const completions = receipts.filter(
      (receipt) => receipt.kind === "command",
    );
    const completed = completions[0];

    expect(start?.stateFingerprint).toMatch(/^sha256:/);
    expect(completed?.stateBeforeFingerprint).toBe(
      start?.stateFingerprint,
    );
    expect(completed?.stateFingerprint).toBe(start?.stateFingerprint);
    expect(completions[1]?.stateBeforeFingerprint).toBeUndefined();
  });
});
