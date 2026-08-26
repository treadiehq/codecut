import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverDirectives,
  parseDirectives,
} from "../src/core/discovery.js";
import { compilePolicy } from "../src/core/compiler.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("directive discovery", () => {
  it("finds project instructions with source lines and ignores code", async () => {
    const directory = await mkdtemp(
      path.join(process.cwd(), ".codecut-discovery-"),
    );
    temporaryDirectories.push(directory);
    await writeFile(
      path.join(directory, "CLAUDE.md"),
      [
        "# Project",
        "- Treat warnings as errors",
        "```sh",
        "echo 'never do this example'",
        "```",
        "- All unit tests must pass",
      ].join("\n"),
    );
    await writeFile(
      path.join(directory, "AGENTS.md"),
      "# Agent instructions\nAlways test locally\n",
    );
    await mkdir(path.join(directory, "packages", "app"), { recursive: true });
    await writeFile(
      path.join(directory, "packages", "app", "AGENTS.md"),
      "Never deploy this package directly\n",
    );

    const result = await discoverDirectives(directory);

    expect(result.sources).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      path.join("packages", "app", "AGENTS.md"),
    ]);
    expect(result.directives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "Treat warnings as errors",
          source: expect.objectContaining({ path: "CLAUDE.md", line: 2 }),
        }),
        expect.objectContaining({
          text: "All unit tests must pass",
          source: expect.objectContaining({ path: "CLAUDE.md", line: 6 }),
        }),
        expect.objectContaining({
          text: "Always test locally",
          source: expect.objectContaining({
            path: "AGENTS.md",
            line: 2,
          }),
        }),
        expect.objectContaining({
          text: "Never deploy this package directly",
          source: expect.objectContaining({
            path: path.join("packages", "app", "AGENTS.md"),
            line: 1,
            conditional: true,
          }),
        }),
      ]),
    );
    expect(result.directives.some((item) => item.text.includes("example"))).toBe(
      false,
    );
  });

  it("marks directives under conditional headings as conditional", async () => {
    const directory = await mkdtemp(
      path.join(process.cwd(), ".codecut-discovery-scope-"),
    );
    temporaryDirectories.push(directory);
    await writeFile(
      path.join(directory, "CLAUDE.md"),
      [
        "# Project",
        "## When editing release docs",
        "- All unit tests must pass",
        "- Use local tests",
        "## Global checks",
        "- All unit tests must pass",
        "- Treat warnings as errors",
        "When deploying",
        "--------------",
        "- Keep changes small and focused",
      ].join("\n"),
    );

    const result = await discoverDirectives(directory);
    const scoped = result.directives.find((item) =>
      item.text.includes("unit tests"),
    );
    const global = result.directives.find((item) =>
      item.text.includes("warnings"),
    );
    const uniqueScoped = result.directives.find((item) =>
      item.text.includes("local tests"),
    );
    const setextScoped = result.directives.find((item) =>
      item.text.includes("changes small"),
    );

    expect(scoped?.source.conditional).toBe(false);
    expect(uniqueScoped?.source.conditional).toBe(true);
    expect(setextScoped?.source.conditional).toBe(true);
    expect(global?.source.conditional).toBe(false);
    expect(
      result.directives.filter((item) => item.text.includes("unit tests")),
    ).toHaveLength(1);
  });

  it("discovers Devin rules and preserves trigger scope", async () => {
    const directory = await mkdtemp(
      path.join(process.cwd(), ".codecut-discovery-devin-"),
    );
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, ".devin", "rules"), { recursive: true });
    await writeFile(
      path.join(directory, "AGENT.md"),
      "- Always run tests locally\n",
    );
    await writeFile(
      path.join(directory, ".devin", "global_rules.md"),
      "- Treat warnings as errors\n",
    );
    await writeFile(
      path.join(directory, ".devin", "rules", "always.md"),
      "---\ntrigger: always_on\n---\n- All unit tests must pass\n",
    );
    await writeFile(
      path.join(directory, ".devin", "rules", "scoped.md"),
      "---\ntrigger: model_decision\n---\n- Keep release changes small\n",
    );

    const result = await discoverDirectives(directory);

    expect(result.sources).toEqual([
      path.join(".devin", "global_rules.md"),
      path.join(".devin", "rules", "always.md"),
      path.join(".devin", "rules", "scoped.md"),
      "AGENT.md",
    ]);
    expect(
      result.directives.find((item) => item.text.includes("unit tests"))?.source
        .conditional,
    ).toBe(false);
    expect(
      result.directives.find((item) => item.text.includes("release changes"))
        ?.source.conditional,
    ).toBe(true);
  });

  it("does not treat a list item before a thematic break as a heading", () => {
    const directives = parseDirectives(
      [
        "- Use snapshots when needed",
        "---",
        "- All unit tests must pass",
        "- Run tests locally",
      ].join("\n"),
      { path: "CLAUDE.md", scope: "project", conditional: false },
    );

    expect(
      directives.find((item) => item.text.includes("unit tests"))?.source
        .conditional,
    ).toBe(false);
    expect(
      directives.some((item) => item.text === "Run tests locally"),
    ).toBe(true);
  });

  it("does not treat a blockquote before a thematic break as a heading", () => {
    const directives = parseDirectives(
      [
        "> **Important**: When deploying to production",
        "---",
        "- All unit tests must pass",
      ].join("\n"),
      { path: "CLAUDE.md", scope: "project", conditional: false },
    );

    expect(
      directives.find((item) => item.text.includes("unit tests"))?.source
        .conditional,
    ).toBe(false);
  });

  it("keeps discovered rules after blockquotes eligible for blocking", async () => {
    const directory = await mkdtemp(
      path.join(process.cwd(), ".codecut-discovery-blockquote-"),
    );
    temporaryDirectories.push(directory);
    await writeFile(
      path.join(directory, "CLAUDE.md"),
      [
        "# Project Rules",
        "> **Important**: When deploying to production",
        "---",
        "- All unit tests must pass",
      ].join("\n"),
    );

    const discovery = await discoverDirectives(directory);
    const policy = compilePolicy({
      directives: discovery.directives,
      sources: discovery.sources,
      agent: "claude",
      acceptBlockingRules: true,
    });
    const rule = policy.rules.find(
      (item) => item.type === "require-passing-tests",
    );

    expect(rule?.source.conditional).toBe(false);
    expect(rule).toMatchObject({ mode: "block", confirmed: true });
  });
});
