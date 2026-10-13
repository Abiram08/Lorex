/** Build only current source files; never ship stale output from a prior build. */
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = join(root, "dist");
if (dirname(output) !== root) throw new Error("refusing to clean outside the project");
rmSync(output, { recursive: true, force: true });

const compiler = join(root, "node_modules", "typescript", "bin", "tsc");
const result = spawnSync(process.execPath, [compiler, "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
