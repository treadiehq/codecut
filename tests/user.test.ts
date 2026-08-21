import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupUserRules } from "../src/commands/user.js";
import { compilePolicy } from "../src/core/compiler.js";
import { evaluatePolicy } from "../src/core/engine.js";
import { writePolicy } from "../src/core/project.js";
import type { Directive } from "../src/core/schema.js";
import {
  discoverUserDirectives,
  loadEnforcementPolicy,
  loadEffectivePolicy,
  loadUserPolicy,
  mergePolicies,
  userConfigDirectory,
  userPolicyPath,
  userRulesPath,
} from "../src/core/user.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(process.cwd(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function directive(text: string): Directive {
  return {
    text,
    source: { path: "AGENTS.md", line: 1, scope: "project", conditional: false },
  };
}

describe("user config directory", () => {
  it("prefers XDG_CONFIG_HOME when set", () => {
    expect(userConfigDirectory({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe(
      path.join("/tmp/xdg", "codecut"),
    );
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset or blank", () => {
    expect(userConfigDirectory({})).toContain(
      path.join(".config", "codecut"),
    );
    expect(userConfigDirectory({ XDG_CONFIG_HOME: "  " })).toContain(
      path.join(".config", "codecut"),
    );
  });
});

describe("user rules setup", () => {
  it("creates a template with a safe default comment rule", async () => {
    const configDirectory = await temporaryDirectory(".codecut-user-");

    const result = await setupUserRules({
      accept: false,
      refresh: false,
      configDirectory,
    });

    expect(result.rulesFileCreated).toBe(true);
    expect(result.policyCreated).toBe(true);
    expect(result.ruleCount).toBe(1);

    const policy = await loadUserPolicy(configDirectory);
    expect(policy?.rules).toEqual([
      expect.objectContaining({
        type: "comment-quality",
        mode: "warn",
        source: expect.objectContaining({ scope: "user" }),
      }),
    ]);
    expect(policy?.sources).toEqual([
      expect.stringContaining("AGENTS.md"),
    ]);

    const template = await readFile(
      userRulesPath(configDirectory),
      "utf8",
    );
    expect(template).toContain("codecut setup --user");
  });

  it("activates existing user rules with --accept", async () => {
    const configDirectory = await temporaryDirectory(".codecut-user-");
    await writeFile(
      userRulesPath(configDirectory),
      [
        "# My rules",
        "- Treat warnings as errors",
        "- Never leave prompts, agent instructions, or tickets in code comments",
      ].join("\n"),
      "utf8",
    );

    const withoutAccept = await setupUserRules({
      accept: false,
      refresh: false,
      configDirectory,
    });
    expect(withoutAccept.rulesFileCreated).toBe(false);
    expect(withoutAccept.ruleCount).toBe(2);
    expect(withoutAccept.blockingRulesConfirmed).toBe(false);

    const withAccept = await setupUserRules({
      accept: true,
      refresh: false,
      configDirectory,
    });
    expect(withAccept.policyCreated).toBe(false);
    expect(withAccept.policyUpdated).toBe(true);
    expect(withAccept.blockingRulesConfirmed).toBe(true);

    const policy = await loadUserPolicy(configDirectory);
    expect(
      policy?.rules
        .filter((rule) => rule.mode === "block")
        .every((rule) => rule.confirmed),
    ).toBe(true);
    expect(policy?.rules.every((rule) => rule.source.scope === "user")).toBe(
      true,
    );
    expect(policy?.rules.map((rule) => rule.type).sort()).toEqual([
      "comment-quality",
      "warnings-as-errors",
    ]);
  });

  it("preserves an existing user policy unless refresh is requested", async () => {
    const configDirectory = await temporaryDirectory(".codecut-user-");
    await setupUserRules({ accept: false, refresh: false, configDirectory });

    await writeFile(
      userRulesPath(configDirectory),
      "- All unit tests must pass\n",
      "utf8",
    );

    const preserved = await setupUserRules({
      accept: false,
      refresh: false,
      configDirectory,
    });
    expect(preserved.policyCreated).toBe(false);
    expect(preserved.ruleCount).toBe(1);

    const refreshed = await setupUserRules({
      accept: false,
      refresh: true,
      configDirectory,
    });
    expect(refreshed.policyCreated).toBe(true);
    expect(refreshed.ruleCount).toBe(1);
    expect(
      (await loadUserPolicy(configDirectory))?.rules[0]?.type,
    ).toBe("require-passing-tests");
  });

  it("ignores example directives inside code fences", async () => {
    const configDirectory = await temporaryDirectory(".codecut-user-");
    await setupUserRules({ accept: false, refresh: false, configDirectory });

    const discovery = await discoverUserDirectives(configDirectory);
    expect(discovery.directives).toHaveLength(1);
    expect(discovery.directives[0]?.text).toContain(
      "Keep prompts, agent instructions",
    );
  });

  it("reports a directory used as the user rules file", async () => {
    const configDirectory = await temporaryDirectory(".codecut-user-");
    await mkdir(userRulesPath(configDirectory));

    await expect(
      setupUserRules({
        accept: false,
        refresh: false,
        configDirectory,
      }),
    ).rejects.toThrow(
      /Cannot read Codecut user rules file .*AGENTS\.md: expected a file but found a directory/,
    );
  });

  it("reports a directory used as the user policy", async () => {
    const configDirectory = await temporaryDirectory(".codecut-user-");
    await writeFile(
      userRulesPath(configDirectory),
      "- All unit tests must pass\n",
    );
    await mkdir(userPolicyPath(configDirectory));

    await expect(
      setupUserRules({
        accept: false,
        refresh: false,
        configDirectory,
      }),
    ).rejects.toThrow(
      /Cannot read Codecut user policy .*policy\.json: expected a file but found a directory/,
    );
  });
});

describe("policy merging", () => {
  it("appends user rules and keeps the project rule on id conflicts", () => {
    const projectPolicy = compilePolicy({
      directives: [directive("Treat warnings as errors")],
      sources: ["AGENTS.md"],
      agent: "claude",
      acceptBlockingRules: true,
    });
    const userPolicy = compilePolicy({
      directives: [
        {
          text: "Treat warnings as errors",
          source: {
            path: "~/.config/codecut/AGENTS.md",
            line: 2,
            scope: "user",
            conditional: false,
          },
        },
        {
          text: "Never leave prompts, agent instructions, or tickets in code comments",
          source: {
            path: "~/.config/codecut/AGENTS.md",
            line: 3,
            scope: "user",
            conditional: false,
          },
        },
      ],
      sources: ["~/.config/codecut/AGENTS.md"],
      agent: "unknown",
      acceptBlockingRules: false,
      fallbackToStarterPolicy: false,
    });

    const merged = mergePolicies(projectPolicy, userPolicy);

    expect(merged.rules).toHaveLength(2);
    const warningsRule = merged.rules.find(
      (rule) => rule.type === "warnings-as-errors",
    );
    expect(warningsRule?.source.scope).toBe("project");
    expect(warningsRule?.confirmed).toBe(true);
    const commentRule = merged.rules.find(
      (rule) => rule.type === "comment-quality",
    );
    expect(commentRule?.source.scope).toBe("user");
    expect(merged.sources).toEqual([
      "AGENTS.md",
      "~/.config/codecut/AGENTS.md",
    ]);
  });

  it("does not duplicate the default comment rule in starter projects", () => {
    const projectPolicy = compilePolicy({
      directives: [],
      sources: [],
      agent: "claude",
      acceptBlockingRules: true,
    });
    const userPolicy = compilePolicy({
      directives: [
        {
          text: "Keep prompts, agent instructions, tickets, and temporary files out of code comments",
          source: {
            path: "~/.config/codecut/AGENTS.md",
            line: 5,
            scope: "user",
            conditional: false,
          },
        },
      ],
      sources: ["~/.config/codecut/AGENTS.md"],
      agent: "unknown",
      acceptBlockingRules: false,
      fallbackToStarterPolicy: false,
    });

    const merged = mergePolicies(projectPolicy, userPolicy);

    expect(
      merged.rules.filter((rule) => rule.type === "comment-quality"),
    ).toHaveLength(1);
    expect(
      merged.rules.find((rule) => rule.type === "comment-quality")?.source
        .scope,
    ).toBe("generated");
  });

  it("returns the project policy untouched without a user policy", () => {
    const projectPolicy = compilePolicy({
      directives: [directive("All unit tests must pass")],
      sources: ["AGENTS.md"],
      agent: "claude",
      acceptBlockingRules: true,
    });

    expect(mergePolicies(projectPolicy, undefined)).toBe(projectPolicy);
  });
});

describe("effective policy loading", () => {
  it("merges the user policy into the project policy at load time", async () => {
    const projectRoot = await temporaryDirectory(".codecut-project-");
    const configDirectory = await temporaryDirectory(".codecut-user-");

    await writePolicy(
      projectRoot,
      compilePolicy({
        directives: [directive("All unit tests must pass")],
        sources: ["AGENTS.md"],
        agent: "claude",
        acceptBlockingRules: true,
      }),
    );
    await writeFile(
      userRulesPath(configDirectory),
      "- Never leave prompts, agent instructions, or tickets in code comments\n",
      "utf8",
    );
    await setupUserRules({ accept: false, refresh: false, configDirectory });

    const policy = await loadEffectivePolicy(projectRoot, configDirectory);

    expect(policy.rules.map((rule) => rule.type).sort()).toEqual([
      "comment-quality",
      "require-passing-tests",
    ]);
    expect(
      policy.rules.find((rule) => rule.type === "comment-quality")?.source
        .scope,
    ).toBe("user");
  });

  it("loads the project policy alone when no user policy exists", async () => {
    const projectRoot = await temporaryDirectory(".codecut-project-");
    const configDirectory = await temporaryDirectory(".codecut-user-");

    await writePolicy(
      projectRoot,
      compilePolicy({
        directives: [directive("All unit tests must pass")],
        sources: ["AGENTS.md"],
        agent: "claude",
        acceptBlockingRules: true,
      }),
    );

    const policy = await loadEffectivePolicy(projectRoot, configDirectory);
    expect(policy.rules).toHaveLength(1);
  });

  it("enforces the project policy when the user policy is invalid", async () => {
    const projectRoot = await temporaryDirectory(".codecut-project-");
    const configDirectory = await temporaryDirectory(".codecut-user-");

    await writePolicy(
      projectRoot,
      compilePolicy({
        directives: [directive("Use local machines for testing")],
        sources: ["AGENTS.md"],
        agent: "claude",
        acceptBlockingRules: true,
      }),
    );
    await writeFile(userPolicyPath(configDirectory), "{invalid", "utf8");

    await expect(
      loadEffectivePolicy(projectRoot, configDirectory),
    ).rejects.toThrow("Invalid Codecut user policy");

    const result = await loadEnforcementPolicy(
      projectRoot,
      configDirectory,
    );
    const decision = evaluatePolicy({
      policy: result.policy,
      event: {
        agent: "claude",
        stage: "pre-tool",
        sessionId: "corrupt-user-policy",
        cwd: projectRoot,
        occurredAt: "2026-01-01T00:00:00.000Z",
        toolName: "Bash",
        toolInput: { command: "ssh runner npm test" },
        stopHookActive: false,
        loopCount: 0,
      },
      receipts: [],
    });

    expect(result.warning).toContain(
      "enforced the project policy but skipped invalid user policy",
    );
    expect(decision.outcome).toBe("block");
    expect(decision.violations[0]?.source.scope).toBe("project");
  });
});
