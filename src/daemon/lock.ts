/** Daemon lockfile: one resident Lorex service per machine (per LOREX_HOME). */

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { lorexHome } from "../infrastructure/paths.js";

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
}

export function daemonFile(): string {
  return join(lorexHome(), "daemon.json");
}

export function readDaemonInfo(): DaemonInfo | null {
  const file = daemonFile();
  if (!existsSync(file)) return null;
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as DaemonInfo;
    return typeof info.pid === "number" && typeof info.port === "number" ? info : null;
  } catch {
    return null;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the PID exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The recorded daemon, if its process is still alive. Stale locks are ignored. */
export function liveDaemon(): DaemonInfo | null {
  const info = readDaemonInfo();
  if (!info || !pidAlive(info.pid)) return null;
  return info;
}

export function writeDaemonInfo(info: DaemonInfo): void {
  mkdirSync(lorexHome(), { recursive: true });
  writeFileSync(daemonFile(), JSON.stringify(info, null, 2) + "\n");
}

/** Remove the lock — only if it belongs to `pid` (a newer daemon keeps its own). */
export function clearDaemonInfo(pid?: number): void {
  const current = readDaemonInfo();
  if (current && pid !== undefined && current.pid !== pid) return;
  try {
    rmSync(daemonFile(), { force: true });
  } catch {
    /* best effort */
  }
}
