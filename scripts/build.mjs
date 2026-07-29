import { execFileSync } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const dist = path.join(repositoryRoot, "dist");

await rm(dist, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [
    path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    path.join(repositoryRoot, "tsconfig.json"),
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);
await build({
  entryPoints: [path.join(repositoryRoot, "src", "cli.ts")],
  outfile: path.join(dist, "codecut.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
});
await chmod(path.join(dist, "codecut.cjs"), 0o755);
