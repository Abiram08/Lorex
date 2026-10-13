/** Verify the exact npm tarball, its executable, and one-command setup. */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), "lorex-package-smoke-"));
const packDir = join(scratch, "pack");
const installDir = join(scratch, "install");
const projectDir = join(scratch, "project");
const npmCache = join(scratch, "npm-cache");
mkdirSync(packDir, { recursive: true });
mkdirSync(installDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });

const npmExecPath = process.env.npm_execpath;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 180_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} failed (${result.status ?? "spawn error"})`,
      result.stdout,
      result.stderr,
      result.error?.message,
    ].filter(Boolean).join("\n"));
  }
  return result.stdout;
}

function runNpm(args, options = {}) {
  if (npmExecPath) return run(process.execPath, [npmExecPath, ...args], options);
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
}

try {
  runNpm(["pack", "--pack-destination", packDir, "--cache", npmCache]);
  const tarballName = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
  if (!tarballName) throw new Error("npm pack did not create a tarball");
  const tarball = join(packDir, tarballName);

  runNpm(["install", "--prefix", installDir, "--no-audit", "--no-fund", "--cache", npmCache, tarball]);
  const binDir = join(installDir, "node_modules", ".bin");
  const binShim = join(binDir, process.platform === "win32" ? "lorex.cmd" : "lorex");
  if (!existsSync(binShim)) throw new Error("packed package did not create the lorex executable shim");
  const lorexEntry = join(installDir, "node_modules", "@lorex", "cli", "dist", "index.js");
  if (!existsSync(lorexEntry)) throw new Error("packed package is missing dist/index.js");
  const installedRoot = join(installDir, "node_modules", "@lorex", "cli");
  for (const required of ["LICENSE", join(".agents", "skills", "lorex", "SKILL.md"), join("console", "index.html"), join("console", "app.js"), join("console", "styles.css")]) {
    if (!existsSync(join(installedRoot, required))) throw new Error(`packed package is missing ${required}`);
  }
  for (const removed of ["client.js", "interfaces/dashboard.js", "interfaces/graph-server.js", "interfaces/local-server.js"]) {
    if (existsSync(join(installedRoot, "dist", removed))) throw new Error(`packed package contains stale output: ${removed}`);
  }
  const skill = readFileSync(join(installedRoot, ".agents", "skills", "lorex", "SKILL.md"), "utf8");
  if (!skill.includes("lorex setup --yes") || !skill.includes("lorex hooks status")) {
    throw new Error("packed Lorex skill does not activate and verify the harness");
  }
  const env = {
    ...process.env,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    LOREX_HOME: join(scratch, "home"),
    LOREX_AGENT_HOME: join(scratch, "agent-home"),
    LOREX_NO_LIMITS: "1",
    npm_config_cache: npmCache,
  };

  const lorex = (args) => run(process.execPath, [lorexEntry, ...args], { cwd: projectDir, env });
  const help = JSON.parse(lorex(["help", "--json"]));
  if (!Array.isArray(help.commands) || help.commands.length < 10) throw new Error("packed CLI did not expose its command registry");

  const setup = lorex(["setup"]);
  if (!setup.includes("Done.") || !setup.includes("remember \u2192 recall round-trip works")) {
    throw new Error(`packed one-command setup did not complete:\n${setup}`);
  }
  const codexHooks = readFileSync(join(projectDir, ".codex", "hooks.json"), "utf8");
  if (!codexHooks.includes("lorex harness --agent codex") || codexHooks.includes("npx -y")) {
    throw new Error("globally installed setup did not create offline-safe Codex hooks");
  }

  const doctor = lorex(["doctor"]);
  if (!doctor.includes("[ok] smoke complete")) throw new Error("packed CLI doctor smoke test failed");
  process.stdout.write(`\u2713 package smoke passed (${tarballName})\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
