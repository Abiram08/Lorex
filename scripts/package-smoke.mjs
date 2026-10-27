/** Verify the exact npm tarball, its executable, and one-command setup. */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (packageManifest.name !== "@lorex/cli") throw new Error("package identity changed without registry ownership verification");
const packageVersion = packageManifest.version;
const scratch = mkdtempSync(join(tmpdir(), "lorex-package-smoke-"));
const packDir = join(scratch, "pack");
const installDir = join(scratch, "install");
const projectDir = join(scratch, "project");
const firstRunDir = join(scratch, "first-run");
const npxProject = join(scratch, "npx-project");
const isolatedProject = join(scratch, "isolated-project");
const npmCache = join(scratch, "npm-cache");
mkdirSync(packDir, { recursive: true });
mkdirSync(installDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
mkdirSync(firstRunDir, { recursive: true });
mkdirSync(npxProject, { recursive: true });
mkdirSync(isolatedProject, { recursive: true });

const npmExecPath = process.env.npm_execpath;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 180_000,
    input: options.input,
    shell: options.shell ?? false,
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

  const lorex = (args, cwd = projectDir, runEnv = env) => run(process.execPath, [lorexEntry, ...args], { cwd, env: runEnv });
  const help = JSON.parse(lorex(["help", "--json"]));
  if (!Array.isArray(help.commands) || help.commands.length < 10) throw new Error("packed CLI did not expose its command registry");

  const setup = lorex(["setup"]);
  if (!setup.includes("Done.") || !setup.includes("remember \u2192 recall round-trip works") ||
      !setup.includes("shared store works: OpenCode identity recalled a Claude Code source")) {
    throw new Error(`packed one-command setup did not complete:\n${setup}`);
  }

  // A bare executable is the first-run path users get from `npx @lorex/cli`.
  // It must provision the project and remain entirely in the terminal.
  const firstRun = lorex([], firstRunDir);
  if (!firstRun.includes("shared store works: OpenCode identity recalled a Claude Code source") ||
      !firstRun.includes("Lorex status") || firstRun.includes("Lorex console:") ||
      !existsSync(join(firstRunDir, ".lorex.json")) ||
      !existsSync(join(firstRunDir, ".codex", "hooks.json"))) {
    throw new Error(`bare Lorex command did not set up shared agent memory:\n${firstRun}`);
  }
  const secondRun = lorex([], firstRunDir);
  if (!secondRun.includes("Lorex status") || secondRun.includes("Setting up Lorex")) {
    throw new Error(`repeat bare command should show CLI status without reinstalling:\n${secondRun}`);
  }
  const codexHooks = readFileSync(join(projectDir, ".codex", "hooks.json"), "utf8");
  if (!codexHooks.includes("lorex harness --agent codex") || codexHooks.includes("npx -y")) {
    throw new Error("globally installed setup did not create offline-safe Codex hooks");
  }

  // Simulate the actual one-shot `npx @lorex/cli` path. Seed unrelated user
  // settings, then prove setup preserves them and installs a durable runtime.
  mkdirSync(join(npxProject, ".claude"), { recursive: true });
  mkdirSync(join(npxProject, ".codex"), { recursive: true });
  mkdirSync(join(npxProject, ".cursor"), { recursive: true });
  writeFileSync(join(npxProject, ".mcp.json"), JSON.stringify({ mcpServers: { existing: { command: "echo", args: ["keep"] } } }));
  writeFileSync(join(npxProject, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(git status)"] } }));
  writeFileSync(join(npxProject, ".codex", "hooks.json"), JSON.stringify({ custom: "keep" }));
  writeFileSync(join(npxProject, ".cursor", "hooks.json"), JSON.stringify({ version: 1, custom: "keep" }));
  writeFileSync(join(npxProject, "opencode.json"), JSON.stringify({ mcp: { servers: { existing: { type: "local", command: ["echo", "keep"] } } } }));
  const npxHome = join(scratch, "npx-home");
  const npxAgentHome = join(scratch, "npx-agent-home");
  mkdirSync(join(npxAgentHome, ".codex"), { recursive: true });
  writeFileSync(join(npxAgentHome, ".codex", "config.toml"), "[features]\nkeep = true\n");
  const npxEnv = {
    ...env,
    LOREX_HOME: npxHome,
    LOREX_AGENT_HOME: npxAgentHome,
    npm_command: "exec",
  };
  const npxSetup = lorex([], npxProject, npxEnv);
  const runtimeEntry = join(npxHome, "runtime", packageVersion, "node_modules", "@lorex", "cli", "dist", "index.js");
  if (!npxSetup.includes("managed-runtime") && !npxSetup.includes(runtimeEntry)) {
    throw new Error(`npx setup did not report its managed runtime:\n${npxSetup}`);
  }
  if (!existsSync(runtimeEntry)) throw new Error("npx setup did not create a durable managed runtime");
  const generated = [
    readFileSync(join(npxProject, ".claude", "settings.json"), "utf8"),
    readFileSync(join(npxProject, ".codex", "hooks.json"), "utf8"),
    readFileSync(join(npxProject, ".cursor", "hooks.json"), "utf8"),
    readFileSync(join(npxProject, "opencode.json"), "utf8"),
    readFileSync(join(npxAgentHome, ".codex", "config.toml"), "utf8"),
  ].join("\n");
  if (generated.includes("npx -y") || generated.includes('"npx"')) {
    throw new Error("one-shot setup persisted an evictable npx command");
  }
  for (const marker of ["Bash(git status)", '"custom": "keep"', '"existing"', "[features]", "keep = true"]) {
    if (!generated.includes(marker)) throw new Error(`setup discarded unrelated user config: ${marker}`);
  }
  const beforeRepeat = generated;
  const repeatNpx = lorex([], npxProject, npxEnv);
  const afterRepeat = [
    readFileSync(join(npxProject, ".claude", "settings.json"), "utf8"),
    readFileSync(join(npxProject, ".codex", "hooks.json"), "utf8"),
    readFileSync(join(npxProject, ".cursor", "hooks.json"), "utf8"),
    readFileSync(join(npxProject, "opencode.json"), "utf8"),
    readFileSync(join(npxAgentHome, ".codex", "config.toml"), "utf8"),
  ].join("\n");
  if (repeatNpx.includes("Setting up Lorex") || afterRepeat !== beforeRepeat) {
    throw new Error("second npx run was not fast and idempotent");
  }

  // Execute the generated Codex hook command as a separate process, then
  // retrieve its source as another agent and confirm project isolation.
  const installedCodex = JSON.parse(readFileSync(join(npxProject, ".codex", "hooks.json"), "utf8"));
  const hookCommand = installedCodex.hooks.UserPromptSubmit[0].hooks[0].command;
  const hookEnv = { ...npxEnv, npm_config_offline: "true" };
  run(hookCommand, [], {
    cwd: npxProject, env: hookEnv, shell: true,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "package-e2e", turn_id: "turn-1", prompt: "We decided to keep package manifests in SQLite because offline setup must work.", timestamp: "2026-10-20T10:00:00Z" }),
  });
  run(hookCommand, [], {
    cwd: npxProject, env: hookEnv, shell: true,
    input: JSON.stringify({ hook_event_name: "Stop", session_id: "package-e2e", turn_id: "turn-1", last_assistant_message: "The package manifest decision is recorded.", timestamp: "2026-10-20T10:01:00Z" }),
  });
  const crossAgent = JSON.parse(run(process.execPath, [runtimeEntry, "ask", "package manifests SQLite", "--type", "knowledge", "--json", "--agent", "opencode"], { cwd: npxProject, env: hookEnv }));
  if (!crossAgent.sources?.some((source) => source.agent === "codex" && source.trust === "verbatim_source" && source.source_session_id && source.content.includes("package manifests"))) {
    throw new Error("Agent B could not retrieve Agent A's hook source with attribution");
  }
  const isolated = JSON.parse(run(process.execPath, [runtimeEntry, "ask", "package manifests SQLite", "--json", "--agent", "cursor"], { cwd: isolatedProject, env: hookEnv }));
  if (isolated.sources?.length) throw new Error("project memory leaked into a different project collection");
  const offlineStatus = run(process.execPath, [runtimeEntry], { cwd: npxProject, env: hookEnv });
  if (!offlineStatus.includes("Lorex status")) throw new Error("managed runtime did not work offline after installation");

  const doctor = lorex(["doctor"]);
  if (!doctor.includes("[ok] smoke complete")) throw new Error("packed CLI doctor smoke test failed");
  process.stdout.write(`\u2713 package smoke passed (${tarballName})\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
