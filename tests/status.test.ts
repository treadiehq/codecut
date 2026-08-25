import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getStatus, inspectHookSettings } from "../src/commands/status.js";
import { testPolicy } from "../src/commands/test.js";
import { compilePolicy } from "../src/core/compiler.js";
import { writePolicy } from "../src/core/project.js";
import { installClaudeHooks } from "../src/install/claude.js";
import { installCodexHooks } from "../src/install/codex.js";
import { installCursorHooks } from "../src/install/cursor.js";
import { installPolytokenHooks } from "../src/install/polytoken.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("hook health status", () => {
  it("uses the user Polytoken config path for user-level health checks", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codecut-status-home-"));
    temporaryDirectories.push(home);
    const xdg = path.join(home, "xdg");
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;

    try {
      const installed = await inspectHookSettings(home, "polytoken", {
        userLevel: true,
      });
      expect(installed.settingsPath).toBe(
        path.join(xdg, "polytoken", "hooks.json"),
      );
      expect(installed.missingHookEvents).toHaveLength(7);
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previous;
      }
    }
  });

  it("reports a missing lifecycle hook instead of a false healthy status", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "codecut-status-"),
    );
    temporaryDirectories.push(projectRoot);
    await writePolicy(
      projectRoot,
      compilePolicy({
        directives: [],
        sources: [],
        agent: "claude",
        acceptBlockingRules: false,
      }),
    );
    const installed = await installClaudeHooks(projectRoot);
    const settings = JSON.parse(
      await readFile(installed.settingsPath, "utf8"),
    ) as { hooks: Record<string, unknown> };
    delete settings.hooks.Stop;
    await writeFile(installed.settingsPath, JSON.stringify(settings));

    const status = await getStatus(projectRoot);

    expect(status.scope).toBe("project");
    expect(status.hooksInstalled).toBe(false);
    expect(status.missingHookEvents).toEqual(["Stop"]);
    expect(status.installedHookEvents).toHaveLength(4);
  });

  it.each([
    ["claude", "SessionStart"],
    ["cursor", "preCompact"],
    ["codex", "SessionStart"],
    ["polytoken", "post_clear"],
    ["polytoken", "post_compaction"],
  ] as const)(
    "reports a missing %s context-reset hook: %s",
    async (agent, resetEvent) => {
      const projectRoot = await mkdtemp(
        path.join(os.tmpdir(), `codecut-${agent}-status-`),
      );
      temporaryDirectories.push(projectRoot);
      const installed =
        agent === "claude"
          ? await installClaudeHooks(projectRoot)
          : agent === "cursor"
            ? await installCursorHooks(projectRoot)
            : agent === "codex"
              ? await installCodexHooks(projectRoot)
              : await installPolytokenHooks(projectRoot);
      const settings = JSON.parse(
        await readFile(installed.settingsPath, "utf8"),
      ) as unknown;
      if (agent === "polytoken") {
        if (!Array.isArray(settings)) {
          throw new Error("Expected Polytoken hooks to be an array");
        }
        await writeFile(
          installed.settingsPath,
          JSON.stringify(
            settings.filter(
              (entry) =>
                !entry ||
                typeof entry !== "object" ||
                Array.isArray(entry) ||
                (entry as { event?: unknown }).event !== resetEvent,
            ),
          ),
        );
      } else {
        const objectSettings = settings as {
          hooks: Record<string, unknown>;
        };
        delete objectSettings.hooks[resetEvent];
        await writeFile(installed.settingsPath, JSON.stringify(objectSettings));
      }

      const status = await inspectHookSettings(projectRoot, agent);

      expect(status.missingHookEvents).toContain(resetEvent);
      expect(status.installedHookEvents).not.toContain(resetEvent);
    },
  );
});

describe("user-level fallback without a project policy", () => {
  async function withUserPolicy<T>(
    run: (cwd: string) => Promise<T>,
    options: { userRules?: boolean } = { userRules: true },
  ): Promise<T> {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "codecut-noproject-"));
    const xdg = await mkdtemp(path.join(os.tmpdir(), "codecut-xdg-"));
    temporaryDirectories.push(cwd, xdg);
    if (options.userRules) {
      const policy = compilePolicy({
        directives: [
          {
            text: "All unit tests must pass",
            source: {
              path: "~/.config/codecut/AGENTS.md",
              line: 1,
              scope: "user",
              conditional: false,
            },
          },
        ],
        sources: ["~/.config/codecut/AGENTS.md"],
        agent: "claude",
        acceptBlockingRules: false,
      });
      await mkdir(path.join(xdg, "codecut"), { recursive: true });
      await writeFile(
        path.join(xdg, "codecut", "policy.json"),
        JSON.stringify(policy, null, 2),
      );
    }
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      return await run(cwd);
    } finally {
      if (previous === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previous;
      }
    }
  }

  it("status reports the user-level rules instead of a hard error", async () => {
    await withUserPolicy(async (cwd) => {
      const status = await getStatus(cwd);
      expect(status.scope).toBe("user");
      expect(status.projectRoot).toBeUndefined();
      expect(status.runtimePath).toBeUndefined();
      expect(status.rules.length).toBeGreaterThan(0);
      expect(status.userRuleCount).toBe(status.rules.length);
    });
  });

  it("test exercises the user-level rules instead of a hard error", async () => {
    await withUserPolicy(async (cwd) => {
      const result = await testPolicy(cwd);
      expect(result.scope).toBe("user");
      expect(result.projectRoot).toBeUndefined();
      expect(result.results.length).toBeGreaterThan(0);
    });
  });

  it("still errors when no policy exists anywhere, pointing at both setups", async () => {
    await withUserPolicy(
      async (cwd) => {
        await expect(getStatus(cwd)).rejects.toThrow("codecut setup --user");
        await expect(testPolicy(cwd)).rejects.toThrow("codecut setup --user");
      },
      { userRules: false },
    );
  });
});
