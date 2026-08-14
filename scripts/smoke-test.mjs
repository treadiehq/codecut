import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

function hook(codecut, cwd, payload) {
  const output = run(
    codecut,
    ["hook", "--agent", "claude"],
    cwd,
    JSON.stringify(payload),
  );
  return JSON.parse(output);
}

try {
  fixture = await mkdtemp(
    path.join(os.tmpdir(), "codecut-smoke-"),
  );

  await writeFile(
    path.join(fixture, "package.json"),
    JSON.stringify({ name: "codecut-smoke-consumer", private: true }, null, 2),
  );
  await writeFile(
    path.join(fixture, "CLAUDE.md"),
    [
      "# Directives",
      "- Don't skip directives",
      "- Treat warnings as errors",
      "- All unit tests must pass",
      "- Favor high confidence changes with a low blast radius",
      "- Verify, don't assume",
      "- Use local machines for testing",
      "- Do not add comments that reference prompts, instructions, tickets, or temporary specification files",
    ].join("\n"),
  );

  const builtCli = process.env.CODECUT_SMOKE_BINARY
    ? path.resolve(repositoryRoot, process.env.CODECUT_SMOKE_BINARY)
    : path.join(repositoryRoot, "dist", "codecut.cjs");
  const initialSetup = run(
    builtCli,
    ["setup", "--agent", "claude", "--accept"],
    fixture,
  );
  assert(
    initialSetup.includes("Codecut is ready for claude."),
    "one-command setup did not report ready",
  );
  assert(initialSetup.includes("policy: created (7 rules)"), "setup policy failed");
  assert(initialSetup.includes("runtime: installed"), "runtime was not vendored");
  const codecut = path.join(
    fixture,
    ".codecut",
    "runtime",
    process.platform === "win32" ? "codecut.exe" : "codecut",
  );
  const repeatedSetup = run(
    codecut,
    ["setup", "--agent", "claude", "--accept"],
    fixture,
  );
  assert(
    repeatedSetup.includes("policy: preserved") &&
      repeatedSetup.includes("runtime: current"),
    "repeated setup was not idempotent",
  );

  const status = JSON.parse(
    run(codecut, ["status", "--agent", "claude", "--json"], fixture),
  );
  assert(status.hooksInstalled === true, "status did not find installed hooks");
  assert(status.rules.length === 7, "status did not report seven rules");

  const policyTest = JSON.parse(run(codecut, ["test", "--json"], fixture));
  assert(policyTest.passed === true, "policy simulation failed");

  const remote = hook(codecut, fixture, {
    hook_event_name: "PreToolUse",
    session_id: "smoke-session",
    cwd: fixture,
    timestamp: "2026-01-01T00:00:00.000Z",
    tool_name: "Bash",
    tool_input: { command: "ssh build-runner npm test" },
  });
  assert(
    remote.hookSpecificOutput?.permissionDecision === "deny",
    "remote test was not blocked before execution",
  );

  const badComment = hook(codecut, fixture, {
    hook_event_name: "PostToolUse",
    session_id: "comment-session",
    cwd: fixture,
    timestamp: "2026-01-01T00:00:00.500Z",
    tool_name: "Edit",
    tool_input: {
      file_path: "src/comment.ts",
      old_string: "const value = 1;",
      new_string:
        "// Per the AGENTS.md instructions, retain this code.\nconst value = 1;",
    },
    tool_response: "updated",
  });
  assert(
    badComment.hookSpecificOutput?.additionalContext?.includes(
      "new code comment",
    ),
    "transient-context comment was not flagged",
  );

  hook(codecut, fixture, {
    hook_event_name: "PostToolUse",
    session_id: "smoke-session",
    cwd: fixture,
    timestamp: "2026-01-01T00:00:01.000Z",
    tool_name: "Edit",
    tool_input: {
      file_path: "src/example.ts",
      old_string: "old",
      new_string: "new",
    },
    tool_response: "updated",
  });

  const missingTests = hook(codecut, fixture, {
    hook_event_name: "Stop",
    session_id: "smoke-session",
    cwd: fixture,
    timestamp: "2026-01-01T00:00:02.000Z",
    stop_hook_active: false,
    last_assistant_message: "Done",
  });
  assert(
    missingTests.decision === "block" &&
      missingTests.reason.includes("All unit tests must pass"),
    "completion without tests was not blocked",
  );

  hook(codecut, fixture, {
    hook_event_name: "PreToolUse",
    session_id: "smoke-session",
    cwd: fixture,
    timestamp: "2026-01-01T00:00:02.500Z",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });
  hook(codecut, fixture, {
    hook_event_name: "PostToolUse",
    session_id: "smoke-session",
    cwd: fixture,
    timestamp: "2026-01-01T00:00:03.000Z",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: "12 tests passed, 0 warnings",
  });

  const verified = hook(codecut, fixture, {
    hook_event_name: "Stop",
    session_id: "smoke-session",
    cwd: fixture,
    timestamp: "2026-01-01T00:00:04.000Z",
    stop_hook_active: true,
    last_assistant_message: "Tests pass.",
  });
  assert(
    verified.decision === undefined &&
      verified.systemMessage.includes("no issues"),
    "verified completion was not allowed",
  );

  hook(codecut, fixture, {
    hook_event_name: "PostToolUse",
    session_id: "acknowledgement-session",
    cwd: fixture,
    tool_name: "Edit",
    tool_input: {
      file_path: "src/large.ts",
      new_string: Array.from(
        { length: 501 },
        (_, index) => `export const value${index} = ${index};`,
      ).join("\n"),
    },
    tool_response: "updated",
  });
  hook(codecut, fixture, {
    hook_event_name: "PreToolUse",
    session_id: "acknowledgement-session",
    cwd: fixture,
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  });
  hook(codecut, fixture, {
    hook_event_name: "PostToolUse",
    session_id: "acknowledgement-session",
    cwd: fixture,
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_response: "30 tests passed, 0 warnings",
  });
  const largeStop = hook(codecut, fixture, {
    hook_event_name: "Stop",
    session_id: "acknowledgement-session",
    cwd: fixture,
    stop_hook_active: false,
  });
  assert(
    largeStop.hookSpecificOutput?.additionalContext?.includes(
      "low blast radius",
    ),
    "large diff warning was not delivered",
  );
  const acknowledgedStop = hook(codecut, fixture, {
    hook_event_name: "Stop",
    session_id: "acknowledgement-session",
    cwd: fixture,
    stop_hook_active: true,
    last_assistant_message:
      "The larger scope is intentional because this is the initial greenfield implementation.",
  });
  assert(
    acknowledgedStop.systemMessage?.includes("no issues"),
    "acknowledged large diff warning was repeated",
  );

  const events = await readFile(
    path.join(fixture, ".codecut", "events.jsonl"),
    "utf8",
  );
  assert(!events.includes("12 tests passed"), "raw tool output leaked to log");

  process.stdout.write(
    [
      "PASS one-command standalone setup",
      "PASS vendored runtime survives and setup is idempotent",
      "PASS directive discovery and hook installation",
      "PASS policy simulations",
      "PASS pre-tool remote test block",
      "PASS post-edit transient comment warning",
      "PASS stop gate without verification",
      "PASS verified completion",
      "PASS Claude blast-radius acknowledgement",
      "PASS derived-only local event log",
    ].join("\n") + "\n",
  );
} finally {
  if (fixture) {
    await rm(fixture, { recursive: true, force: true });
  }
}
