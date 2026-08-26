#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { runHook } from "./commands/hook.js";
import { initializeProject } from "./commands/init.js";
import { formatLint, runLintCommand } from "./commands/lint.js";
import os from "node:os";
import {
  formatStatus,
  getStatus,
  inspectHookSettings,
} from "./commands/status.js";
import { formatPolicyTests, testPolicy } from "./commands/test.js";
import { compareVersions, updateCodecut } from "./commands/update.js";
import { setupUserRules } from "./commands/user.js";
import { genericHookProtocolDocument } from "./adapters/generic.js";
import {
  hookAgentNames,
  isHookAgentName,
  isSupportedAgentName,
  supportedAgentNames,
  type HookAgentName,
  type SupportedAgentName,
} from "./core/agents.js";
import { displayPath } from "./core/user.js";
import { installUserHooks } from "./install/user.js";

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

function agent(value: string): SupportedAgentName {
  const normalized = value.toLowerCase();
  if (!isSupportedAgentName(normalized)) {
    throw new Error(
      `Unsupported agent "${value}". Use ${supportedAgentNames()}.`,
    );
  }
  return normalized;
}

function hookAgent(value: string): HookAgentName {
  const normalized = value.toLowerCase();
  if (!isHookAgentName(normalized)) {
    throw new Error(
      `Unsupported hook agent "${value}". Use ${hookAgentNames()}.`,
    );
  }
  return normalized;
}

async function setupUser(
  options: {
    accept: boolean;
    refreshPolicy: boolean;
  },
  hookAgent?: SupportedAgentName,
): Promise<void> {
  const result = await setupUserRules({
    accept: options.accept,
    refresh: options.refreshPolicy,
  });

  let hooksLine: string | undefined;
  if (hookAgent) {
    const hooks = await installUserHooks(hookAgent);
    const health = await inspectHookSettings(os.homedir(), hookAgent, {
      userLevel: true,
    });
    if (health.missingHookEvents.length > 0) {
      throw new Error(
        `User-level ${hookAgent} hooks are incomplete after install; missing: ${health.missingHookEvents.join(", ")}. Check ${displayPath(hooks.settingsPath)}.`,
      );
    }
    hooksLine = `hooks (${hookAgent}): installed at ${displayPath(hooks.settingsPath)} (${health.installedHookEvents.length} events)`;
  }

  process.stdout.write(
    [
      "Codecut user rules are ready.",
      `rules file: ${displayPath(result.rulesPath)}${
        result.rulesFileCreated ? " (created)" : ""
      }`,
      `policy: ${
        result.policyCreated
          ? "compiled"
          : result.policyUpdated
            ? "updated"
            : "preserved"
      } (${result.ruleCount} rules)`,
      ...(hooksLine ? [hooksLine] : []),
      "scope: merged into every project policy when hooks run; project rules win on overlap",
      ...(result.rulesFileCreated || result.ruleCount === 0
        ? [
            `next: add rules to ${displayPath(result.rulesPath)}, then rerun codecut setup --user --refresh-policy`,
          ]
        : []),
      ...(result.ruleCount > 0
        ? [
            result.blockingRulesConfirmed
              ? "blocking rules: active"
              : "blocking rules: warnings only; review them, then rerun with --accept",
          ]
        : []),
    ].join("\n") + "\n",
  );
}

async function setup(
  options: {
    agent: string;
    cwd: string;
    accept: boolean;
    refreshPolicy: boolean;
    user: boolean;
  },
  agentExplicitlyGiven: boolean,
  cwdExplicitlyGiven: boolean,
): Promise<void> {
  const defaultUserSetup =
    !options.user && !agentExplicitlyGiven && !cwdExplicitlyGiven;
  if (options.user || defaultUserSetup) {
    await setupUser(
      options,
      agentExplicitlyGiven || defaultUserSetup
        ? agent(options.agent)
        : undefined,
    );
    return;
  }
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
      `policy: ${
        result.policyCreated
          ? "created"
          : result.policyUpdated
            ? "updated"
            : "preserved"
      } (${result.ruleCount} rules)`,
      `runtime: ${result.runtimeUpdated ? "installed" : "current"}`,
      `hooks: healthy (${status.installedHookEvents.length} events)`,
      `self-test: ${passed} passed, ${skipped} skipped`,
      result.blockingRulesConfirmed
        ? "blocking rules: active"
        : "blocking rules: warnings only; review them, then rerun with --accept",
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
  codecut setup
  codecut update
  codecut status --json
  codecut test --json
  codecut lint --base origin/main
`,
  );

program
  .command("setup")
  .description("Install user-level checks or configure Codecut in a project")
  .option(
    "--agent <agent>",
    `agent to configure: ${supportedAgentNames()}`,
    "claude",
  )
  .option("--cwd <directory>", "project directory", process.cwd())
  .option("--accept", "activate rules that can block work", false)
  .option(
    "--refresh-policy",
    "rebuild the policy from current instruction files",
    false,
  )
  .option(
    "--user",
    "compile user-level rules that apply to every project; add --agent to also install user-level hooks",
    false,
  )
  .addHelpText(
    "after",
    `
Default:
  codecut setup is equivalent to codecut setup --user --agent claude

Examples:
  codecut setup
  codecut setup --user --agent cursor
  codecut setup --agent claude
  codecut setup --agent cursor
  codecut setup --agent codex
  codecut setup --agent devin
  codecut setup --agent opencode
  codecut setup --agent polytoken
  codecut setup --agent claude --accept
  codecut setup --user
`,
  )
  .action(async (options, command) => {
    await setup(
      options,
      command.getOptionValueSource("agent") !== "default",
      command.getOptionValueSource("cwd") !== "default",
    );
  });

program
  .command("init")
  .description("Create a policy and install agent hooks")
  .option(
    "--agent <agent>",
    `agent to configure: ${supportedAgentNames()}`,
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
  codecut init --agent devin
  codecut init --agent opencode
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
            : "blocking rules: warnings only; review them, then rerun with --accept",
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
    `agent to check: ${supportedAgentNames()}`,
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
  .command("lint")
  .description(
    "Scan a diff for heuristic issues; needs no hooks, setup, or policy",
  )
  .option("--cwd <directory>", "project directory", process.cwd())
  .option("--base <ref>", "compare HEAD against the merge base with <ref>")
  .option(
    "--range <revisions>",
    "scan a Git revision range (for example origin/main..HEAD)",
  )
  .option("--staged", "scan staged changes only", false)
  .option("--pr <number>", "scan a GitHub pull request (requires gh)")
  .option("--patch <file>", "scan a unified diff file; use - for stdin")
  .option(
    "--checks <names>",
    "comma-separated checks: comment-quality, todo-comments, debug-artifacts, blast-radius",
  )
  .option("--format <format>", "output format: text, json, github, or sarif", "text")
  .option("--exit-zero", "exit 0 even when issues are found", false)
  .addHelpText(
    "after",
    `
Examples:
  codecut lint                       uncommitted changes
  codecut lint --staged              staged changes
  codecut lint --base origin/main    a pull request branch
  codecut lint --range origin/main..HEAD
  codecut lint --pr 123              a GitHub pull request
  git diff main...HEAD | codecut lint --patch -
`,
  )
  .action(
    async (options: {
      cwd: string;
      base?: string;
      range?: string;
      staged: boolean;
      pr?: string;
      patch?: string;
      checks?: string;
      format: string;
      exitZero: boolean;
    }) => {
      const result = await runLintCommand({
        cwd: options.cwd,
        base: options.base,
        range: options.range,
        staged: options.staged,
        pr: options.pr,
        patch: options.patch,
        checks: options.checks,
      });
      process.stdout.write(`${formatLint(result, options.format, VERSION)}\n`);
      if (result.findings.length > 0 && !options.exitZero) {
        process.exitCode = 1;
      }
    },
  );

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
  .description("Read one platform or generic agent hook event from stdin")
  .option(
    "--agent <agent>",
    `agent sending the event: ${hookAgentNames()}`,
    "claude",
  )
  .option(
    "--user",
    "run as a user-level hook; defers to project hooks when present",
    false,
  )
  .option(
    "--schema",
    "print the generic hook protocol schemas instead of reading stdin",
    false,
  )
  .addHelpText(
    "after",
    `
Example:
  printf '%s' '{"hook_event_name":"Stop","session_id":"demo","cwd":"."}' |
    codecut hook --agent claude

  printf '%s' '{"protocol":"codecut.agent-hook","version":1,"event":"stop","session_id":"demo","cwd":"."}' |
    codecut hook --agent generic

  codecut hook --agent generic --schema
`,
  )
  .action(async (options: {
    agent: string;
    user: boolean;
    schema: boolean;
  }) => {
    const selectedAgent = hookAgent(options.agent);
    if (options.schema) {
      if (selectedAgent !== "generic") {
        throw new Error("--schema is only available with --agent generic.");
      }
      process.stdout.write(
        `${JSON.stringify(genericHookProtocolDocument, null, 2)}\n`,
      );
      return;
    }
    await runHook(selectedAgent, { userLevel: options.user });
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
