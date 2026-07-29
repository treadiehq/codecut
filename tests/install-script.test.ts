import { spawnSync } from "node:child_process";
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
import { releaseAssetName } from "../src/commands/update.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Unix installer checksum verification", () => {
  it("installs a matching binary and preserves an install on mismatch", async () => {
    if (process.platform === "win32") {
      return;
    }

    const directory = await mkdtemp(
      path.join(os.tmpdir(), "codecut-installer-"),
    );
    temporaryDirectories.push(directory);
    const tools = path.join(directory, "tools");
    const destination = path.join(directory, "bin");
    await mkdir(tools, { recursive: true });
    const binary = path.join(directory, "release-binary");
    const manifest = path.join(directory, "SHA256SUMS");
    const binaryContents = "#!/bin/sh\necho 9.9.9\n";
    await writeFile(binary, binaryContents);
    await chmod(binary, 0o755);
    const asset = releaseAssetName();
    const checksum = createHash("sha256")
      .update(binaryContents)
      .digest("hex");
    await writeFile(manifest, `${checksum}  ${asset}\n`);

    const fakeCurl = path.join(tools, "curl");
    await writeFile(
      fakeCurl,
      [
        "#!/bin/sh",
        'output=""',
        'url=""',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    -o) output="$2"; shift 2 ;;',
        '    -*) shift ;;',
        '    *) url="$1"; shift ;;',
        "  esac",
        "done",
        'case "$url" in',
        '  */SHA256SUMS) cp "$FAKE_MANIFEST" "$output" ;;',
        '  *) cp "$FAKE_BINARY" "$output" ;;',
        "esac",
      ].join("\n"),
    );
    await chmod(fakeCurl, 0o755);

    const environment = {
      ...process.env,
      PATH: `${tools}:${process.env.PATH ?? ""}`,
      CODECUT_BIN_DIR: destination,
      CODECUT_REPO: "example/codecut",
      CODECUT_VERSION: "v9.9.9",
      FAKE_BINARY: binary,
      FAKE_MANIFEST: manifest,
    };
    const installer = path.join(process.cwd(), "scripts", "install.sh");
    const success = spawnSync("bash", [installer], {
      encoding: "utf8",
      env: environment,
    });

    expect(success.status, success.stderr).toBe(0);
    expect(success.stdout).toContain("Verified SHA-256 checksum");
    expect(await readFile(path.join(destination, "codecut"), "utf8")).toBe(
      binaryContents,
    );

    const existing = "#!/bin/sh\necho existing\n";
    await writeFile(path.join(destination, "codecut"), existing);
    await writeFile(manifest, `${"0".repeat(64)}  ${asset}\n`);
    const failure = spawnSync("bash", [installer], {
      encoding: "utf8",
      env: environment,
    });

    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain("Checksum verification failed");
    expect(await readFile(path.join(destination, "codecut"), "utf8")).toBe(
      existing,
    );
  });
});
