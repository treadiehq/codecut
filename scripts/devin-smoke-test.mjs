import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repositoryRoot = process.cwd();
let fixture;

function run(command, args, cwd, input, environment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, ...environment },
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
      ["hook", "--agent", "devin"],
      cwd,
      JSON.stringify(payload),
      { DEVIN_PROJECT_DIR: cwd },
    ),
  );
}

try {
  fixture = await mkdtemp(path.join(os.tmpdir(), "codecut-devin-smoke-"));
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
    ["setup", "--agent", "devin", "--accept"],
    fixture,
  );
  assert(
    setup.includes("Codecut is ready for devin."),
    "native Devin setup did not report ready",
  );

  const runtime = path.join(
    fixture,
    ".codecut",
    "runtime",
    process.platform === "win32" ? "codecut.exe" : "codecut",
  );
  const hooks = JSON.parse(
    await readFile(path.join(fixture, ".devin", "hooks.v1.json"), "utf8"),
  );
  for (const event of [
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "PostCompaction",
  ]) {
    assert(hooks[event]?.length === 1, `${event} hook missing`);
  }

  const remote = hook(runtime, fixture, {
    hook_event_name: "PreToolUse",
    session_id: "devin-smoke",
    prompt_id: "prompt-1",
    tool_name: "exec",
    tool_input: { command: "ssh runner npm test" },
  });
  assert(
    remote.decision === "block" &&
      remote.reason?.includes("Use local machines for testing"),
    "Devin remote test was not blocked",
  );

  hook(runtime, fixture, {
    hook_event_name: "PostToolUse",
    session_id: "devin-completion",
    prompt_id: "prompt-2",
    tool_name: "write",
    tool_input: {
      file_path: "src/example.ts",
      content: "export const value = 1;",
    },
    tool_response: { success: true, output: "Done", error: null },
  });
  const blockedStop = hook(runtime, fixture, {
    hook_event_name: "Stop",
    session_id: "devin-completion",
    prompt_id: "prompt-2",
    stop_hook_active: false,
  });
  assert(
    blockedStop.decision === "block" &&
      blockedStop.reason?.includes("All unit tests must pass"),
    "Devin stop did not continue for missing tests",
  );

  hook(runtime, fixture, {
    hook_event_name: "PreToolUse",
    session_id: "devin-completion",
    prompt_id: "prompt-2",
    tool_name: "exec",
    tool_input: { command: "npm test" },
  });
  hook(runtime, fixture, {
    hook_event_name: "PostToolUse",
    session_id: "devin-completion",
    prompt_id: "prompt-2",
    tool_name: "exec",
    tool_input: { command: "npm test" },
    tool_response: {
      success: true,
      output: "30 tests passed, 0 warnings",
      error: null,
    },
  });
  const allowedStop = hook(runtime, fixture, {
    hook_event_name: "Stop",
    session_id: "devin-completion",
    prompt_id: "prompt-2",
    stop_hook_active: true,
  });
  assert(
    allowedStop.decision === undefined,
    "Devin stop did not allow verified completion",
  );

  const reset = hook(runtime, fixture, {
    hook_event_name: "PostCompaction",
    session_id: "devin-completion",
    prompt_id: "prompt-2",
    summary: "Compacted context",
  });
  assert(
    Object.keys(reset).length === 0,
    "Devin compaction hook returned unsupported output",
  );

  process.stdout.write(
    [
      "PASS native Devin one-command setup",
      "PASS native Devin hook configuration",
      "PASS Devin pre-tool denial",
      "PASS Devin stop recovery and verified completion",
      "PASS Devin compaction reset",
    ].join("\n") + "\n",
  );
} finally {
  if (fixture) {
    await rm(fixture, { recursive: true, force: true });
  }
}
