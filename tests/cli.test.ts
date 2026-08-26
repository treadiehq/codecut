import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compilePolicy } from "../src/core/compiler.js";
import { writePolicy } from "../src/core/project.js";

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
