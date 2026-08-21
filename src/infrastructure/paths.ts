/** Filesystem locations for Lorex state. LOREX_HOME overrides ~/.lorex (tests, sandboxes). */

import { homedir } from "node:os";
import { join } from "node:path";

export function lorexHome(): string {
  const override = process.env.LOREX_HOME;
  if (override && override.trim()) return override.trim();
  return join(homedir(), ".lorex");
}
