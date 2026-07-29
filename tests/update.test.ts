import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  releaseAssetName,
  updateCodecut,
} from "../src/commands/update.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function releaseFetch(
  binary: string,
  checksum = createHash("sha256").update(binary).digest("hex"),
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes("/releases/latest")) {
      return new Response(
        JSON.stringify({
          tag_name: "v0.2.0",
          assets: [
            {
              name: "codecut-darwin-arm64",
              browser_download_url: "https://download.test/codecut",
            },
            {
              name: "SHA256SUMS",
              browser_download_url: "https://download.test/SHA256SUMS",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === "https://download.test/codecut") {
      return new Response(binary, { status: 200 });
    }
    if (url === "https://download.test/SHA256SUMS") {
      return new Response(
        `${checksum}  codecut-darwin-arm64\n`,
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("self updates", () => {
  it("selects release assets for supported platforms", () => {
    expect(releaseAssetName("darwin", "arm64")).toBe(
      "codecut-darwin-arm64",
    );
    expect(releaseAssetName("linux", "x64")).toBe("codecut-linux-x64");
    expect(releaseAssetName("win32", "arm64")).toBe(
      "codecut-windows-x64.exe",
    );
    expect(() => releaseAssetName("freebsd", "x64")).toThrow(
      "not available",
    );
  });

  it("compares semantic release versions", () => {
    expect(compareVersions("0.2.0", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.4.2", "2.0.0")).toBeLessThan(0);
  });

  it("downloads, validates, and atomically replaces the executable", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codecut-update-"));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "codecut");
    await writeFile(executable, "#!/bin/sh\necho 0.1.0\n");
    await chmod(executable, 0o755);
    const replacement = "#!/bin/sh\necho 0.2.0\n";

    const result = await updateCodecut({
      currentVersion: "0.1.0",
      executablePath: executable,
      cwd: directory,
      platform: "darwin",
      architecture: "arm64",
      fetchImpl: releaseFetch(replacement),
    });

    expect(result).toMatchObject({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      updated: true,
      scheduled: false,
    });
    expect(await readFile(executable, "utf8")).toBe(replacement);
    expect(execFileSync(executable, ["--version"], { encoding: "utf8" })).toBe(
      "0.2.0\n",
    );
  });

  it("rejects a binary that does not match the published checksum", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "codecut-checksum-"),
    );
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "codecut");
    const original = "#!/bin/sh\necho 0.1.0\n";
    await writeFile(executable, original);
    await chmod(executable, 0o755);

    await expect(
      updateCodecut({
        currentVersion: "0.1.0",
        executablePath: executable,
        cwd: directory,
        platform: "darwin",
        architecture: "arm64",
        fetchImpl: releaseFetch(
          "#!/bin/sh\necho 0.2.0\n",
          "0".repeat(64),
        ),
      }),
    ).rejects.toThrow("Checksum verification failed");
    expect(await readFile(executable, "utf8")).toBe(original);
  });

  it("checks for updates without downloading the binary", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codecut-check-"));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "codecut");
    await writeFile(executable, "#!/bin/sh\necho 0.1.0\n");
    await chmod(executable, 0o755);
    let downloads = 0;
    const baseFetch = releaseFetch("#!/bin/sh\necho 0.2.0\n");
    const fetchImpl = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url === "https://download.test/codecut") {
        downloads += 1;
      }
      return baseFetch(input, init);
    }) as typeof fetch;

    const result = await updateCodecut({
      currentVersion: "0.1.0",
      executablePath: executable,
      cwd: directory,
      platform: "darwin",
      architecture: "arm64",
      checkOnly: true,
      fetchImpl,
    });

    expect(result.updated).toBe(false);
    expect(result.checkedOnly).toBe(true);
    expect(result.latestVersion).toBe("0.2.0");
    expect(downloads).toBe(0);
  });

  it("refreshes the project runtime when the CLI is already current", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codecut-current-"));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "codecut");
    const currentBinary = "#!/bin/sh\necho 0.2.0\n";
    await writeFile(executable, currentBinary);
    await chmod(executable, 0o755);
    await mkdir(path.join(directory, ".codecut"), { recursive: true });
    await writeFile(path.join(directory, ".codecut", "policy.json"), "{}");

    const result = await updateCodecut({
      currentVersion: "0.2.0",
      executablePath: executable,
      cwd: directory,
      platform: "darwin",
      architecture: "arm64",
      fetchImpl: releaseFetch(currentBinary),
    });

    expect(result.updated).toBe(false);
    expect(
      await readFile(path.join(directory, ".codecut", "runtime", "codecut"), "utf8"),
    ).toBe(currentBinary);
  });
});
