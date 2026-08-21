import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultLintConfig,
  formatLint,
  parseLintChecks,
  resolveLintConfig,
  runLint,
  runLintCommand,
} from "../src/commands/lint.js";
import {
  scanComments,
  stripNonExecutableText,
} from "../src/core/comments.js";
import { diffTotals, parseUnifiedDiff } from "../src/core/diff.js";

const SAMPLE_DIFF = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1,3 +1,6 @@",
  " const a = 1;",
  "+// Per the prompt, keep this here.",
  '+console.log("debug");',
  " const b = 2;",
  "+// TODO: remove this later",
  " const c = 3;",
  "@@ -10,2 +12,2 @@",
  " function d() {}",
  "-const old = 1;",
  "+const updated = 2;",
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,0 +2 @@",
  "+// Per the prompt, docs comment.",
  "diff --git a/logo.png b/logo.png",
  "Binary files a/logo.png and b/logo.png differ",
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-const x = 1;",
  "-const y = 2;",
  "",
].join("\n");

describe("unified diff parsing", () => {
  it("tracks per-file added lines with new-file line numbers", () => {
    const files = parseUnifiedDiff(SAMPLE_DIFF);

    expect(files.map((file) => file.path)).toEqual([
      "src/example.ts",
      "README.md",
      "logo.png",
      "gone.ts",
    ]);

    const example = files[0];
    expect(example?.added).toBe(4);
    expect(example?.deleted).toBe(1);
    expect(example?.addedLines).toEqual([
      { line: 2, text: "// Per the prompt, keep this here." },
      { line: 3, text: 'console.log("debug");' },
      { line: 5, text: "// TODO: remove this later" },
      { line: 13, text: "const updated = 2;" },
    ]);

    expect(files[1]?.addedLines).toEqual([
      { line: 2, text: "// Per the prompt, docs comment." },
    ]);
    expect(files[2]?.binary).toBe(true);
    expect(files[3]?.deleted).toBe(2);
    expect(files[3]?.added).toBe(0);

    expect(diffTotals(files)).toEqual({ files: 4, added: 5, deleted: 3 });
  });

  it("parses plain unified diffs without git headers", () => {
    const files = parseUnifiedDiff(
      [
        "--- before/app.py\t2026-01-01",
        "+++ after/app.py\t2026-01-01",
        "@@ -1 +1,2 @@",
        " import os",
        "+# HACK around the loader",
        "",
      ].join("\n"),
    );

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("after/app.py");
    expect(files[0]?.addedLines).toEqual([
      { line: 2, text: "# HACK around the loader" },
    ]);
  });

  it("does not mistake added lines starting with +++ for file headers", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/notes.ts b/notes.ts",
        "--- a/notes.ts",
        "+++ b/notes.ts",
        "@@ -1 +1,2 @@",
        " const a = 1;",
        "+++ not a header",
        "",
      ].join("\n"),
    );

    expect(files).toHaveLength(1);
    expect(files[0]?.addedLines).toEqual([
      { line: 2, text: "++ not a header" },
    ]);
  });
});

describe("comment scanning", () => {
  it("reports line and block comments with line numbers", () => {
    const comments = scanComments([
      { line: 1, text: "/* first" },
      { line: 2, text: " * second" },
      { line: 3, text: " third */" },
      { line: 4, text: "const code = 1;" },
      { line: 5, text: "// fourth" },
    ]);

    expect(comments).toEqual([
      { line: 1, text: "first" },
      { line: 2, text: "second" },
      { line: 3, text: "third" },
      { line: 5, text: "fourth" },
    ]);
  });

  it("preserves block markers inside standalone line comments", () => {
    const comments = scanComments([
      { line: 1, text: "// TODO: Check the /* important */ code path" },
      { line: 2, text: "# TODO: See /* legacy */ implementation" },
      { line: 3, text: "-- FIXME: Fix the /* block */ issue" },
      { line: 4, text: "; TODO: Review the /* assembly */ branch" },
      { line: 5, text: "/* real block */" },
    ]);

    expect(comments).toEqual([
      { line: 1, text: "TODO: Check the /* important */ code path" },
      { line: 2, text: "TODO: See /* legacy */ implementation" },
      { line: 3, text: "FIXME: Fix the /* block */ issue" },
      { line: 4, text: "TODO: Review the /* assembly */ branch" },
      { line: 5, text: "real block" },
    ]);
  });

  it("resets block-comment state across line gaps", () => {
    const comments = scanComments([
      { line: 1, text: "/* opened but closing line was not added" },
      { line: 9, text: "const code = 1;" },
    ]);

    expect(comments).toEqual([
      { line: 1, text: "opened but closing line was not added" },
    ]);
  });
});

describe("lint checks", () => {
  const files = parseUnifiedDiff(SAMPLE_DIFF);

  it("flags agent-context comments in code files only", () => {
    const result = runLint(files, defaultLintConfig());
    const commentFindings = result.findings.filter(
      (finding) => finding.check === "comment-quality",
    );

    expect(commentFindings).toEqual([
      expect.objectContaining({
        path: "src/example.ts",
        line: 2,
        evidence: "Per the prompt, keep this here.",
      }),
    ]);
  });

  it("allows prompt, instruction, and directive programming terminology", () => {
    const commonTerms = [
      "Prompt the user for their name",
      "Display the command prompt",
      "Show a confirmation prompt",
      "Instructions for the compiler optimization pass",
      "The CPU instructions are decoded here",
      "Angular directives are components without views",
      "Attribute directives change appearance",
    ];
    const commonTermFiles = parseUnifiedDiff(
      [
        "diff --git a/src/terms.ts b/src/terms.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/terms.ts",
        `@@ -0,0 +1,${commonTerms.length} @@`,
        ...commonTerms.map((comment) => `+// ${comment}`),
        "",
      ].join("\n"),
    );

    const result = runLint(commonTermFiles, defaultLintConfig());

    expect(
      result.findings.filter(
        (finding) => finding.check === "comment-quality",
      ),
    ).toEqual([]);
  });

  it("flags explicitly qualified agent-context comments", () => {
    const agentTerms = [
      "Do not copy the system prompt here",
      "Preserve the agent prompt for debugging",
      "These agent instructions are temporary",
      "The Codecut directives require this workaround",
    ];
    const agentTermFiles = parseUnifiedDiff(
      [
        "diff --git a/src/agent-terms.ts b/src/agent-terms.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/agent-terms.ts",
        `@@ -0,0 +1,${agentTerms.length} @@`,
        ...agentTerms.map((comment) => `+// ${comment}`),
        "",
      ].join("\n"),
    );

    const result = runLint(agentTermFiles, defaultLintConfig());

    expect(
      result.findings
        .filter((finding) => finding.check === "comment-quality")
        .map((finding) => finding.evidence),
    ).toEqual(agentTerms);
  });

  it("flags ticket keys but not technical word-digit tokens", () => {
    const lintComment = (comment: string) =>
      runLint(
        parseUnifiedDiff(
          [
            "diff --git a/src/x.ts b/src/x.ts",
            "--- a/src/x.ts",
            "+++ b/src/x.ts",
            "@@ -1 +1,2 @@",
            " const a = 1;",
            `+// ${comment}`,
            "",
          ].join("\n"),
        ),
        defaultLintConfig(),
      ).findings.filter((finding) => finding.check === "comment-quality");

    // Ticket keys are flagged.
    expect(lintComment("See ABC-123 for details")).toHaveLength(1);
    expect(lintComment("Workaround for JIRA2-42")).toHaveLength(1);

    // Lowercase word-digit tokens are not ticket keys.
    expect(lintComment("uses the version-1 token format")).toEqual([]);
    expect(lintComment("hashes per spec-1.0 rules")).toEqual([]);
    // Neither are well-known uppercase standards/crypto tokens.
    expect(lintComment("derived via SHA-256 over the PSK")).toEqual([]);
    expect(lintComment("JSON message body (UTF-8)")).toEqual([]);
    expect(lintComment("encrypts with AES-256 when available")).toEqual([]);
    expect(lintComment("timestamps follow ISO-8601")).toEqual([]);
    expect(lintComment("defined in RFC-4648")).toEqual([]);
  });

  it("flags task markers case-sensitively", () => {
    const result = runLint(files, defaultLintConfig());
    const todoFindings = result.findings.filter(
      (finding) => finding.check === "todo-comments",
    );
    expect(todoFindings).toEqual([
      expect.objectContaining({ path: "src/example.ts", line: 5 }),
    ]);

    const lowercase = runLint(
      parseUnifiedDiff(
        [
          "diff --git a/src/x.ts b/src/x.ts",
          "--- a/src/x.ts",
          "+++ b/src/x.ts",
          "@@ -1 +1,2 @@",
          " const a = 1;",
          "+// todo maybe later",
          "",
        ].join("\n"),
      ),
      defaultLintConfig(),
    );
    expect(
      lowercase.findings.filter((finding) => finding.check === "todo-comments"),
    ).toEqual([]);
  });

  it("flags task markers before block syntax inside line comments", () => {
    const result = runLint(
      parseUnifiedDiff(
        [
          "diff --git a/src/x.ts b/src/x.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/x.ts",
          "@@ -0,0 +1 @@",
          "+// TODO: Check the /* important */ code path",
          "",
        ].join("\n"),
      ),
      defaultLintConfig(),
    );

    expect(
      result.findings.filter((finding) => finding.check === "todo-comments"),
    ).toEqual([
      expect.objectContaining({
        path: "src/x.ts",
        line: 1,
        evidence: "TODO: Check the /* important */ code path",
      }),
    ]);
  });

  it("flags debug statements except in test files", () => {
    const result = runLint(files, defaultLintConfig());
    const debugFindings = result.findings.filter(
      (finding) => finding.check === "debug-artifacts",
    );
    expect(debugFindings).toEqual([
      expect.objectContaining({ path: "src/example.ts", line: 3 }),
    ]);

    const testFile = runLint(
      parseUnifiedDiff(
        [
          "diff --git a/tests/x.test.ts b/tests/x.test.ts",
          "--- a/tests/x.test.ts",
          "+++ b/tests/x.test.ts",
          "@@ -1 +1,2 @@",
          " const a = 1;",
          '+console.log("fine in tests");',
          "",
        ].join("\n"),
      ),
      defaultLintConfig(),
    );
    expect(
      testFile.findings.filter(
        (finding) => finding.check === "debug-artifacts",
      ),
    ).toEqual([]);
  });

  it("detects debug artifacts after decrement operators", () => {
    const result = runLint(
      parseUnifiedDiff(
        [
          "diff --git a/src/x.ts b/src/x.ts",
          "--- a/src/x.ts",
          "+++ b/src/x.ts",
          "@@ -0,0 +1,3 @@",
          '+while (count-- > 0) console.log("DEBUG:", count);',
          '+if (items[index]-- > 0) console.debug("DEBUG");',
          '+for (; remaining-- > 0;) console.trace("DEBUG");',
          "",
        ].join("\n"),
      ),
      defaultLintConfig(),
    );

    expect(
      result.findings
        .filter((finding) => finding.check === "debug-artifacts")
        .map((finding) => finding.line),
    ).toEqual([1, 2, 3]);
  });

  it("detects debug artifacts after JavaScript regex literals", () => {
    const stripped = stripNonExecutableText([
      {
        line: 1,
        text: String.raw`const isUrl = /^https?:\/\//.test(str); console.log(isUrl);`,
      },
    ]);
    expect(stripped[0]?.text).toContain("console.log");

    const result = runLint(
      parseUnifiedDiff(
        [
          "diff --git a/src/x.tsx b/src/x.tsx",
          "--- a/src/x.tsx",
          "+++ b/src/x.tsx",
          "@@ -0,0 +1,7 @@",
          String.raw`+const isUrl = /^https?:\/\//.test(str); console.log(isUrl);`,
          String.raw`+const slash = /[//]/; console.debug(slash);`,
          "+const ratio = total / count; console.trace(ratio);",
          String.raw`+const matcher = () => /^https?:\/\//; console.log(matcher);`,
          "+const node = <div></div>; console.log(node);",
          "+const debugPattern = /console.log/;",
          "+const safe = 1; // console.log(safe);",
          "",
        ].join("\n"),
      ),
      defaultLintConfig(),
    );

    expect(
      result.findings
        .filter((finding) => finding.check === "debug-artifacts")
        .map((finding) => finding.line),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it("still strips dash comments in languages that support them", () => {
    const config = defaultLintConfig();
    config.debugPatterns = [
      ...config.debugPatterns,
      String.raw`\bcustom_debug\s*\(`,
    ];
    const result = runLint(
      parseUnifiedDiff(
        [
          "diff --git a/src/query.sql b/src/query.sql",
          "--- a/src/query.sql",
          "+++ b/src/query.sql",
          "@@ -0,0 +1,2 @@",
          "+SELECT 1; -- custom_debug() is only documentation",
          "+SELECT custom_debug();",
          "",
        ].join("\n"),
      ),
      config,
    );

    expect(
      result.findings
        .filter((finding) => finding.check === "debug-artifacts")
        .map((finding) => finding.line),
    ).toEqual([2]);
  });

  it("ignores debug-like text in comments and strings", () => {
    const result = runLint(
      parseUnifiedDiff(
        [
          "diff --git a/src/x.ts b/src/x.ts",
          "--- a/src/x.ts",
          "+++ b/src/x.ts",
          "@@ -0,0 +1,12 @@",
          '+// console.log("commented");',
          "+/* debugger; */",
          "+/*",
          "+ * breakpoint()",
          "+ */",
          "+# pdb.set_trace()",
          "+-- var_dump()",
          '+const example = "binding.pry";',
          "+const template = `To debug, use console.log()`;",
          '+const nested = `outer ${`console.log("text")`} end`;',
          '+const expressionString = `${"console.log("}`;',
          '+const commentedExpression = `${/* console.log("comment") */ value}`;',
          "",
        ].join("\n"),
      ),
      defaultLintConfig(),
    );

    expect(
      result.findings.filter(
        (finding) => finding.check === "debug-artifacts",
      ),
    ).toEqual([]);
  });

  it("handles hash syntax according to the source language", () => {
    const result = runLint(
      parseUnifiedDiff(
        [
          "diff --git a/src/x.py b/src/x.py",
          "--- a/src/x.py",
          "+++ b/src/x.py",
          "@@ -0,0 +1 @@",
          "+result=calc()#pdb.set_trace()",
          "diff --git a/src/x.rb b/src/x.rb",
          "--- a/src/x.rb",
          "+++ b/src/x.rb",
          "@@ -0,0 +1 @@",
          "+result=calc#binding.pry",
          "diff --git a/src/x.php b/src/x.php",
          "--- a/src/x.php",
          "+++ b/src/x.php",
          "@@ -0,0 +1 @@",
          "+$result=calc()#var_dump()",
          "diff --git a/src/x.sh b/src/x.sh",
          "--- a/src/x.sh",
          "+++ b/src/x.sh",
          "@@ -0,0 +1 @@",
          "+result=$(process)#debugger",
          "diff --git a/src/x.ts b/src/x.ts",
          "--- a/src/x.ts",
          "+++ b/src/x.ts",
          "@@ -0,0 +1,4 @@",
          "+this.#debugger;",
          "+this.#console.log(data);",
          "+this.#var_dump(data);",
          "+this.#byebug;",
          "",
        ].join("\n"),
      ),
      defaultLintConfig(),
    );

    expect(
      result.findings.filter(
        (finding) => finding.check === "debug-artifacts",
      ),
    ).toEqual([]);
  });

  it("applies built-in debug patterns only to their languages", () => {
    const result = runLint(
      parseUnifiedDiff(
        [
          "diff --git a/src/x.py b/src/x.py",
          "--- a/src/x.py",
          "+++ b/src/x.py",
          "@@ -0,0 +1,2 @@",
          "+pdb.set_trace()",
          "+breakpoint()",
          "diff --git a/src/x.rb b/src/x.rb",
          "--- a/src/x.rb",
          "+++ b/src/x.rb",
          "@@ -0,0 +1,2 @@",
          "+binding.pry",
          "+byebug",
          "diff --git a/src/x.php b/src/x.php",
          "--- a/src/x.php",
          "+++ b/src/x.php",
          "@@ -0,0 +1 @@",
          "+var_dump($value)",
          "",
        ].join("\n"),
      ),
      defaultLintConfig(),
    );

    expect(
      result.findings
        .filter((finding) => finding.check === "debug-artifacts")
        .map((finding) => `${finding.path}:${finding.line}`),
    ).toEqual([
      "src/x.php:1",
      "src/x.py:1",
      "src/x.py:2",
      "src/x.rb:1",
      "src/x.rb:2",
    ]);
  });

  it("keeps custom debug patterns language-neutral", () => {
    const config = defaultLintConfig();
    config.debugPatterns = [
      ...config.debugPatterns,
      String.raw`\bcustom_debug\s*\(`,
    ];
    const result = runLint(
      parseUnifiedDiff(
        [
          "diff --git a/src/x.sh b/src/x.sh",
          "--- a/src/x.sh",
          "+++ b/src/x.sh",
          "@@ -0,0 +1 @@",
          "+custom_debug(value)",
          "",
        ].join("\n"),
      ),
      config,
    );

    expect(
      result.findings.filter(
        (finding) => finding.check === "debug-artifacts",
      ),
    ).toHaveLength(1);
  });

  it("flags debug statements inside template expressions", () => {
    const result = runLint(
      parseUnifiedDiff(
        [
          "diff --git a/src/x.ts b/src/x.ts",
          "--- a/src/x.ts",
          "+++ b/src/x.ts",
          "@@ -0,0 +1,6 @@",
          '+const simple = `${console.log("debug")}`;',
          '+const nested = `outer ${`inner ${console.debug("debug")}`}`;',
          '+const object = `${({ value: console.trace("debug"), text: "}" }).value}`;',
          "+const multiline = `outer ${",
          '+console.trace("debug");',
          "+}`;",
          "",
        ].join("\n"),
      ),
      defaultLintConfig(),
    );
    const debugFindings = result.findings.filter(
      (finding) => finding.check === "debug-artifacts",
    );

    expect(debugFindings.map((finding) => finding.line)).toEqual([1, 2, 3, 5]);
  });

  it("flags active debug statements with trailing comments", () => {
    const result = runLint(
      parseUnifiedDiff(
        [
          "diff --git a/src/x.ts b/src/x.ts",
          "--- a/src/x.ts",
          "+++ b/src/x.ts",
          "@@ -0,0 +1,3 @@",
          "+debugger; // TODO: remove",
          '+console.log("active"); /* temporary */',
          '+const url = "https://example.com"; console.debug(url);',
          "",
        ].join("\n"),
      ),
      defaultLintConfig(),
    );
    const debugFindings = result.findings.filter(
      (finding) => finding.check === "debug-artifacts",
    );

    expect(debugFindings.map((finding) => finding.line)).toEqual([1, 2, 3]);
    expect(debugFindings[0]?.evidence).toBe("debugger; // TODO: remove");
  });

  it("warns when the diff exceeds the blast-radius limits", () => {
    const config = defaultLintConfig();
    config.maxFiles = 2;
    const result = runLint(files, config);
    const blast = result.findings.find(
      (finding) => finding.check === "blast-radius",
    );

    expect(blast?.message).toContain("4 files");
    expect(blast?.message).toContain("8 changed lines");
    expect(blast?.path).toBeUndefined();
  });

  it("stays quiet within the blast-radius limits", () => {
    const result = runLint(files, defaultLintConfig());
    expect(
      result.findings.filter((finding) => finding.check === "blast-radius"),
    ).toEqual([]);
  });

  it("runs only the requested checks", () => {
    const config = defaultLintConfig();
    config.checks = parseLintChecks("todo-comments");
    const result = runLint(files, config);

    expect(result.findings.map((finding) => finding.check)).toEqual([
      "todo-comments",
    ]);
  });

  it("rejects unknown check names", () => {
    expect(() => parseLintChecks("comment-quality,bogus")).toThrow(
      'Unknown check "bogus"',
    );
  });
});

describe("lint output formats", () => {
  const result = runLint(parseUnifiedDiff(SAMPLE_DIFF), defaultLintConfig());

  it("formats text findings with file:line locations", () => {
    const text = formatLint(result, "text", "0.0.0");
    expect(text).toContain("src/example.ts:2  comment-quality");
    expect(text).toContain("> Per the prompt, keep this here.");
    expect(text).toContain("3 findings");
  });

  it("formats JSON with the full result", () => {
    const parsed = JSON.parse(formatLint(result, "json", "0.0.0")) as {
      findings: unknown[];
      files: number;
    };
    expect(parsed.findings).toHaveLength(3);
    expect(parsed.files).toBe(4);
  });

  it("formats GitHub Actions annotations", () => {
    const github = formatLint(result, "github", "0.0.0");
    expect(github).toContain(
      "::warning file=src/example.ts,line=2,title=codecut comment-quality::",
    );
  });

  it("formats valid minimal SARIF", () => {
    const sarif = JSON.parse(formatLint(result, "sarif", "0.1.2")) as {
      version: string;
      runs: {
        tool: { driver: { name: string; rules: unknown[] } };
        results: { ruleId: string; locations: unknown[] }[];
      }[];
    };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]?.tool.driver.name).toBe("codecut-lint");
    expect(sarif.runs[0]?.tool.driver.rules).toHaveLength(4);
    expect(sarif.runs[0]?.results).toHaveLength(3);
  });

  it("rejects unknown formats", () => {
    expect(() => formatLint(result, "xml", "0.0.0")).toThrow(
      'Unknown format "xml"',
    );
  });
});

describe("lint configuration", () => {
  it("uses defaults when no policy exists", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codecut-lint-"));
    const config = await resolveLintConfig(directory);

    expect([...config.checks]).toHaveLength(4);
    expect(config.maxFiles).toBe(12);
  });

  it("honors policy thresholds and explicit opt-outs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codecut-lint-"));
    await mkdir(path.join(directory, ".codecut"), { recursive: true });
    await writeFile(
      path.join(directory, ".codecut", "policy.json"),
      JSON.stringify({
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        agents: ["claude"],
        sources: ["CLAUDE.md"],
        rules: [
          {
            id: "blast-1",
            type: "blast-radius",
            directive: "Keep changes small",
            source: { path: "CLAUDE.md" },
            mode: "warn",
            maxFiles: 2,
            maxChangedLines: 10,
          },
          {
            id: "comment-1",
            type: "comment-quality",
            directive: "No agent context in comments",
            source: { path: "CLAUDE.md" },
            mode: "off",
            filePatterns: ["\\.ts$"],
            bannedPatterns: ["prompt"],
          },
        ],
      }),
      "utf8",
    );

    const config = await resolveLintConfig(directory);
    expect(config.maxFiles).toBe(2);
    expect(config.maxChangedLines).toBe(10);
    expect(config.checks.has("comment-quality")).toBe(false);

    const explicit = await resolveLintConfig(
      directory,
      parseLintChecks("comment-quality"),
    );
    expect(explicit.checks.has("comment-quality")).toBe(true);
  });
});

describe("lint command", () => {
  it("lints a patch file without git or setup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codecut-lint-"));
    await writeFile(path.join(directory, "changes.diff"), SAMPLE_DIFF, "utf8");

    const result = await runLintCommand({
      cwd: directory,
      patch: "changes.diff",
    });

    expect(result.files).toBe(4);
    expect(result.findings.map((finding) => finding.check).sort()).toEqual([
      "comment-quality",
      "debug-artifacts",
      "todo-comments",
    ]);
  });

  it("rejects conflicting diff sources", async () => {
    await expect(
      runLintCommand({ cwd: ".", staged: true, pr: "1" }),
    ).rejects.toThrow("only one of");
  });
});
