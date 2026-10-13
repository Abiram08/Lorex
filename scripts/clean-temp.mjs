/**
 * Remove stale Lorex test homes from the OS temp directory.
 *
 * The test suites isolate state in `lorex-*` directories under the system temp
 * folder; some suites leak theirs on failure. Two lifecycle hooks keep the
 * debris bounded:
 *   - `pretest`  (default mode): removes homes older than one hour, so a suite
 *     that is running right now is never disturbed.
 *   - `posttest` (`--all`): removes every remaining home — by then the whole
 *     run has exited, so nothing is live.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const removeAll = process.argv.includes("--all");
const cutoff = removeAll ? Number.POSITIVE_INFINITY : Date.now() - 60 * 60 * 1000;
let removed = 0;
let locked = 0;

for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("lorex-")) continue;
  const full = join(tmpdir(), entry.name);
  let mtimeMs;
  try {
    mtimeMs = statSync(full).mtimeMs;
  } catch {
    continue;
  }
  if (mtimeMs >= cutoff) continue;
  try {
    rmSync(full, { recursive: true, force: true });
    removed++;
  } catch {
    locked++; // held by a live process — the next run will get it
  }
}

console.log(`clean-temp: removed ${removed} test home(s)${locked ? `, ${locked} locked` : ""}`);

