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
      ["hook", "--agent", "cursor"],
      cwd,
      JSON.stringify(payload),
    ),
  );
}

try {
  fixture = await mkdtemp(path.join(os.tmpdir(), "codecut-cursor-smoke-"));
  await writeFile(
    path.join(fixture, "AGENTS.md"),
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

  const bundle = process.env.CODECUT_SMOKE_BINARY
    ? path.resolve(repositoryRoot, process.env.CODECUT_SMOKE_BINARY)
    : path.join(repositoryRoot, "dist", "codecut.cjs");
  const setup = run(
    bundle,
    ["setup", "--agent", "cursor", "--accept"],
    fixture,
  );
  assert(
    setup.includes("Codecut is ready for cursor."),
    "native Cursor setup did not report ready",
  );
  const runtime = path.join(
    fixture,
    ".codecut",
    "runtime",
    process.platform === "win32" ? "codecut.exe" : "codecut",
  );
  const hooks = JSON.parse(
    await readFile(path.join(fixture, ".cursor", "hooks.json"), "utf8"),
  );
  assert(hooks.hooks?.preToolUse?.length === 1, "preToolUse hook missing");
  assert(
    hooks.hooks?.afterAgentResponse?.length === 1,
    "afterAgentResponse hook missing",
  );
  assert(hooks.hooks?.stop?.length === 1, "stop hook missing");

  const remote = hook(runtime, fixture, {
    hook_event_name: "preToolUse",
    conversation_id: "cursor-smoke",
    cwd: fixture,
    tool_name: "Shell",
    tool_input: { command: "ssh runner npm test" },
  });
  assert(remote.permission === "deny", "Cursor remote test was not denied");

  const comment = hook(runtime, fixture, {
    hook_event_name: "postToolUse",
    conversation_id: "cursor-comment",
    cwd: fixture,
    tool_name: "Edit",
    tool_input: {
      file_path: "src/example.ts",
      new_string: "// Per the AGENTS.md instructions, retain this code.",
    },
    tool_output: JSON.stringify({ status: "updated" }),
  });
  assert(
    comment.additional_context?.includes("new code comment"),
    "Cursor comment warning was not injected",
  );

  hook(runtime, fixture, {
    hook_event_name: "postToolUse",
    conversation_id: "cursor-completion",
    cwd: fixture,
    tool_name: "Edit",
    tool_input: {
      file_path: "src/example.ts",
      new_string: "export const value = 1;",
    },
    tool_output: JSON.stringify({ status: "updated" }),
  });
  const blockedStop = hook(runtime, fixture, {
    hook_event_name: "stop",
    conversation_id: "cursor-completion",
    workspace_roots: [fixture],
    status: "completed",
    loop_count: 0,
  });
  assert(
    blockedStop.followup_message?.includes("All unit tests must pass"),
    "Cursor stop did not continue for missing tests",
  );

  hook(runtime, fixture, {
    hook_event_name: "postToolUse",
    conversation_id: "cursor-completion",
    cwd: fixture,
    tool_name: "Shell",
    tool_input: { command: "npm test" },
    tool_output: JSON.stringify({
      exitCode: 0,
      stdout: "30 tests passed, 0 warnings",
      stderr: "",
    }),
  });
  const allowedStop = hook(runtime, fixture, {
    hook_event_name: "stop",
    conversation_id: "cursor-completion",
    workspace_roots: [fixture],
    status: "completed",
    loop_count: 1,
  });
  assert(
    allowedStop.followup_message === undefined,
    "Cursor stop continued after successful verification",
  );

  hook(runtime, fixture, {
    hook_event_name: "postToolUse",
    conversation_id: "cursor-acknowledgement",
    cwd: fixture,
    tool_name: "Edit",
    tool_input: {
      file_path: "src/large.ts",
      new_string: Array.from(
        { length: 501 },
        (_, index) => `export const value${index} = ${index};`,
      ).join("\n"),
    },
    tool_output: JSON.stringify({ status: "updated" }),
  });
  hook(runtime, fixture, {
    hook_event_name: "postToolUse",
    conversation_id: "cursor-acknowledgement",
    cwd: fixture,
    tool_name: "Shell",
    tool_input: { command: "npm test" },
    tool_output: JSON.stringify({
      exitCode: 0,
      stdout: "30 tests passed, 0 warnings",
      stderr: "",
    }),
  });
  const largeStop = hook(runtime, fixture, {
    hook_event_name: "stop",
    conversation_id: "cursor-acknowledgement",
    workspace_roots: [fixture],
    status: "completed",
    loop_count: 0,
  });
  assert(
    largeStop.followup_message?.includes("low blast radius"),
    "Cursor stop did not report the large diff",
  );
  hook(runtime, fixture, {
    hook_event_name: "afterAgentResponse",
    conversation_id: "cursor-acknowledgement",
    workspace_roots: [fixture],
    text: "The larger scope is intentional because this is the initial greenfield implementation.",
  });
  const acknowledgedStop = hook(runtime, fixture, {
    hook_event_name: "stop",
    conversation_id: "cursor-acknowledgement",
    workspace_roots: [fixture],
    status: "completed",
    loop_count: 1,
  });
  assert(
    acknowledgedStop.followup_message === undefined,
    "Cursor repeated an acknowledged blast-radius warning",
  );

  process.stdout.write(
    [
      "PASS native Cursor one-command setup",
      "PASS native Cursor hook configuration",
      "PASS Cursor pre-tool denial",
      "PASS Cursor post-edit warning",
      "PASS Cursor stop recovery and verified completion",
      "PASS Cursor blast-radius acknowledgement",
    ].join("\n") + "\n",
  );
} finally {
  if (fixture) {
    await rm(fixture, { recursive: true, force: true });
  }
}
