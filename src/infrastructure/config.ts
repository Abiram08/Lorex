/** Configuration and credential resolution from env, .env, and the Lorex home directory. */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { lorexHome } from "./paths.js";
import { ConfigError } from "./errors.js";

export interface Config {
  databaseOverride?: string;
  collectionOverride?: string;
  workspace?: string;
  /** Where memory lives. Empty = lorex home. Set via `lorex setup` or LOREX_DATA_DIR. */
  dataDir?: string;
  /** Resident daemon port. Default 3777. */
  daemonPort?: number;
  activeTask?: string;
}

export function configFile(): string {
  return join(lorexHome(), "config.json");
}

/** Workspace identity belongs to the project, not the machine-wide store. */
export function projectConfigFile(cwd = process.cwd()): string {
  return join(cwd, ".lorex.json");
}

/** Nearest configured project, otherwise the containing Git root. */
export function projectRoot(cwd = process.cwd()): string {
  const start = resolve(cwd);
  let dir = start;
  while (true) {
    if (existsSync(projectConfigFile(dir)) || existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** Unique default even when two unrelated repositories share a folder name. */
export function defaultWorkspace(cwd = process.cwd()): string {
  const name = basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  const suffix = createHash("sha256").update(resolve(cwd).toLowerCase()).digest("hex").slice(0, 8);
  return `${name.slice(0, 45)}-${suffix}`;
}

export function saveProjectWorkspace(workspace: string, cwd = process.cwd()): void {
  const file = projectConfigFile(cwd);
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      existing = parsed as Record<string, unknown>;
    } catch {
      throw new ConfigError(`${file} is not valid JSON — refusing to overwrite it`, { path: file });
    }
  }
  writeFileSync(file, JSON.stringify({ ...existing, workspace }, null, 2) + "\n");
}

export function saveActiveTask(taskId: string | undefined, cwd = process.cwd()): void {
  const file = projectConfigFile(projectRoot(cwd));
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      existing = parsed as Record<string, unknown>;
    } catch { throw new ConfigError(`${file} is not valid JSON — refusing to overwrite it`, { path: file }); }
  }
  if (taskId) existing.activeTask = taskId;
  else delete existing.activeTask;
  writeFileSync(file, JSON.stringify(existing, null, 2) + "\n");
}

function readProjectValue(cwd: string, key: "workspace" | "activeTask"): string | undefined {
  const dir = projectRoot(cwd);
  const file = projectConfigFile(dir);
  if (!existsSync(file)) return undefined;
  if (!existsSync(file)) return undefined;
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return typeof data[key] === "string" && data[key].trim() ? data[key].trim() : undefined;
  } catch {
    throw new ConfigError(`${file} is not valid JSON`, { path: file });
  }
}

interface StoredConfig {
  database?: string;
  collection?: string;
  workspace?: string;
  dataDir?: string;
  daemonPort?: number;
}

function loadDotEnv(cwd: string): Record<string, string> {
  const envPath = join(cwd, ".env");
  if (!existsSync(envPath)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function hydrateEnvFromDotEnv(cwd = process.cwd()): string[] {
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(loadDotEnv(cwd))) {
    if (process.env[k] === undefined && v !== "") {
      process.env[k] = v;
      loaded.push(k);
    }
  }
  return loaded;
}

/**
 * Read the stored config. Corruption is reported rather than swallowed: reads
 * tolerate it (so the CLI still runs with defaults), but a write refuses to
 * overwrite the file, because silently replacing a corrupt config with a
 * one-key object destroys whatever the user had.
 */
function readStoredConfig(): { data: StoredConfig; corrupt: boolean } {
  const file = configFile();
  if (!existsSync(file)) return { data: {}, corrupt: false };
  const raw = readFileSync(file, "utf8");
  if (!raw.trim()) return { data: {}, corrupt: false };
  try {
    return { data: JSON.parse(raw) as StoredConfig, corrupt: false };
  } catch {
    return { data: {}, corrupt: true };
  }
}

export function saveConfig(cfg: Partial<StoredConfig>): void {
  const existing = readStoredConfig();
  if (existing.corrupt) {
    throw new ConfigError(
      `${configFile()} is not valid JSON — refusing to overwrite it so the existing ` +
        "contents are not lost. Repair or delete the file, then re-run.",
      { path: configFile() },
    );
  }
  mkdirSync(lorexHome(), { recursive: true });
  const merged: StoredConfig = { ...existing.data, ...cfg };
  writeFileSync(configFile(), JSON.stringify(merged, null, 2) + "\n", {
    mode: 0o600,
  });
}

const STORED_KEY_FOR_ENV: Record<string, keyof StoredConfig> = {
  LOREX_DATABASE: "database",
  LOREX_COLLECTION: "collection",
  LOREX_WORKSPACE: "workspace",
  LOREX_DATA_DIR: "dataDir",
};

export function loadConfig(cwd = process.cwd()): Config {
  const dotenv = loadDotEnv(cwd);
  const { data: stored } = readStoredConfig();

  const fromStore = (k: string): string | undefined => {
    const mapped = STORED_KEY_FOR_ENV[k];
    const v = mapped ? stored[mapped] : (stored as Record<string, unknown>)[k];
    return v === undefined || v === null ? undefined : String(v);
  };

  const env = (k: string): string | undefined =>
    process.env[k] ?? dotenv[k] ?? fromStore(k);

  return {
    databaseOverride: env("LOREX_DATABASE") || undefined,
    collectionOverride: env("LOREX_COLLECTION") || undefined,
    // Do not inherit a workspace from global config: that merges unrelated repos.
    workspace: process.env.LOREX_WORKSPACE || dotenv.LOREX_WORKSPACE || readProjectValue(cwd, "workspace"),
    activeTask: process.env.LOREX_TASK || dotenv.LOREX_TASK || readProjectValue(cwd, "activeTask"),
    dataDir: env("LOREX_DATA_DIR") || undefined,
    daemonPort: typeof stored.daemonPort === "number" ? stored.daemonPort : undefined,
  };
}
