import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  constants,
  open,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import {
  findProjectRoot,
} from "../core/project.js";
import { installClaudeHooks } from "../install/claude.js";
import { installCodexHooks } from "../install/codex.js";
import { installCursorHooks } from "../install/cursor.js";
import { installPolytokenHooks } from "../install/polytoken.js";
import { installRuntime } from "../install/runtime.js";

type Fetch = typeof globalThis.fetch;

type Release = {
  tag_name?: unknown;
  assets?: Array<{
    name?: unknown;
    browser_download_url?: unknown;
  }>;
};

export type UpdateResult = {
  currentVersion: string;
  latestVersion: string;
  updated: boolean;
  scheduled: boolean;
  checkedOnly: boolean;
  executablePath: string;
  refreshedAgents: string[];
  warnings: string[];
};

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "");
}

function versionParts(version: string): number[] {
  return normalizeVersion(version)
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function releaseAssetName(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): string {
  if (platform === "win32") {
    return "codecut-windows-x64.exe";
  }
  const operatingSystem =
    platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "";
  const architectureName =
    architecture === "x64"
      ? "x64"
      : architecture === "arm64"
        ? "arm64"
        : "";
  if (!operatingSystem || !architectureName) {
    throw new Error(
      `Codecut updates are not available for ${platform}/${architecture}.`,
    );
  }
  return `codecut-${operatingSystem}-${architectureName}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function download(
  fetchImpl: Fetch,
  url: string,
  destination: string,
): Promise<void> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/octet-stream",
      "User-Agent": "codecut-updater",
    },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) from ${url}`);
  }

  const file = await open(destination, "w", 0o755);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      await file.write(value);
    }
  } finally {
    reader.releaseLock();
    await file.close();
  }
  await chmod(destination, 0o755);
}

async function expectedChecksum(
  fetchImpl: Fetch,
  url: string,
  asset: string,
): Promise<string> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "text/plain",
      "User-Agent": "codecut-updater",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `Could not download release checksums (HTTP ${response.status}).`,
    );
  }
  const manifest = await response.text();
  for (const line of manifest.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match?.[2] === asset) {
      return match[1]!.toLowerCase();
    }
  }
  throw new Error(`SHA256SUMS does not contain a checksum for ${asset}.`);
}

async function fileChecksum(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function executableVersion(executablePath: string): string | undefined {
  const result = spawnSync(executablePath, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) {
    return undefined;
  }
  const match = result.stdout.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match?.[0];
}

async function refreshProject(
  cwd: string,
  binaryPath: string,
): Promise<{ agents: string[]; warnings: string[] }> {
  const projectRoot = await findProjectRoot(cwd);
  if (!projectRoot) {
    return { agents: [], warnings: [] };
  }

  const agents: string[] = [];
  const warnings: string[] = [];
  await installRuntime(projectRoot, binaryPath);
  const installers = [
    {
      agent: "claude",
      settings: path.join(projectRoot, ".claude", "settings.json"),
      install: installClaudeHooks,
    },
    {
      agent: "cursor",
      settings: path.join(projectRoot, ".cursor", "hooks.json"),
      install: installCursorHooks,
    },
    {
      agent: "codex",
      settings: path.join(projectRoot, ".codex", "hooks.json"),
      install: installCodexHooks,
    },
    {
      agent: "polytoken",
      settings: path.join(projectRoot, ".polytoken", "hooks.json"),
      install: installPolytokenHooks,
    },
  ];
  for (const installer of installers) {
    if (!(await fileExists(installer.settings))) {
      continue;
    }
    try {
      await installer.install(projectRoot);
      agents.push(installer.agent);
    } catch (error) {
      warnings.push(
        `${installer.agent} hooks were not refreshed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return { agents, warnings };
}

async function replaceUnixExecutable(
  executablePath: string,
  downloadedPath: string,
): Promise<void> {
  const backupPath = `${executablePath}.codecut-backup`;
  await rm(backupPath, { force: true });
  let backedUp = false;
  try {
    if (await fileExists(executablePath)) {
      await rename(executablePath, backupPath);
      backedUp = true;
    }
    await rename(downloadedPath, executablePath);
    await chmod(executablePath, 0o755);
    await rm(backupPath, { force: true });
  } catch (error) {
    if (backedUp && !(await fileExists(executablePath))) {
      await rename(backupPath, executablePath).catch(() => undefined);
    }
    throw error;
  }
}

function scheduleWindowsReplacement(
  executablePath: string,
  downloadedPath: string,
): void {
  const backupPath = `${executablePath}.codecut-backup`;
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const script = [
    `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue`,
    `$target = ${quote(executablePath)}`,
    `$download = ${quote(downloadedPath)}`,
    `$backup = ${quote(backupPath)}`,
    "Remove-Item $backup -Force -ErrorAction SilentlyContinue",
    "if (Test-Path $target) { Move-Item $target $backup -Force }",
    "try { Move-Item $download $target -Force; Remove-Item $backup -Force -ErrorAction SilentlyContinue }",
    "catch { if (Test-Path $backup) { Move-Item $backup $target -Force } }",
  ].join("; ");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

export async function updateCodecut(options: {
  currentVersion: string;
  executablePath: string;
  cwd: string;
  version?: string;
  force?: boolean;
  checkOnly?: boolean;
  repo?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  fetchImpl?: Fetch;
}): Promise<UpdateResult> {
  const currentVersion = normalizeVersion(options.currentVersion);
  const requestedVersion = options.version ?? "latest";
  const repo = options.repo ?? process.env.CODECUT_REPO ?? "treadiehq/codecut";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repository: ${repo}`);
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const asset = releaseAssetName(options.platform, options.architecture);
  let latestVersion: string;
  let downloadUrl: string;
  let checksumUrl: string;

  if (requestedVersion === "latest") {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repo}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `codecut/${currentVersion}`,
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `Could not check the latest Codecut release (GitHub returned ${response.status}).`,
      );
    }
    const release = (await response.json()) as Release;
    if (typeof release.tag_name !== "string") {
      throw new Error("The latest Codecut release has no version tag.");
    }
    latestVersion = normalizeVersion(release.tag_name);
    const releaseAsset = release.assets?.find((candidate) => candidate.name === asset);
    if (typeof releaseAsset?.browser_download_url !== "string") {
      throw new Error(`The latest Codecut release does not include ${asset}.`);
    }
    const checksumAsset = release.assets?.find(
      (candidate) => candidate.name === "SHA256SUMS",
    );
    if (typeof checksumAsset?.browser_download_url !== "string") {
      throw new Error("The latest Codecut release does not include SHA256SUMS.");
    }
    downloadUrl = releaseAsset.browser_download_url;
    checksumUrl = checksumAsset.browser_download_url;
  } else {
    latestVersion = normalizeVersion(requestedVersion);
    const releaseUrl = `https://github.com/${repo}/releases/download/v${latestVersion}`;
    downloadUrl = `${releaseUrl}/${asset}`;
    checksumUrl = `${releaseUrl}/SHA256SUMS`;
  }

  const shouldUpdate =
    options.force === true || compareVersions(latestVersion, currentVersion) > 0;
  const baseResult = {
    currentVersion,
    latestVersion,
    executablePath: options.executablePath,
    refreshedAgents: [] as string[],
    warnings: [] as string[],
  };
  if (options.checkOnly) {
    return {
      ...baseResult,
      updated: false,
      scheduled: false,
      checkedOnly: true,
    };
  }

  const executablePath = path.resolve(options.executablePath);
  if (!shouldUpdate) {
    try {
      const refreshed = await refreshProject(options.cwd, executablePath);
      baseResult.refreshedAgents = refreshed.agents;
      baseResult.warnings = refreshed.warnings;
    } catch (error) {
      baseResult.warnings.push(
        `The current project runtime was not refreshed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return {
      ...baseResult,
      updated: false,
      scheduled: false,
      checkedOnly: false,
    };
  }

  try {
    await access(path.dirname(executablePath), constants.W_OK);
  } catch {
    throw new Error(
      `Cannot update ${executablePath} because its directory is not writable.`,
    );
  }
  const downloadedPath = `${executablePath}.codecut-update-${process.pid}`;
  await rm(downloadedPath, { force: true });
  let scheduled = false;
  try {
    await download(fetchImpl, downloadUrl, downloadedPath);
    const expected = await expectedChecksum(fetchImpl, checksumUrl, asset);
    const actual = await fileChecksum(downloadedPath);
    if (actual !== expected) {
      throw new Error(
        `Checksum verification failed for ${asset}; the existing install was not changed.`,
      );
    }
    const downloadedVersion = executableVersion(downloadedPath);
    if (downloadedVersion !== latestVersion) {
      throw new Error(
        `Downloaded Codecut ${downloadedVersion ?? "could not run"}; expected ${latestVersion}. The existing install was not changed.`,
      );
    }

    let refreshed = { agents: [] as string[], warnings: [] as string[] };
    try {
      refreshed = await refreshProject(options.cwd, downloadedPath);
    } catch (error) {
      refreshed.warnings.push(
        `The current project runtime was not refreshed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if ((options.platform ?? process.platform) === "win32") {
      scheduleWindowsReplacement(executablePath, downloadedPath);
      scheduled = true;
    } else {
      await replaceUnixExecutable(executablePath, downloadedPath);
    }
    return {
      ...baseResult,
      updated: true,
      scheduled,
      checkedOnly: false,
      refreshedAgents: refreshed.agents,
      warnings: refreshed.warnings,
    };
  } finally {
    if (!scheduled) {
      await rm(downloadedPath, { force: true });
    }
  }
}
