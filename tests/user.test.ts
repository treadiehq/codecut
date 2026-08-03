import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupUserRules } from "../src/commands/user.js";
import { compilePolicy } from "../src/core/compiler.js";
import { writePolicy } from "../src/core/project.js";
import type { Directive } from "../src/core/schema.js";
import {
  discoverUserDirectives,
  loadEffectivePolicy,
  loadUserPolicy,
  mergePolicies,
  userConfigDirectory,
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
  it("creates a template on first run and compiles an empty policy", async () => {
    const configDirectory = await temporaryDirectory(".codecut-user-");

    const result = await setupUserRules({
      accept: false,
      refresh: false,
      configDirectory,
    });

    expect(result.rulesFileCreated).toBe(true);
    expect(result.policyCreated).toBe(true);
    expect(result.ruleCount).toBe(0);

    const policy = await loadUserPolicy(configDirectory);
    expect(policy?.rules).toEqual([]);
    expect(policy?.sources).toEqual([
      expect.stringContaining("AGENTS.md"),
    ]);

    const template = await readFile(
      userRulesPath(configDirectory),
      "utf8",
    );
    expect(template).toContain("codecut setup --user");
  });

  it("compiles user rules with user scope and honors --accept", async () => {
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
      refresh: true,
      configDirectory,
    });
    expect(withAccept.blockingRulesConfirmed).toBe(true);

    const policy = await loadUserPolicy(configDirectory);
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
    expect(preserved.ruleCount).toBe(0);

    const refreshed = await setupUserRules({
      accept: false,
      refresh: true,
      configDirectory,
    });
    expect(refreshed.policyCreated).toBe(true);
    expect(refreshed.ruleCount).toBe(1);
  });

  it("ignores directives inside code fences in the rules file", async () => {
    const configDirectory = await temporaryDirectory(".codecut-user-");
    await setupUserRules({ accept: false, refresh: false, configDirectory });

    const discovery = await discoverUserDirectives(configDirectory);
    expect(discovery.directives).toEqual([]);
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
});
