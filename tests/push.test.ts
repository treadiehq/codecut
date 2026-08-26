import { describe, expect, it } from "vitest";
import {
  inspectOutgoingPush,
  isGitPushCommand,
  type PushCommandRunner,
} from "../src/core/push.js";

function runner(
  responses: Record<string, string | Error>,
): PushCommandRunner {
  return async (_command, args) => {
    const key = args.join(" ");
    const response = responses[key];
    if (response instanceof Error) {
      throw response;
    }
    if (response === undefined) {
      throw Object.assign(new Error(`missing fixture: ${key}`), { code: 1 });
    }
    return { stdout: response };
  };
}

describe("git push command detection", () => {
  it.each([
    "git push",
    "npm test && git push --force-with-lease",
    "env CI=1 command git -c push.default=current push origin HEAD",
    "/usr/bin/git -C ./nested push -u origin HEAD",
    "cd nested && git push",
  ])("recognizes a push command: %s", (command) => {
    expect(isGitPushCommand(command)).toBe(true);
  });

  it.each([
    "git status",
    "echo git push",
    'printf "%s" "git push"',
    "git commit -m 'mention git push'",
  ])("does not mistake text for a push command: %s", (command) => {
    expect(isGitPushCommand(command)).toBe(false);
  });
});

describe("outgoing push inspection", () => {
  const head = "2222222222222222222222222222222222222222";
  const base = "1111111111111111111111111111111111111111";

  it("uses the current branch's remote-tracking commit", async () => {
    const inspect = runner({
      "rev-parse --show-toplevel": "/repo\n",
      "rev-parse --verify HEAD": `${head}\n`,
      "branch --show-current": "feature/example\n",
      "config --get branch.feature/example.remote": "origin\n",
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}":
        "origin/feature/example\n",
      "rev-parse --verify --quiet refs/remotes/origin/feature/example^{commit}":
        `${base}\n`,
    });

    await expect(inspectOutgoingPush("git push", "/repo", inspect)).resolves.toEqual({
      status: "ready",
      cwd: "/repo",
      branch: "feature/example",
      remote: "origin",
      destination: "feature/example",
      base: "refs/remotes/origin/feature/example",
      range: `${base}..${head}`,
    });
  });

  it("falls back to the remote default branch for a new branch", async () => {
    const missing = Object.assign(new Error("missing ref"), { code: 1 });
    const inspect = runner({
      "rev-parse --show-toplevel": "/repo\n",
      "rev-parse --verify HEAD": `${head}\n`,
      "branch --show-current": "feature/new\n",
      "config --get branch.feature/new.remote": missing,
      "rev-parse --verify --quiet refs/remotes/origin/feature/new^{commit}":
        missing,
      "rev-parse --abbrev-ref --symbolic-full-name @{upstream}": missing,
      "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/main\n",
      "rev-parse --verify --quiet origin/main^{commit}": `${base}\n`,
    });

    const result = await inspectOutgoingPush(
      "git push -u origin HEAD",
      "/repo",
      inspect,
    );
    expect(result).toMatchObject({
      status: "ready",
      branch: "feature/new",
      remote: "origin",
      destination: "feature/new",
      base: "origin/main",
      range: `${base}..${head}`,
    });
  });

  it("marks multi-branch and directory-changing pushes unverified", async () => {
    const unused = runner({});
    await expect(
      inspectOutgoingPush("git push --all", "/repo", unused),
    ).resolves.toEqual({
      status: "unverified",
      reason: "unsupported-command",
    });
    await expect(
      inspectOutgoingPush("cd nested && git push", "/repo", unused),
    ).resolves.toEqual({
      status: "unverified",
      reason: "unsupported-command",
    });
  });

  it("reports a bounded Git timeout", async () => {
    const timeout = Object.assign(new Error("timed out"), {
      code: "ETIMEDOUT",
    });
    await expect(
      inspectOutgoingPush(
        "git push",
        "/repo",
        runner({ "rev-parse --show-toplevel": timeout }),
      ),
    ).resolves.toEqual({
      status: "unverified",
      reason: "timeout",
    });
  });
});
