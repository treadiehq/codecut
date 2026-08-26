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
      ["hook", "--agent", "opencode"],
      cwd,
      JSON.stringify(payload),
    ),
  );
}

try {
  fixture = await mkdtemp(path.join(os.tmpdir(), "codecut-opencode-smoke-"));
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
    ["setup", "--agent", "opencode", "--accept"],
    fixture,
  );
  assert(
    setup.includes("Codecut is ready for opencode."),
    "native OpenCode setup did not report ready",
  );

  const runtime = path.join(
    fixture,
    ".codecut",
    "runtime",
    process.platform === "win32" ? "codecut.exe" : "codecut",
  );
  const plugin = await readFile(
    path.join(fixture, ".opencode", "plugins", "codecut.js"),
    "utf8",
  );
  for (const event of [
    "tool.execute.before",
    "tool.execute.after",
    "session.idle",
    "session.compacted",
  ]) {
    assert(plugin.includes(`"${event}"`), `${event} plugin hook missing`);
  }
  assert(
    plugin.includes("client.session.promptAsync"),
    "OpenCode idle recovery prompt missing",
  );

  const remote = hook(runtime, fixture, {
    event: "tool.execute.before",
    session_id: "opencode-smoke",
    cwd: fixture,
    tool_name: "bash",
    call_id: "remote-call",
    tool_input: { command: "ssh runner npm test" },
  });
  assert(
    remote.outcome === "deny" &&
      remote.reason?.includes("Use local machines for testing"),
    "OpenCode remote test was not denied",
  );

  hook(runtime, fixture, {
    event: "tool.execute.after",
    session_id: "opencode-completion",
    cwd: fixture,
    tool_name: "write",
    call_id: "edit-call",
    tool_input: {
      filePath: "src/example.ts",
      content: "export const value = 1;",
    },
    tool_output: {
      title: "Write src/example.ts",
      output: "Done",
      metadata: {},
    },
  });
  const blockedStop = hook(runtime, fixture, {
    event: "session.idle",
    session_id: "opencode-completion",
    cwd: fixture,
    stop_hook_active: false,
    last_assistant_message: "Implementation complete.",
  });
  assert(
    blockedStop.outcome === "continue" &&
      blockedStop.reason?.includes("All unit tests must pass"),
    "OpenCode idle hook did not continue for missing tests",
  );

  hook(runtime, fixture, {
    event: "tool.execute.before",
    session_id: "opencode-completion",
    cwd: fixture,
    tool_name: "bash",
    call_id: "test-call",
    tool_input: { command: "npm test" },
  });
  hook(runtime, fixture, {
    event: "tool.execute.after",
    session_id: "opencode-completion",
    cwd: fixture,
    tool_name: "bash",
    call_id: "test-call",
    tool_input: { command: "npm test" },
    tool_output: {
      title: "npm test",
      output: "30 tests passed, 0 warnings",
      metadata: { exit: 0, truncated: false },
    },
  });
  const allowedStop = hook(runtime, fixture, {
    event: "session.idle",
    session_id: "opencode-completion",
    cwd: fixture,
    stop_hook_active: true,
    last_assistant_message: "Tests pass.",
  });
  assert(
    allowedStop.outcome === "allow",
    "OpenCode idle hook did not allow verified completion",
  );

  process.stdout.write(
    [
      "PASS native OpenCode one-command setup",
      "PASS native OpenCode plugin configuration",
      "PASS OpenCode pre-tool denial",
      "PASS OpenCode idle recovery and verified completion",
    ].join("\n") + "\n",
  );
} finally {
  if (fixture) {
    await rm(fixture, { recursive: true, force: true });
  }
}
