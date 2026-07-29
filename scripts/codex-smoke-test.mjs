import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repositoryRoot = process.cwd();
let fixture;

function run(command, args, cwd, input) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function hook(runtime, cwd, payload) {
  return JSON.parse(
    run(
      runtime,
      ["hook", "--agent", "codex"],
      cwd,
      JSON.stringify(payload),
    ),
  );
}

try {
  fixture = await mkdtemp(path.join(os.tmpdir(), "codecut-codex-smoke-"));
  await writeFile(
    path.join(fixture, "AGENTS.md"),
    [
      "# Directives",
      "- All unit tests must pass",
      "- Verify, don't assume",
      "- Use local machines for testing",
    ].join("\n"),
  );

  const bundle = process.env.CODECUT_SMOKE_BINARY
    ? path.resolve(repositoryRoot, process.env.CODECUT_SMOKE_BINARY)
    : path.join(repositoryRoot, "dist", "codecut.cjs");
  const setup = run(
    bundle,
    ["setup", "--agent", "codex", "--accept"],
    fixture,
  );
  assert(
    setup.includes("Codecut is ready for codex."),
    "native Codex setup did not report ready",
  );
  const runtime = path.join(
    fixture,
    ".codecut",
    "runtime",
    process.platform === "win32" ? "codecut.exe" : "codecut",
  );
  const hooks = JSON.parse(
    await readFile(path.join(fixture, ".codex", "hooks.json"), "utf8"),
  );
  assert(hooks.hooks?.PreToolUse?.length === 1, "PreToolUse hook missing");
  assert(hooks.hooks?.PostToolUse?.length === 1, "PostToolUse hook missing");
  assert(hooks.hooks?.Stop?.length === 1, "Stop hook missing");

  const remote = hook(runtime, fixture, {
    hook_event_name: "PreToolUse",
    session_id: "codex-smoke",
    cwd: fixture,
    tool_name: "Bash",
    tool_input: { command: "ssh runner npm test" },
  });
  assert(
    remote.hookSpecificOutput?.permissionDecision === "deny",
    "Codex remote test was not denied",
  );

  hook(runtime, fixture, {
    hook_event_name: "PostToolUse",
    session_id: "codex-completion",
    cwd: fixture,
    tool_name: "apply_patch",
    tool_input: {
      command:
        "*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch",
    },
    tool_response: "Done!",
  });
  const blockedStop = hook(runtime, fixture, {
    hook_event_name: "Stop",
    session_id: "codex-completion",
    cwd: fixture,
    stop_hook_active: false,
    last_assistant_message: "Implementation complete.",
  });
  assert(
    blockedStop.decision === "block" &&
      blockedStop.reason?.includes("All unit tests must pass"),
    "Codex stop did not continue for missing tests",
  );

  hook(runtime, fixture, {
    hook_event_name: "PostToolUse",
    session_id: "codex-completion",
    cwd: fixture,
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: "30 tests passed, 0 warnings",
  });
  const allowedStop = hook(runtime, fixture, {
    hook_event_name: "Stop",
    session_id: "codex-completion",
    cwd: fixture,
    stop_hook_active: true,
    last_assistant_message: "Tests pass.",
  });
  assert(
    allowedStop.decision === undefined &&
      allowedStop.systemMessage?.includes("no issues"),
    "Codex stop did not allow verified completion",
  );

  process.stdout.write(
    [
      "PASS native Codex one-command setup",
      "PASS native Codex hook configuration",
      "PASS Codex pre-tool denial",
      "PASS Codex stop recovery and verified completion",
    ].join("\n") + "\n",
  );
} finally {
  if (fixture) {
    await rm(fixture, { recursive: true, force: true });
  }
}
