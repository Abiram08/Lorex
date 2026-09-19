/** Filesystem locations for Lorex state. LOREX_HOME overrides ~/.lorex (tests, sandboxes). */

import { homedir } from "node:os";
import { join } from "node:path";

export function lorexHome(): string {
  const override = process.env.LOREX_HOME;
  if (override && override.trim()) return override.trim();
  return join(homedir(), ".lorex");
}

/** Where memory lives. dataDir set via `lorex setup` or LOREX_DATA_DIR. */
export function storeDir(dataDir?: string): string {
  const override = process.env.LOREX_DATA_DIR;
  if (override && override.trim()) return override.trim();
  if (dataDir && dataDir.trim()) return dataDir.trim();
  return lorexHome();
}

export function storeDbPath(dataDir?: string): string {
  return join(storeDir(dataDir), "local-store.db");
}
