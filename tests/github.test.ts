import { describe, expect, it } from "vitest";
import {
  inspectGithubPullRequest,
  type GithubCommandRunner,
} from "../src/core/github.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const URL = "https://github.com/example/repository/pull/42";

function commandError(
  code: string | number,
  message = "",
): Error & { code: string | number; stderr: string } {
  return Object.assign(new Error(message), { code, stderr: message });
}

function runnerWith(
  gh: () => Promise<{ stdout: string; stderr?: string }>,
  overrides: {
    root?: () => Promise<{ stdout: string }>;
    head?: () => Promise<{ stdout: string }>;
    branch?: () => Promise<{ stdout: string }>;
  } = {},
): GithubCommandRunner {
  return async (command, args, options) => {
    expect(options.timeout).toBe(8_000);
    expect(options.env.GH_PROMPT_DISABLED).toBe("1");
    if (command === "gh") {
      expect(args).toEqual([
        "pr",
        "list",
        "--state",
        "open",
        "--head",
        "feature/example",
        "--json",
        "isDraft,headRefOid,url",
        "--limit",
        "100",
      ]);
      return gh();
    }
    if (args.includes("--show-toplevel")) {
      return (overrides.root ?? (async () => ({ stdout: "/repo\n" })))();
    }
    if (args.includes("--verify")) {
      return (overrides.head ?? (async () => ({ stdout: `${HEAD}\n` })))();
    }
    return (
      overrides.branch ??
      (async () => ({ stdout: "feature/example\n" }))
    )();
  };
}

function ghOutput(
  pullRequests: Array<{
    isDraft: boolean;
    headRefOid: string;
    url?: string;
  }>,
): () => Promise<{ stdout: string }> {
  return async () => ({
    stdout: JSON.stringify(
      pullRequests.map((pullRequest) => ({
        ...pullRequest,
        url: pullRequest.url ?? URL,
      })),
    ),
  });
}

describe("GitHub PR inspection", () => {
  it("accepts an open non-draft PR at the current HEAD", async () => {
    await expect(
      inspectGithubPullRequest(
        "/work",
        runnerWith(ghOutput([{ isDraft: false, headRefOid: HEAD }])),
      ),
    ).resolves.toEqual({
      status: "ready",
      branch: "feature/example",
      headOid: HEAD,
      url: URL,
    });
  });

  it("distinguishes draft, missing, and stale PRs", async () => {
    await expect(
      inspectGithubPullRequest(
        "/work",
        runnerWith(ghOutput([{ isDraft: true, headRefOid: HEAD }])),
      ),
    ).resolves.toMatchObject({ status: "draft", url: URL });

    await expect(
      inspectGithubPullRequest("/work", runnerWith(ghOutput([]))),
    ).resolves.toMatchObject({
      status: "missing",
      branch: "feature/example",
      headOid: HEAD,
    });

    await expect(
      inspectGithubPullRequest(
        "/work",
        runnerWith(ghOutput([{ isDraft: false, headRefOid: OTHER_HEAD }])),
      ),
    ).resolves.toMatchObject({
      status: "stale",
      headOid: HEAD,
      prHeadOid: OTHER_HEAD,
      url: URL,
    });
  });

  it.each([
    ["missing GitHub CLI", commandError("ENOENT"), "gh-missing"],
    ["missing authentication", commandError(4), "gh-auth"],
    [
      "authentication error text",
      commandError(1, "please run gh auth login"),
      "gh-auth",
    ],
    [
      "timeout",
      Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }),
      "timeout",
    ],
    ["provider failure", commandError(1, "network unavailable"), "github-unavailable"],
  ])("returns unverified for %s", async (_name, error, reason) => {
    await expect(
      inspectGithubPullRequest(
        "/work",
        runnerWith(async () => {
          throw error;
        }),
      ),
    ).resolves.toEqual({ status: "unverified", reason });
  });

  it("returns unverified for malformed GitHub output", async () => {
    await expect(
      inspectGithubPullRequest(
        "/work",
        runnerWith(async () => ({ stdout: "not json" })),
      ),
    ).resolves.toEqual({
      status: "unverified",
      reason: "invalid-response",
    });
  });

  it("returns unverified outside a usable branch", async () => {
    const notGit = runnerWith(ghOutput([]), {
      root: async () => {
        throw commandError(128);
      },
    });
    await expect(inspectGithubPullRequest("/work", notGit)).resolves.toEqual({
      status: "unverified",
      reason: "not-git",
    });

    const noHead = runnerWith(ghOutput([]), {
      head: async () => {
        throw commandError(128);
      },
    });
    await expect(inspectGithubPullRequest("/work", noHead)).resolves.toEqual({
      status: "unverified",
      reason: "no-head",
    });

    const detached = runnerWith(ghOutput([]), {
      branch: async () => ({ stdout: "" }),
    });
    await expect(inspectGithubPullRequest("/work", detached)).resolves.toEqual({
      status: "unverified",
      reason: "detached-head",
    });
  });
});
