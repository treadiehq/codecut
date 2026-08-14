import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("setup defaults", () => {
  it("installs user-level Claude checks when no scope is given", async () => {
    const repositoryRoot = process.cwd();
    const home = await mkdtemp(
      path.join(repositoryRoot, ".codecut-cli-home-"),
    );
    temporaryDirectories.push(home);
    const configHome = path.join(home, "config");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(repositoryRoot, "src", "cli.ts"),
        "setup",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: configHome,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("hooks (claude): installed");
    expect(result.stdout).toContain("policy: compiled (1 rules)");

    const settings = JSON.parse(
      await readFile(path.join(home, ".claude", "settings.json"), "utf8"),
    ) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(settings.hooks)).toContain("Stop");

    const policy = JSON.parse(
      await readFile(path.join(configHome, "codecut", "policy.json"), "utf8"),
    ) as { rules: Array<{ type: string; mode: string }> };
    expect(policy.rules).toEqual([
      expect.objectContaining({ type: "comment-quality", mode: "warn" }),
    ]);
  });
});
