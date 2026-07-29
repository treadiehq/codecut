#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { runHook } from "./commands/hook.js";
import { initializeProject } from "./commands/init.js";
import { formatStatus, getStatus } from "./commands/status.js";
import { formatPolicyTests, testPolicy } from "./commands/test.js";
import { compareVersions, updateCodecut } from "./commands/update.js";
import { agentNameSchema, type AgentName } from "./core/schema.js";

declare const __CODECUT_VERSION__: string | undefined;

const VERSION =
  typeof __CODECUT_VERSION__ === "string" && __CODECUT_VERSION__.length > 0
    ? __CODECUT_VERSION__
    : packageJson.version;
const SCRIPT_RUNTIMES = new Set(["node", "node.exe", "bun", "bun.exe"]);

const program = new Command();

function runtimeSourcePath(): string {
  const executable = path.basename(process.execPath).toLowerCase();
  if (!SCRIPT_RUNTIMES.has(executable)) {
    return process.execPath;
  }
  return path.resolve(process.argv[1] ?? process.execPath);
}

function agent(value: string): AgentName {
  const parsed = agentNameSchema.safeParse(value.toLowerCase());
  if (!parsed.success || parsed.data === "unknown") {
    throw new Error(
      `Unsupported agent "${value}". Use "claude", "cursor", "codex", or "polytoken".`,
    );
  }
  return parsed.data;
}

async function setup(options: {
  agent: string;
  cwd: string;
  accept: boolean;
  refreshPolicy: boolean;
}): Promise<void> {
  const targetAgent = agent(options.agent);
  const result = await initializeProject({
    cwd: options.cwd,
    agent: targetAgent,
    accept: options.accept,
    force: options.refreshPolicy,
    runtimeSourcePath: runtimeSourcePath(),
  });
  const status = await getStatus(options.cwd, targetAgent);
  const policyTests = await testPolicy(options.cwd);
  if (
    !status.hooksInstalled ||
    !status.runtimeInstalled ||
    !policyTests.passed ||
    !result.runtimePath
  ) {
    throw new Error(
      "Setup checks failed. Run `codecut status --json` and `codecut test --json`.",
    );
  }

  const passed = policyTests.results.filter(
    (test) => test.status === "PASS",
  ).length;
  const skipped = policyTests.results.filter(
    (test) => test.status === "SKIP",
  ).length;
  process.stdout.write(
    [
      `Codecut is ready for ${targetAgent}.`,
      `policy: ${result.policyCreated ? "created" : "preserved"} (${result.ruleCount} rules)`,
      `runtime: ${result.runtimeUpdated ? "installed" : "current"}`,
      `hooks: healthy (${status.installedHookEvents.length} events)`,
      `self-test: ${passed} passed, ${skipped} skipped`,
      result.blockingRulesConfirmed
        ? "blocking rules: active"
        : "blocking rules: warnings only; review them, then rerun with --refresh-policy --accept",
    ].join("\n") + "\n",
  );
}

program
  .name("codecut")
  .description("Check coding agents against project rules.")
  .version(VERSION)
  .showHelpAfterError()
  .addHelpText(
    "after",
    `
Examples:
  codecut setup --agent claude
  codecut update
  codecut status --json
  codecut test --json
`,
  );

program
  .command("setup")
  .description("Install or update Codecut, then check that it works")
  .option(
    "--agent <agent>",
    "agent to configure: claude, cursor, codex, or polytoken",
    "claude",
  )
  .option("--cwd <directory>", "project directory", process.cwd())
  .option("--accept", "activate rules that can block work", false)
  .option(
    "--refresh-policy",
    "rebuild the policy from current instruction files",
    false,
  )
  .addHelpText(
    "after",
    `
Examples:
  codecut setup --agent claude
  codecut setup --agent cursor
  codecut setup --agent codex
  codecut setup --agent polytoken
  codecut setup --agent claude --accept
`,
  )
  .action(setup);

program
  .command("init")
  .description("Create a policy and install agent hooks")
  .option(
    "--agent <agent>",
    "agent to configure: claude, cursor, codex, or polytoken",
    "claude",
  )
  .option("--cwd <directory>", "project directory", process.cwd())
  .option(
    "--accept",
    "activate rules that can block work",
    false,
  )
  .option("--force", "replace an existing policy", false)
  .addHelpText(
    "after",
    `
Examples:
  codecut init --agent claude
  codecut init --agent claude --accept
  codecut init --cwd ./my-project --agent claude
`,
  )
  .action(
    async (options: {
      agent: string;
      cwd: string;
      accept: boolean;
      force: boolean;
    }) => {
      const result = await initializeProject({
        cwd: options.cwd,
        agent: agent(options.agent),
        accept: options.accept,
        force: options.force,
        runtimeSourcePath: runtimeSourcePath(),
      });
      const policy = result.policyPath.replace(`${result.projectRoot}/`, "");
      const settings = result.hookSettingsPath.replace(
        `${result.projectRoot}/`,
        "",
      );
      process.stdout.write(
        [
          `Codecut initialized in ${result.projectRoot}.`,
          `policy: ${policy}`,
          `hooks: ${settings} (${result.addedHookEvents.length} updated)`,
          `runtime: ${
            result.runtimePath
              ? result.runtimeUpdated
                ? "installed"
                : "current"
              : "not installed"
          }`,
          `project rules: ${result.directiveCount}`,
          `policy rules: ${result.ruleCount}`,
          result.blockingRulesConfirmed
            ? "blocking rules: active"
            : "blocking rules: warnings only; review them, then rerun with --force --accept",
          "next: codecut status && codecut test",
        ].join("\n") + "\n",
      );
    },
  );

program
  .command("status")
  .description("Show policy rules and hook health")
  .option(
    "--agent <agent>",
    "agent to check: claude, cursor, codex, or polytoken",
    "claude",
  )
  .option("--cwd <directory>", "project directory", process.cwd())
  .option("--json", "print JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  codecut status
  codecut status --json
`,
  )
  .action(async (options: { agent: string; cwd: string; json: boolean }) => {
    const status = await getStatus(options.cwd, agent(options.agent));
    process.stdout.write(
      options.json
        ? `${JSON.stringify(status, null, 2)}\n`
        : `${formatStatus(status)}\n`,
    );
  });

program
  .command("test")
  .description("Test each rule with a sample violation")
  .option("--cwd <directory>", "project directory", process.cwd())
  .option("--json", "print JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  codecut test
  codecut test --json
`,
  )
  .action(async (options: { cwd: string; json: boolean }) => {
    const result = await testPolicy(options.cwd);
    process.stdout.write(
      options.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : `${formatPolicyTests(result.results)}\n`,
    );
    if (!result.passed) {
      process.exitCode = 1;
    }
  });

program
  .command("update")
  .description("Update Codecut and refresh hooks in the current project")
  .option("--check", "check for an update without installing it", false)
  .option("--to <version>", "install a specific release")
  .option("--force", "reinstall even when already current", false)
  .option("--json", "print JSON", false)
  .addHelpText(
    "after",
    `
Examples:
  codecut update
  codecut update --check
  codecut update --to 0.2.0
`,
  )
  .action(
    async (options: {
      check: boolean;
      to?: string;
      force: boolean;
      json: boolean;
    }) => {
      if (SCRIPT_RUNTIMES.has(path.basename(process.execPath).toLowerCase())) {
        throw new Error(
          "`codecut update` requires the standalone Codecut binary. Reinstall from the command shown in the README.",
        );
      }
      const result = await updateCodecut({
        currentVersion: VERSION,
        executablePath: runtimeSourcePath(),
        cwd: process.cwd(),
        version: options.to,
        force: options.force,
        checkOnly: options.check,
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      if (!result.updated) {
        process.stdout.write(
          compareVersions(result.latestVersion, result.currentVersion) > 0
            ? `Codecut ${result.latestVersion} is available. Run \`codecut update\` to install it.\n`
            : `Codecut ${result.currentVersion} is already current.\n`,
        );
      } else {
        process.stdout.write(
          result.scheduled
            ? `Codecut ${result.latestVersion} will finish updating after this command exits.\n`
            : `Updated Codecut ${result.currentVersion} → ${result.latestVersion}.\n`,
        );
      }
      if (result.refreshedAgents.length > 0) {
        process.stdout.write(
          `Refreshed project hooks: ${result.refreshedAgents.join(", ")}.\n`,
        );
      }
      for (const warning of result.warnings) {
        process.stderr.write(`Warning: ${warning}\n`);
      }
    },
  );

program
  .command("hook")
  .description("Read one agent hook event from stdin")
  .option("--agent <agent>", "agent sending the event", "claude")
  .addHelpText(
    "after",
    `
Example:
  printf '%s' '{"hook_event_name":"Stop","session_id":"demo","cwd":"."}' |
    codecut hook --agent claude
`,
  )
  .action(async (options: { agent: string }) => {
    await runHook(agent(options.agent));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
