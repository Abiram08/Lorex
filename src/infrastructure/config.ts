/** Configuration and credential resolution from env, .env, and the Lorex home directory. */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lorexHome } from "./paths.js";

export interface Config {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  queueCap: number;
  databaseOverride?: string;
  collectionOverride?: string;
}

export function configFile(): string {
  return join(lorexHome(), "config.json");
}

interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  queueCap?: number;
  database?: string;
  collection?: string;
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
  HYDRA_DB_API_KEY: "apiKey",
  HYDRADB_API_KEY: "apiKey",
  HYDRADB_BASE_URL: "baseUrl",
  HYDRADB_TIMEOUT_MS: "timeoutMs",
  LOREX_QUEUE_CAP: "queueCap",
  LOREX_DATABASE: "database",
  LOREX_COLLECTION: "collection",
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

  const apiKey = (env("HYDRA_DB_API_KEY") ?? env("HYDRADB_API_KEY") ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "Lorex: missing HydraDB API key.\n" +
        "Set HYDRA_DB_API_KEY in the environment (per docs.hydradb.com), create a .env file, or run `lorex init`.\n" +
        `Config file: ${configFile()}`,
    );
  }

  const baseUrl = (env("HYDRADB_BASE_URL") ?? "https://api.hydradb.com").trim();
  const timeoutMs = Number(env("HYDRADB_TIMEOUT_MS") ?? 15000) || 15000;
  const queueCap = Number(env("LOREX_QUEUE_CAP") ?? 500) || 500;

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    timeoutMs,
    queueCap,
    databaseOverride: env("LOREX_DATABASE") || undefined,
    collectionOverride: env("LOREX_COLLECTION") || undefined,
  };
}
