/** Resolve a durable Lorex executable for generated MCP and hook configs. */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lorexHome } from "./paths.js";
import { VERSION } from "./version.js";

export interface LorexCommand {
  command: string;
  args: string[];
  durable: boolean;
  source: "global" | "installed-package" | "managed-runtime" | "npx";
}

let prepared: LorexCommand | undefined;

function isNpxInvocation(): boolean {
  const entry = process.argv[1] ?? "";
  return process.env.npm_command === "exec" || process.env.npm_lifecycle_event === "npx" || /[\\/]_npx[\\/]/i.test(entry);
}

function commandExists(command: string): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
    stdio: "ignore",
    windowsHide: true,
  });
  return probe.status === 0;
}

function currentCliEntry(): string | undefined {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  if (!entry || !existsSync(entry)) return undefined;
  const normalized = entry.replace(/\\/g, "/");
  return /\/(?:dist\/index\.js|src\/index\.ts)$/.test(normalized) ? entry : undefined;
}

function managedEntry(): string {
  return join(lorexHome(), "runtime", VERSION, "node_modules", "@lorex", "cli", "dist", "index.js");
}

/** Current command without performing installation. */
export function lorexCommand(): LorexCommand {
  if (prepared) return prepared;

  const explicit = process.env.LOREX_RUNTIME_ENTRY?.trim();
  if (explicit && existsSync(explicit)) {
    return { command: process.execPath, args: [resolve(explicit)], durable: true, source: "managed-runtime" };
  }

  const managed = managedEntry();
  if (existsSync(managed)) {
    return { command: process.execPath, args: [managed], durable: true, source: "managed-runtime" };
  }

  if (!isNpxInvocation() && commandExists("lorex")) {
    return { command: "lorex", args: [], durable: true, source: "global" };
  }

  const entry = currentCliEntry();
  if (!isNpxInvocation() && entry) {
    return { command: process.execPath, args: [entry], durable: true, source: "installed-package" };
  }

  return { command: "npx", args: ["-y", "@lorex/cli"], durable: false, source: "npx" };
}

function npmRun(args: string[], cwd: string): string {
  const npmExec = process.env.npm_execpath;
  const command = npmExec ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = npmExec ? [npmExec, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5 * 60_000,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} failed`,
      result.stderr?.trim(),
      result.stdout?.trim(),
      result.error?.message,
    ].filter(Boolean).join("\n"));
  }
  return result.stdout;
}

function packageRoot(): string {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string };
  if (pkg.name !== "@lorex/cli") throw new Error(`expected @lorex/cli at ${root}`);
  return root;
}

/**
 * An npx package lives in an evictable npm cache. Before writing lifecycle
 * commands, install the exact running package into a versioned user runtime.
 * This needs npm only during setup; hooks and MCP work offline afterward.
 */
export function ensureDurableLorexCommand(): LorexCommand {
  const current = lorexCommand();
  if (current.durable) {
    prepared = current;
    return current;
  }

  const finalRoot = join(lorexHome(), "runtime", VERSION);
  const entry = managedEntry();
  if (existsSync(entry)) {
    prepared = { command: process.execPath, args: [entry], durable: true, source: "managed-runtime" };
    return prepared;
  }

  mkdirSync(join(lorexHome(), "runtime"), { recursive: true });
  const packDir = mkdtempSync(join(lorexHome(), "runtime-pack-"));
  const stage = `${finalRoot}.stage-${process.pid}-${Date.now()}`;
  try {
    const root = packageRoot();
    // `npm pack <installed-package>` still runs its prepare script, but release
    // tarballs intentionally omit the source build scripts. Pack a clean copy
    // with lifecycle scripts removed instead of mutating the running package.
    const packSource = join(packDir, "package");
    cpSync(root, packSource, {
      recursive: true,
      filter: (source) => !relative(root, source).split(/[\\/]/).includes("node_modules"),
    });
    const manifestPath = join(packSource, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { scripts?: Record<string, string> };
    delete manifest.scripts;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    npmRun(["pack", packSource, "--pack-destination", packDir, "--ignore-scripts", "--silent"], packSource);
    const tarball = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
    if (!tarball) throw new Error("npm pack did not produce the Lorex tarball");
    mkdirSync(stage, { recursive: true });
    npmRun([
      "install", "--prefix", stage, "--omit=dev", "--no-audit", "--no-fund",
      "--install-links", join(packDir, tarball),
    ], root);
    const stagedEntry = join(stage, "node_modules", "@lorex", "cli", "dist", "index.js");
    if (!existsSync(stagedEntry)) throw new Error("managed runtime is missing dist/index.js");
    rmSync(finalRoot, { recursive: true, force: true });
    renameSync(stage, finalRoot);
    writeFileSync(join(finalRoot, "runtime.json"), JSON.stringify({ version: VERSION, installedAt: new Date().toISOString() }, null, 2) + "\n");
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw new Error(
      `Could not create the durable Lorex runtime under ${finalRoot}: ${(error as Error).message}. ` +
      "No hooks were written. Retry with network access, or run `npm install -g @lorex/cli` and then `lorex`.",
    );
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }

  if (!existsSync(entry)) throw new Error(`managed Lorex runtime was not created at ${entry}`);
  process.env.LOREX_RUNTIME_ENTRY = entry;
  prepared = { command: process.execPath, args: [entry], durable: true, source: "managed-runtime" };
  return prepared;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@\\-]+$/.test(value)) return value;
  if (process.platform === "win32") return `"${value.replace(/"/g, '""')}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderLorexCommand(command = lorexCommand()): string {
  return [command.command, ...command.args].map(shellQuote).join(" ");
}

export function lorexMcpCommand(agent: string): { command: string; args: string[] } {
  const base = lorexCommand();
  return { command: base.command, args: [...base.args, "start", "--agent", agent] };
}
