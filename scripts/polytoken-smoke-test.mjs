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

function hook(runtime, cwd, sessionId, payload) {
  return JSON.parse(
    run(
      runtime,
      ["hook", "--agent", "polytoken"],
      cwd,
      JSON.stringify(payload),
      {
        POLYTOKEN_HOOK_EVENT: payload.event,
        POLYTOKEN_SESSION_ID: sessionId,
        POLYTOKEN_PROJECT_DIR: cwd,
      },
    ),
  );
}

try {
  fixture = await mkdtemp(path.join(os.tmpdir(), "codecut-polytoken-smoke-"));
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
    ["setup", "--agent", "polytoken"],
    fixture,
  );
  assert(
    setup.includes("Codecut is ready for polytoken."),
    "native Polytoken setup did not report ready",
  );
  const runtime = path.join(
    fixture,
    ".codecut",
    "runtime",
    process.platform === "win32" ? "codecut.exe" : "codecut",
  );
  const hooks = JSON.parse(
    await readFile(path.join(fixture, ".polytoken", "hooks.json"), "utf8"),
  );
  const events = hooks.map((entry) => entry.event);
  for (const event of [
    "pre_tool_use",
    "post_tool_use",
    "post_tool_use_failure",
    "post_model_turn",
    "stop",
  ]) {
    assert(events.includes(event), `${event} hook missing`);
  }

  const warning = hook(runtime, fixture, "polytoken-warning", {
    event: "pre_tool_use",
    tool_name: "shell",
    input: { command: "ssh runner npm test" },
  });
  assert(
    warning.outcome === "allow" &&
      warning.reason?.includes("Use local machines for testing"),
    "Polytoken remote test warning was not shown",
  );

  run(
    bundle,
    [
      "setup",
      "--agent",
      "polytoken",
      "--refresh-policy",
      "--accept",
    ],
    fixture,
  );
  const remote = hook(runtime, fixture, "polytoken-smoke", {
    event: "pre_tool_use",
    tool_name: "shell",
    input: { command: "ssh runner npm test" },
  });
  assert(
    remote.outcome === "deny" &&
      remote.reason?.includes("Use local machines for testing"),
    "Polytoken remote test was not denied",
  );

  hook(runtime, fixture, "polytoken-completion", {
    event: "post_tool_use",
    tool_name: "apply_patch",
    input: {
      command:
        "*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch",
    },
    output: "Done!",
  });
  const blockedStop = hook(runtime, fixture, "polytoken-completion", {
    event: "stop",
  });
  assert(
    blockedStop.outcome === "continue" &&
      blockedStop.reason?.includes("All unit tests must pass"),
    "Polytoken stop did not continue for missing tests",
  );

  hook(runtime, fixture, "polytoken-completion", {
    event: "pre_tool_use",
    tool_name: "shell",
    input: { command: "npm test" },
  });
  hook(runtime, fixture, "polytoken-completion", {
    event: "post_tool_use",
    tool_name: "shell",
    input: { command: "npm test" },
    output: "30 tests passed, 0 warnings",
  });
  const allowedStop = hook(runtime, fixture, "polytoken-completion", {
    event: "stop",
  });
  assert(
    allowedStop.outcome === "stop",
    "Polytoken stop did not allow verified completion",
  );

  process.stdout.write(
    [
      "PASS native Polytoken one-command setup",
      "PASS native Polytoken hook configuration",
      "PASS Polytoken pre-tool warning and denial",
      "PASS Polytoken stop recovery and verified completion",
    ].join("\n") + "\n",
  );
} finally {
  if (fixture) {
    await rm(fixture, { recursive: true, force: true });
  }
}
