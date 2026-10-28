import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installRuntime,
  RUNTIME_RELATIVE_PATH,
} from "../src/install/runtime.js";
import {
  LEGACY_PROJECT_DIRECTORY,
  loadPolicy,
  migrateLegacyProjectDirectory,
  parsePolicyDocument,
  PROJECT_DIRECTORY,
} from "../src/core/project.js";
import {
  DEFAULT_COMMENT_CONTEXT_PATTERNS,
  DEFAULT_REMOTE_COMMAND_PATTERNS,
  DEFAULT_TEST_COMMAND_PATTERNS,
  LEGACY_COMMENT_CONTEXT_PATTERNS,
  matchesAny,
} from "../src/core/patterns.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("persistent runtime installation", () => {
  it("copies atomically and skips an unchanged runtime", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "codecut-runtime-"),
    );
    temporaryDirectories.push(projectRoot);
    const source = path.join(projectRoot, "source.mjs");
    await writeFile(source, "#!/usr/bin/env node\nconsole.log('ok');\n");

    const first = await installRuntime(projectRoot, source);
    const second = await installRuntime(projectRoot, source);

    expect(first.updated).toBe(true);
    expect(second.updated).toBe(false);
    expect(first.runtimePath).toBe(
      path.join(projectRoot, RUNTIME_RELATIVE_PATH),
    );
    expect(await readFile(first.runtimePath, "utf8")).toContain("console.log");
    expect((await stat(first.runtimePath)).mode & 0o111).not.toBe(0);
  });

  it("migrates the legacy project directory without its old runtime", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "codecut-migration-"),
    );
    temporaryDirectories.push(projectRoot);
    const legacyRuntime = path.join(
      projectRoot,
      LEGACY_PROJECT_DIRECTORY,
      "runtime",
      "papercut.cjs",
    );
    await mkdir(path.dirname(legacyRuntime), { recursive: true });
    await writeFile(legacyRuntime, "legacy");
    await writeFile(
      path.join(projectRoot, LEGACY_PROJECT_DIRECTORY, "policy.json"),
      "{}",
    );

    expect(await migrateLegacyProjectDirectory(projectRoot)).toBe(true);
    await expect(
      access(path.join(projectRoot, PROJECT_DIRECTORY, "policy.json")),
    ).resolves.toBeUndefined();
    await expect(access(legacyRuntime)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates legacy meta-compliance rules to advice-only", async () => {
    const projectRoot = await mkdtemp(
      path.join(os.tmpdir(), "codecut-policy-migration-"),
    );
    temporaryDirectories.push(projectRoot);
    const destination = path.join(projectRoot, PROJECT_DIRECTORY, "policy.json");
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(
      destination,
      JSON.stringify({
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        agents: ["claude"],
        sources: ["starter policy"],
        rules: [
          {
            id: "meta-compliance-legacy",
            directive: "Do not skip project rules",
            source: {
              path: "starter policy",
              scope: "generated",
              conditional: false,
            },
            mode: "warn",
            confirmed: true,
            enabled: true,
            type: "meta-compliance",
          },
        ],
      }),
    );

    const policy = await loadPolicy(projectRoot);
    expect(policy.rules[0]?.type).toBe("advisory");
  });

  it("loads ready-PR rules without changing policy version 1", () => {
    const policy = parsePolicyDocument(
      JSON.stringify({
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        agents: ["cursor"],
        sources: ["AGENTS.md"],
        rules: [
          {
            id: "require-ready-github-pr-example",
            directive: "Open a non-draft PR",
            source: {
              path: "AGENTS.md",
              scope: "project",
              conditional: false,
            },
            mode: "block",
            confirmed: true,
            enabled: true,
            type: "require-ready-github-pr",
          },
        ],
      }),
    );

    expect(policy).toMatchObject({
      version: 1,
      rules: [{ type: "require-ready-github-pr" }],
    });
  });

  it("migrates only the legacy default command patterns", () => {
    // The original defaults, as saved in policies compiled before quoted
    // commands were recognised.
    const legacyTestPatterns = [
      String.raw`(?:^|[;&|]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$|:)`,
      String.raw`(?:^|[;&|]\s*|\s)(?:npx\s+)?vitest(?:\s|$)`,
      String.raw`(?:^|[;&|]\s*|\s)(?:python(?:3)?\s+-m\s+)?pytest(?:\s|$)`,
      String.raw`(?:^|[;&|]\s*|\s)cargo\s+test(?:\s|$)`,
      String.raw`(?:^|[;&|]\s*|\s)go\s+test(?:\s|$)`,
      String.raw`(?:^|[;&|]\s*|\s)(?:bundle\s+exec\s+)?rspec(?:\s|$)`,
      String.raw`(?:^|[;&|]\s*|\s)(?:dotnet\s+test|mvn\s+test|gradle\s+test)(?:\s|$)`,
    ];
    const legacyRemotePatterns = [
      String.raw`(?:^|[;&|]\s*|\s)ssh(?:\s|$)`,
      String.raw`(?:^|[;&|]\s*|\s)gh\s+(?:workflow\s+run|run\s+rerun)(?:\s|$)`,
      String.raw`(?:^|[;&|]\s*|\s)(?:circleci|buildkite-agent|actuate)\b`,
      String.raw`(?:^|[;&|]\s*|\s)kubectl\s+exec(?:\s|$)`,
    ];
    const rule = (id: string, patterns: Record<string, unknown>) => ({
      id,
      directive: "Use local machines for testing",
      source: { path: "CLAUDE.md", scope: "project", conditional: false },
      mode: "block",
      confirmed: true,
      enabled: true,
      ...patterns,
    });
    const policy = parsePolicyDocument(
      JSON.stringify({
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        agents: ["claude"],
        sources: ["CLAUDE.md"],
        rules: [
          rule("local-testing-legacy", {
            type: "local-testing",
            testCommandPatterns: legacyTestPatterns,
            remoteCommandPatterns: legacyRemotePatterns,
            remoteToolPatterns: ["runner"],
          }),
          rule("require-passing-tests-legacy", {
            type: "require-passing-tests",
            commandPatterns: legacyTestPatterns,
          }),
          rule("require-passing-tests-custom", {
            type: "require-passing-tests",
            commandPatterns: ["make check"],
          }),
        ],
      }),
    );

    expect(policy.rules[0]).toMatchObject({
      testCommandPatterns: DEFAULT_TEST_COMMAND_PATTERNS,
      remoteCommandPatterns: DEFAULT_REMOTE_COMMAND_PATTERNS,
    });
    expect(policy.rules[1]).toMatchObject({
      commandPatterns: DEFAULT_TEST_COMMAND_PATTERNS,
    });
    expect(policy.rules[2]).toMatchObject({ commandPatterns: ["make check"] });
    expect(matchesAny("ssh runner 'pytest'", legacyTestPatterns)).toBe(false);
    expect(
      matchesAny("ssh runner 'pytest'", DEFAULT_TEST_COMMAND_PATTERNS),
    ).toBe(true);
  });

  it("migrates only the legacy default comment patterns", () => {
    const policy = parsePolicyDocument(
      JSON.stringify({
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        agents: ["claude"],
        sources: ["starter policy"],
        rules: [
          {
            id: "comment-quality-legacy",
            directive: "Keep agent context out of comments",
            source: {
              path: "starter policy",
              scope: "generated",
              conditional: false,
            },
            mode: "warn",
            confirmed: true,
            enabled: true,
            type: "comment-quality",
            filePatterns: ["\\.ts$"],
            bannedPatterns: LEGACY_COMMENT_CONTEXT_PATTERNS,
          },
          {
            id: "comment-quality-custom",
            directive: "Keep custom context out of comments",
            source: {
              path: "CLAUDE.md",
              scope: "project",
              conditional: false,
            },
            mode: "warn",
            confirmed: true,
            enabled: true,
            type: "comment-quality",
            filePatterns: ["\\.ts$"],
            bannedPatterns: ["custom context"],
          },
        ],
      }),
    );

    expect(policy.rules[0]).toMatchObject({
      bannedPatterns: DEFAULT_COMMENT_CONTEXT_PATTERNS,
    });
    expect(policy.rules[1]).toMatchObject({
      bannedPatterns: ["custom context"],
    });
  });
});
