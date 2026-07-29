import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { PROJECT_DIRECTORY } from "../core/project.js";

export const RUNTIME_RELATIVE_PATH = path.join(
  PROJECT_DIRECTORY,
  "runtime",
  process.platform === "win32" ? "codecut.exe" : "codecut",
);

export async function installRuntime(
  projectRoot: string,
  sourcePath: string,
): Promise<{ runtimePath: string; updated: boolean }> {
  const runtimePath = path.join(projectRoot, RUNTIME_RELATIVE_PATH);
  const source = await readFile(sourcePath);
  let current: Buffer | undefined;
  try {
    current = await readFile(runtimePath);
  } catch (error) {
    if (
      !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )
    ) {
      throw error;
    }
  }

  if (current?.equals(source)) {
    await chmod(runtimePath, 0o755);
    return { runtimePath, updated: false };
  }

  await mkdir(path.dirname(runtimePath), { recursive: true });
  const temporaryPath = `${runtimePath}.tmp`;
  await writeFile(temporaryPath, source, { mode: 0o755 });
  await chmod(temporaryPath, 0o755);
  await rename(temporaryPath, runtimePath);
  return { runtimePath, updated: true };
}
