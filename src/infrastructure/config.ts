/** Configuration and credential resolution from env, .env, and the Lorex home directory. */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lorexHome } from "./paths.js";

export interface Config {
  databaseOverride?: string;
  collectionOverride?: string;
  workspace?: string;
  /** Where memory lives. Empty = lorex home. Set via `lorex setup` or LOREX_DATA_DIR. */
  dataDir?: string;
}

export function configFile(): string {
  return join(lorexHome(), "config.json");
}

interface StoredConfig {
  database?: string;
  collection?: string;
  workspace?: string;
  dataDir?: string;
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

function readStoredConfig(): StoredConfig {
  const file = configFile();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StoredConfig;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: Partial<StoredConfig>): void {
  mkdirSync(lorexHome(), { recursive: true });
  const existing = readStoredConfig();
  const merged: StoredConfig = { ...existing, ...cfg };
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
  const stored = readStoredConfig();

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
    workspace: env("LOREX_WORKSPACE") || undefined,
    dataDir: env("LOREX_DATA_DIR") || undefined,
  };
}
