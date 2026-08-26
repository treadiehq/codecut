import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const GITHUB_INSPECTION_TIMEOUT_MS = 8_000;

export type GithubPrEvidence =
  | {
      status: "ready";
      branch: string;
      headOid: string;
      url: string;
    }
  | {
      status: "missing";
      branch: string;
      headOid: string;
    }
  | {
      status: "draft";
      branch: string;
      headOid: string;
      url: string;
    }
  | {
      status: "stale";
      branch: string;
      headOid: string;
      prHeadOid: string;
      url: string;
    }
  | {
      status: "unverified";
      reason:
        | "not-git"
        | "no-head"
        | "detached-head"
        | "gh-missing"
        | "gh-auth"
        | "timeout"
        | "github-unavailable"
        | "invalid-response";
    };

export type GithubCommandRunner = (
  command: "git" | "gh",
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    env: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string; stderr?: string }>;

const pullRequestListSchema = z.array(
  z.object({
    isDraft: z.boolean(),
    headRefOid: z.string().min(1),
    url: z.string().url(),
  }),
);

const defaultCommandRunner: GithubCommandRunner = async (
  command,
  args,
  options,
) => {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeout,
    maxBuffer: 1024 * 1024,
    env: options.env,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function errorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code: unknown }).code;
  return typeof code === "string" || typeof code === "number"
    ? code
    : undefined;
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const record = error as Record<string, unknown>;
  return `${String(record.stderr ?? "")} ${String(record.message ?? "")}`;
}

function timedOut(error: unknown): boolean {
  const code = errorCode(error);
  if (code === "ETIMEDOUT") {
    return true;
  }
  return Boolean(
    error &&
      typeof error === "object" &&
      (("killed" in error && (error as { killed: unknown }).killed === true) ||
        ("signal" in error &&
          (error as { signal: unknown }).signal === "SIGTERM")),
  );
}

async function run(
  runner: GithubCommandRunner,
  command: "git" | "gh",
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr?: string }> {
  return runner(command, args, {
    cwd,
    timeout: GITHUB_INSPECTION_TIMEOUT_MS,
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
}

export async function inspectGithubPullRequest(
  cwd: string,
  runner: GithubCommandRunner = defaultCommandRunner,
): Promise<GithubPrEvidence> {
  let gitRoot: string;
  try {
    gitRoot = (
      await run(runner, "git", ["rev-parse", "--show-toplevel"], cwd)
    ).stdout.trim();
  } catch (error) {
    if (timedOut(error)) {
      return { status: "unverified", reason: "timeout" };
    }
    return { status: "unverified", reason: "not-git" };
  }
  if (!gitRoot) {
    return { status: "unverified", reason: "not-git" };
  }

  let headOid: string;
  try {
    headOid = (
      await run(runner, "git", ["rev-parse", "--verify", "HEAD"], gitRoot)
    ).stdout.trim();
  } catch (error) {
    if (timedOut(error)) {
      return { status: "unverified", reason: "timeout" };
    }
    return { status: "unverified", reason: "no-head" };
  }
  if (!headOid) {
    return { status: "unverified", reason: "no-head" };
  }

  let branch: string;
  try {
    branch = (
      await run(runner, "git", ["branch", "--show-current"], gitRoot)
    ).stdout.trim();
  } catch (error) {
    if (timedOut(error)) {
      return { status: "unverified", reason: "timeout" };
    }
    return { status: "unverified", reason: "detached-head" };
  }
  if (!branch) {
    return { status: "unverified", reason: "detached-head" };
  }

  let output: string;
  try {
    output = (
      await run(
        runner,
        "gh",
        [
          "pr",
          "list",
          "--state",
          "open",
          "--head",
          branch,
          "--json",
          "isDraft,headRefOid,url",
          "--limit",
          "100",
        ],
        gitRoot,
      )
    ).stdout;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { status: "unverified", reason: "gh-missing" };
    }
    if (
      errorCode(error) === 4 ||
      /\b(?:authenticate|authentication|auth login|not logged)\b/i.test(
        errorText(error),
      )
    ) {
      return { status: "unverified", reason: "gh-auth" };
    }
    if (timedOut(error)) {
      return { status: "unverified", reason: "timeout" };
    }
    return { status: "unverified", reason: "github-unavailable" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { status: "unverified", reason: "invalid-response" };
  }
  const result = pullRequestListSchema.safeParse(parsed);
  if (!result.success) {
    return { status: "unverified", reason: "invalid-response" };
  }

  const current = result.data.filter((pullRequest) =>
    pullRequest.headRefOid.toLowerCase() === headOid.toLowerCase(),
  );
  const ready = current.find((pullRequest) => !pullRequest.isDraft);
  if (ready) {
    return { status: "ready", branch, headOid, url: ready.url };
  }
  const draft = current.find((pullRequest) => pullRequest.isDraft);
  if (draft) {
    return { status: "draft", branch, headOid, url: draft.url };
  }
  const stale = result.data[0];
  if (stale) {
    return {
      status: "stale",
      branch,
      headOid,
      prHeadOid: stale.headRefOid,
      url: stale.url,
    };
  }
  return { status: "missing", branch, headOid };
}
