import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import type { LintCheck } from "./schema.js";

const execFileAsync = promisify(execFile);
const PUSH_INSPECTION_TIMEOUT_MS = 4_000;

export type PushLintFinding = {
  check: LintCheck;
  path?: string;
  line?: number;
  message: string;
};

export type PushLintEvidence =
  | {
      status: "clean";
      branch: string;
      base: string;
      range: string;
      files: number;
    }
  | {
      status: "findings";
      branch: string;
      base: string;
      range: string;
      files: number;
      findings: PushLintFinding[];
    }
  | {
      status: "unverified";
      reason:
        | "not-git"
        | "no-head"
        | "detached-head"
        | "unsupported-command"
        | "no-base"
        | "timeout"
        | "git-error";
    };

export type OutgoingPushTarget =
  | {
      status: "ready";
      cwd: string;
      branch: string;
      remote: string;
      destination: string;
      base: string;
      range: string;
    }
  | Extract<PushLintEvidence, { status: "unverified" }>;

export type PushCommandRunner = (
  command: "git",
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    env: NodeJS.ProcessEnv;
  },
) => Promise<{ stdout: string; stderr?: string }>;

type ParsedPushInvocation =
  | { status: "supported"; cwd: string; args: string[] }
  | { status: "unsupported" };

class PushInspectionError extends Error {
  constructor(
    readonly reason: Extract<
      PushLintEvidence,
      { status: "unverified" }
    >["reason"],
  ) {
    super(reason);
  }
}

const defaultCommandRunner: PushCommandRunner = async (
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

function timedOut(error: unknown): boolean {
  if (errorCode(error) === "ETIMEDOUT") {
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

function shellSegments(command: string): string[][] | undefined {
  const segments: string[][] = [];
  let segment: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const finishWord = (): void => {
    if (word.length > 0) {
      segment.push(word);
      word = "";
    }
  };
  const finishSegment = (): void => {
    finishWord();
    if (segment.length > 0) {
      segments.push(segment);
      segment = [];
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        word += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      finishWord();
      if (character === "\n") {
        finishSegment();
      }
      continue;
    }
    if (character === ";" || character === "|" || character === "&") {
      finishSegment();
      if (command[index + 1] === character) {
        index += 1;
      }
      continue;
    }
    if (character === "#" && word.length === 0) {
      while (index + 1 < command.length && command[index + 1] !== "\n") {
        index += 1;
      }
      continue;
    }
    word += character;
  }

  if (quote || escaped) {
    return undefined;
  }
  finishSegment();
  return segments;
}

function executableIndex(words: string[]): number {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) {
    index += 1;
  }
  while (index < words.length) {
    const executable = path.basename(words[index] ?? "");
    if (executable === "command") {
      index += 1;
      while (/^-[pVv]+$/.test(words[index] ?? "")) {
        index += 1;
      }
      continue;
    }
    if (executable === "env") {
      index += 1;
      while (
        /^-/.test(words[index] ?? "") ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")
      ) {
        if (/^(?:-u|--unset)$/.test(words[index] ?? "")) {
          index += 1;
        }
        index += 1;
      }
      continue;
    }
    break;
  }
  return index;
}

function segmentChangesDirectory(words: string[]): boolean {
  const index = executableIndex(words);
  return path.basename(words[index] ?? "") === "cd";
}

function parseGitSegment(
  words: string[],
  cwd: string,
): ParsedPushInvocation | undefined {
  let index = executableIndex(words);
  if (path.basename(words[index] ?? "") !== "git") {
    return undefined;
  }
  index += 1;
  let gitCwd = cwd;
  while (index < words.length && words[index] !== "push") {
    const argument = words[index] ?? "";
    if (argument === "-C") {
      const directory = words[index + 1];
      if (!directory) {
        return { status: "unsupported" };
      }
      gitCwd = path.resolve(gitCwd, directory);
      index += 2;
      continue;
    }
    if (argument.startsWith("-C") && argument.length > 2) {
      gitCwd = path.resolve(gitCwd, argument.slice(2));
      index += 1;
      continue;
    }
    if (argument === "-c" || argument === "--config-env") {
      if (!words[index + 1]) {
        return { status: "unsupported" };
      }
      index += 2;
      continue;
    }
    if (
      argument === "--no-pager" ||
      argument === "--paginate" ||
      argument === "-P" ||
      argument === "-p" ||
      argument === "--literal-pathspecs" ||
      argument === "--glob-pathspecs" ||
      argument === "--noglob-pathspecs" ||
      argument === "--icase-pathspecs"
    ) {
      index += 1;
      continue;
    }
    return words.slice(index + 1).includes("push")
      ? { status: "unsupported" }
      : undefined;
  }
  if (words[index] !== "push") {
    return undefined;
  }
  return { status: "supported", cwd: gitCwd, args: words.slice(index + 1) };
}

function parseGitPushInvocation(
  command: string,
  cwd: string,
): ParsedPushInvocation | undefined {
  const segments = shellSegments(command);
  if (!segments) {
    return undefined;
  }
  let changedDirectory = false;
  let invocation: ParsedPushInvocation | undefined;
  for (const segment of segments) {
    const parsed = parseGitSegment(segment, cwd);
    if (parsed) {
      if (invocation || changedDirectory) {
        return { status: "unsupported" };
      }
      invocation = parsed;
    }
    if (segmentChangesDirectory(segment)) {
      changedDirectory = true;
    }
  }
  return invocation;
}

export function isGitPushCommand(command: string): boolean {
  return parseGitPushInvocation(command, process.cwd()) !== undefined;
}

function normalizeHeadRef(value: string): string | undefined {
  const normalized = value.replace(/^refs\/heads\//, "");
  return normalized && !normalized.startsWith("refs/") ? normalized : undefined;
}

function parsePushTarget(
  args: string[],
  branch: string,
):
  | { status: "ready"; remote?: string; destination: string }
  | { status: "unsupported" } {
  const positionals: string[] = [];
  let repositoryOption: string | undefined;
  const optionsWithValues = new Set([
    "--exec",
    "--receive-pack",
    "--push-option",
    "-o",
  ]);
  const unsupportedOptions = new Set([
    "--all",
    "--branches",
    "--delete",
    "--mirror",
    "--stdin",
    "--tags",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (unsupportedOptions.has(argument)) {
      return { status: "unsupported" };
    }
    if (argument === "--repo") {
      repositoryOption = args[index + 1];
      if (!repositoryOption) {
        return { status: "unsupported" };
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--repo=")) {
      repositoryOption = argument.slice("--repo=".length);
      continue;
    }
    if (optionsWithValues.has(argument)) {
      if (!args[index + 1]) {
        return { status: "unsupported" };
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      continue;
    }
    if (/[$`(){}]/.test(argument)) {
      return { status: "unsupported" };
    }
    positionals.push(argument);
  }

  const remote = repositoryOption ?? positionals.shift();
  if (positionals.length > 1) {
    return { status: "unsupported" };
  }
  const rawRefspec = positionals[0];
  if (!rawRefspec) {
    return { status: "ready", remote, destination: branch };
  }

  const refspec = rawRefspec.replace(/^\+/, "");
  const separator = refspec.indexOf(":");
  const source = separator === -1 ? refspec : refspec.slice(0, separator);
  const requestedDestination =
    separator === -1 ? refspec : refspec.slice(separator + 1);
  const normalizedSource = normalizeHeadRef(source);
  if (
    source !== "HEAD" &&
    normalizedSource !== branch
  ) {
    return { status: "unsupported" };
  }
  const destination =
    requestedDestination === "HEAD"
      ? branch
      : normalizeHeadRef(requestedDestination);
  if (!destination) {
    return { status: "unsupported" };
  }
  return { status: "ready", remote, destination };
}

async function run(
  runner: PushCommandRunner,
  args: string[],
  cwd: string,
): Promise<string> {
  return (
    await runner("git", args, {
      cwd,
      timeout: PUSH_INSPECTION_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
  ).stdout.trim();
}

async function requiredOutput(
  runner: PushCommandRunner,
  args: string[],
  cwd: string,
  reason: PushInspectionError["reason"],
): Promise<string> {
  try {
    const output = await run(runner, args, cwd);
    if (!output) {
      throw new PushInspectionError(reason);
    }
    return output;
  } catch (error) {
    if (error instanceof PushInspectionError) {
      throw error;
    }
    if (timedOut(error)) {
      throw new PushInspectionError("timeout");
    }
    throw new PushInspectionError(reason);
  }
}

async function optionalOutput(
  runner: PushCommandRunner,
  args: string[],
  cwd: string,
): Promise<string | undefined> {
  try {
    return (await run(runner, args, cwd)) || undefined;
  } catch (error) {
    if (timedOut(error)) {
      throw new PushInspectionError("timeout");
    }
    return undefined;
  }
}

export async function inspectOutgoingPush(
  command: string,
  cwd: string,
  runner: PushCommandRunner = defaultCommandRunner,
): Promise<OutgoingPushTarget | undefined> {
  const invocation = parseGitPushInvocation(command, cwd);
  if (!invocation) {
    return undefined;
  }
  if (invocation.status === "unsupported") {
    return { status: "unverified", reason: "unsupported-command" };
  }
  if (
    invocation.args.some((argument) =>
      [
        "--all",
        "--branches",
        "--delete",
        "--mirror",
        "--stdin",
        "--tags",
      ].includes(argument),
    )
  ) {
    return { status: "unverified", reason: "unsupported-command" };
  }

  try {
    const gitRoot = await requiredOutput(
      runner,
      ["rev-parse", "--show-toplevel"],
      invocation.cwd,
      "not-git",
    );
    const head = await requiredOutput(
      runner,
      ["rev-parse", "--verify", "HEAD"],
      gitRoot,
      "no-head",
    );
    const branch = await requiredOutput(
      runner,
      ["branch", "--show-current"],
      gitRoot,
      "detached-head",
    );
    const target = parsePushTarget(invocation.args, branch);
    if (target.status === "unsupported") {
      return { status: "unverified", reason: "unsupported-command" };
    }

    const configuredPushRemote = await optionalOutput(
      runner,
      ["config", "--get", `branch.${branch}.pushRemote`],
      gitRoot,
    );
    const defaultPushRemote = await optionalOutput(
      runner,
      ["config", "--get", "remote.pushDefault"],
      gitRoot,
    );
    const configuredRemote = await optionalOutput(
      runner,
      ["config", "--get", `branch.${branch}.remote`],
      gitRoot,
    );
    const remote =
      target.remote ??
      configuredPushRemote ??
      defaultPushRemote ??
      configuredRemote ??
      "origin";
    const candidates: string[] = [];
    if (remote === ".") {
      candidates.push(`refs/heads/${target.destination}`);
    } else {
      candidates.push(`refs/remotes/${remote}/${target.destination}`);
    }

    if (!target.remote) {
      const upstream = await optionalOutput(
        runner,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        gitRoot,
      );
      if (upstream) {
        candidates.push(upstream);
      }
    }

    if (remote !== ".") {
      const remoteHead = await optionalOutput(
        runner,
        ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
        gitRoot,
      );
      if (remoteHead) {
        candidates.push(remoteHead);
      }
      candidates.push(
        `refs/remotes/${remote}/main`,
        `refs/remotes/${remote}/master`,
      );
    }

    for (const candidate of [...new Set(candidates)]) {
      const base = await optionalOutput(
        runner,
        ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
        gitRoot,
      );
      if (base) {
        return {
          status: "ready",
          cwd: gitRoot,
          branch,
          remote,
          destination: target.destination,
          base: candidate,
          range: `${base}..${head}`,
        };
      }
    }
    return { status: "unverified", reason: "no-base" };
  } catch (error) {
    if (error instanceof PushInspectionError) {
      return { status: "unverified", reason: error.reason };
    }
    return { status: "unverified", reason: "git-error" };
  }
}
