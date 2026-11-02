/** Hook installer tests: writes into temp dirs, idempotent, all four agents. */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { installHooks, isAgentSupported, hooksStatus, uninstallHooks, lorexBin } from "../interfaces/agent-hooks.js";
import { lorexCommand } from "../infrastructure/runtime-command.js";
import { runCli } from "../interfaces/cli.js";

// Never let installer tests edit real agent configuration in the user's home.
process.env.LOREX_AGENT_HOME = mkdtempSync(join(tmpdir(), "lorex-agent-home-test-"));

async function captureOutput(fn: () => Promise<unknown>): Promise<string> {
  const out: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = ((s: string) => {
    out.push(s);
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = origWrite;
  }
  return out.join("");
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "lorex-hooks-test-"));
}

{
  assert.ok(isAgentSupported("claude-code"));
  assert.ok(isAgentSupported("cursor"));
  assert.ok(isAgentSupported("windsurf"));
  assert.ok(isAgentSupported("codex"));
  assert.ok(isAgentSupported("opencode"));
  assert.ok(isAgentSupported("grok"));
  assert.ok(isAgentSupported("gemini"));
  assert.ok(isAgentSupported("cline"));
  assert.ok(isAgentSupported("aider"));
  assert.ok(!isAgentSupported("not-an-agent"));

  const command = lorexCommand();
  const bin = lorexBin();
  const directNodeEntry =
    (command.source === "installed-package" || command.source === "managed-runtime") &&
    command.command === process.execPath &&
    command.args.length === 1 &&
    command.args[0]!.endsWith(join("dist", "index.js")) &&
    existsSync(command.args[0]!);
  assert.ok(
    (command.source === "global" && bin === "lorex") ||
      (command.source === "npx" && bin === "npx -y @lorex/cli") ||
      directNodeEntry,
    `bin resolves to a runnable Lorex command, got ${bin}`,
  );
  const oldNpmCommand = process.env.npm_command;
  process.env.npm_command = "exec";
  assert.equal(lorexBin(), "npx -y @lorex/cli", "npx's temporary PATH shim is never persisted as a global command");
  if (oldNpmCommand === undefined) delete process.env.npm_command; else process.env.npm_command = oldNpmCommand;
}

{
  const dir = freshDir();
  const { path } = installHooks("claude-code", dir);
  assert.ok(path.endsWith(join(".claude", "settings.json")));
  const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown[]>>;
  assert.ok("SessionStart" in settings.hooks, "SessionStart installed");
  assert.ok("Stop" in settings.hooks, "Stop installed");
  assert.ok("PreCompact" in settings.hooks, "PreCompact installed for compaction survival");
  assert.ok("UserPromptSubmit" in settings.hooks, "prompt-aware recall installed");

  const flat = JSON.stringify(settings);
  assert.ok(flat.includes("harness --agent claude-code"), "exact-session harness wired");
  assert.ok(!flat.includes("capture --auto"), "legacy newest-file capture removed");

  installHooks("claude-code", dir);
  const twice = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown[]>>;
  assert.equal(JSON.stringify(twice), flat, "re-install is idempotent");
}

{
  const dir = freshDir();
  const { path } = installHooks("cursor", dir);
  const settings = JSON.parse(readFileSync(path, "utf8")) as { version: number; hooks: Record<string, unknown[]> };
  assert.equal(settings.version, 1);
  assert.ok("sessionStart" in settings.hooks && "afterAgentResponse" in settings.hooks);
  assert.ok(JSON.stringify(settings).includes("harness --agent cursor"), "cursor hook bridge installed");
}

{
  const dir = freshDir();
  const { path } = installHooks("windsurf", dir);
  assert.ok(existsSync(path));
  const rules = readFileSync(path, "utf8");
  assert.ok(rules.includes("resume --plain") && rules.includes("add \"fact because reason\""), "rules cover load + explicit save");
  assert.ok(!rules.includes("capture --auto"), "rules never promise unsupported automatic capture");
  assert.ok(rules.toLowerCase().includes("compact"), "rules mention compaction survival");

  installHooks("windsurf", dir);
  assert.equal(readFileSync(path, "utf8"), rules, "re-install is idempotent");
}

{
  const dir = freshDir();
  const { path } = installHooks("codex", dir);
  const hooks = JSON.parse(readFileSync(path, "utf8")) as { hooks: Record<string, unknown> };
  assert.ok(hooks.hooks.SessionStart && hooks.hooks.UserPromptSubmit && hooks.hooks.Stop);
  const serialized = JSON.stringify(hooks);
  assert.ok(serialized.includes("additionalContextLimit") && serialized.includes("Loading Lorex memory"), "Codex context output is explicitly bounded");
  assert.ok(serialized.includes("Saving Lorex memory"), "Codex capture hooks expose a status message");
  assert.ok(readFileSync(join(dir, "AGENTS.md"), "utf8").includes("Lorex Memory"));
}

// ── Skill file ─────────────────────────────────────────────────────────────────

{
  const dir = freshDir();
  installHooks("claude-code", dir);
  const skill = join(dir, ".claude", "skills", "lorex", "SKILL.md");
  assert.ok(existsSync(skill), "SKILL.md written");
  const body = readFileSync(skill, "utf8");
  assert.ok(body.includes("recall") && body.includes("remember"), "skill covers recall + save");

  const projectSkill = join(dir, ".agents", "skills", "lorex", "SKILL.md");
  assert.ok(existsSync(projectSkill), "reusable product skill installed");
  const productBody = readFileSync(projectSkill, "utf8");
  assert.ok(productBody.includes("name: lorex") && productBody.includes("lorex setup --yes") && productBody.includes("lorex resume --plain"), "product skill activates the engine and uses memory");
  installHooks("codex", dir);
  assert.equal(readFileSync(projectSkill, "utf8"), productBody, "re-install preserves existing skill");
}

// ── Status ───────────────────────────────────────────────────────────────────

{
  const dir = freshDir();
  const before = hooksStatus(dir);
  assert.ok(before.filter((s) => !["gemini", "cline", "pi"].includes(s.agent)).every((s) => !s.configured),
    "clean project dir: no project-scoped integration configured");

  installHooks("claude-code", dir);
  installHooks("windsurf", dir);
  const after = hooksStatus(dir);
  assert.ok(after.find((s) => s.agent === "claude-code")?.configured, "claude detected");
  assert.ok(after.find((s) => s.agent === "windsurf")?.configured, "windsurf detected");
  assert.ok(!after.find((s) => s.agent === "cursor")?.configured, "cursor untouched");
}

// ── Uninstall ────────────────────────────────────────────────────────────────

{
  const dir = freshDir();
  for (const a of ["claude-code", "cursor", "windsurf", "codex"] as const) installHooks(a, dir);

  const claude = uninstallHooks("claude-code", dir);
  assert.ok(claude.removed, "claude hooks removed");
  const settings = JSON.parse(readFileSync(claude.path, "utf8")) as Record<string, unknown>;
  assert.ok(!JSON.stringify(settings).includes("harness --agent"), "no harness commands remain");

  const cursor = uninstallHooks("cursor", dir);
  assert.ok(cursor.removed, "cursor hooks removed");

  const windsurf = uninstallHooks("windsurf", dir);
  assert.ok(windsurf.removed, "windsurf block removed");
  assert.ok(!readFileSync(windsurf.path, "utf8").includes("lorex"), "windsurf clean");

  const codex = uninstallHooks("codex", dir);
  assert.ok(codex.removed, "codex block removed");
  assert.ok(!readFileSync(codex.path, "utf8").includes("lorex"), "codex clean");

  const again = uninstallHooks("claude-code", dir);
  assert.ok(!again.removed, "second uninstall is a no-op");

  const status = hooksStatus(dir);
  assert.ok(status.filter((s) => !["gemini", "cline", "pi"].includes(s.agent)).every((s) => !s.configured),
    "project-scoped hooks clean after uninstall");
}

// ── New agents: opencode, gemini, aider ──────────────────────────────────────

{
  const dir = freshDir();

  const oc = installHooks("opencode", dir);
  assert.ok(oc.path.endsWith("opencode.json"));
  const oconf = JSON.parse(readFileSync(oc.path, "utf8")) as { mcp?: Record<string, unknown> };
  assert.ok((oconf.mcp?.servers as Record<string, unknown>)?.lorex, "OpenCode v2 MCP entry written by default");
  assert.deepEqual(((oconf.mcp?.servers as Record<string, { command: string[] }>).lorex).command.slice(-3), ["start", "--agent", "opencode"], "OpenCode command is an attributed argv array");
  assert.ok(readFileSync(join(dir, "AGENTS.md"), "utf8").includes("lorex"), "opencode guidance written");

  const aider = installHooks("aider", dir);
  assert.ok(aider.path.endsWith("AGENTS.md"), "aider reuses AGENTS.md");

  const before = readFileSync(oc.path, "utf8");
  installHooks("opencode", dir);
  assert.equal(readFileSync(oc.path, "utf8"), before, "opencode re-install stable");

  const st = hooksStatus(dir);
  assert.ok(st.find((s) => s.agent === "opencode")?.configured, "opencode detected");
  assert.ok(st.find((s) => s.agent === "aider")?.configured, "aider detected");

  assert.ok(uninstallHooks("opencode", dir).removed, "opencode MCP entry removed");
  const after = JSON.parse(readFileSync(oc.path, "utf8")) as { mcp?: Record<string, unknown> };
  assert.ok(!(after.mcp?.servers as Record<string, unknown>)?.lorex, "opencode clean");

  assert.ok(uninstallHooks("aider", dir).removed, "aider guidance removed");
}

{
  const dir = freshDir();
  const path = join(dir, "opencode.json");
  writeFileSync(path, JSON.stringify({ mcp: { existing: { type: "local", command: ["echo"], enabled: true } } }));
  installHooks("opencode", dir);
  const config = JSON.parse(readFileSync(path, "utf8")) as { mcp: Record<string, { command: string[] }> };
  assert.ok(config.mcp.existing, "OpenCode v1 preserves other servers");
  assert.deepEqual(config.mcp.lorex?.command.slice(-3), ["start", "--agent", "opencode"]);
}

{
  const dir = freshDir();
  const path = join(dir, "opencode.json");
  writeFileSync(path, JSON.stringify({ mcp: { servers: { existing: { type: "local", command: ["echo"] } } } }));
  installHooks("opencode", dir);
  const config = JSON.parse(readFileSync(path, "utf8")) as { mcp: { servers: Record<string, { command: string[] }> } };
  assert.ok(config.mcp.servers.existing, "OpenCode v2 preserves other servers");
  assert.deepEqual(config.mcp.servers.lorex?.command.slice(-3), ["start", "--agent", "opencode"]);
  assert.ok(uninstallHooks("opencode", dir).removed);
}

{
  const dir = freshDir();
  mkdirSync(join(dir, ".grok", "hooks"), { recursive: true });
  writeFileSync(join(dir, ".grok", "config.toml"), "[telemetry]\nenabled = false\n");
  writeFileSync(join(dir, ".grok", "hooks", "lorex.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo keep-me" }] }] }, custom: true }));
  const grok = installHooks("grok", dir);
  assert.ok(readFileSync(grok.path, "utf8").includes("[mcp_servers.lorex]"));
  assert.ok(readFileSync(grok.path, "utf8").includes("[telemetry]"), "Grok TOML keeps unrelated settings");
  const grokHooks = readFileSync(join(dir, ".grok", "hooks", "lorex.json"), "utf8");
  assert.ok(grokHooks.includes("harness --agent grok"));
  assert.ok(grokHooks.includes("keep-me") && grokHooks.includes('"custom": true'), "Grok hook install preserves unrelated config");
  assert.ok(hooksStatus(dir).find((s) => s.agent === "grok")?.configured);
  assert.ok(uninstallHooks("grok", dir).removed);
  assert.ok(!hooksStatus(dir).find((s) => s.agent === "grok")?.configured);
}

// ── Pi + OMP ───────────────────────────────────────────────────────────────────

{
  const dir = freshDir();

  const pi = installHooks("pi", dir);
  assert.ok(pi.path.endsWith(join("mcp.json")), "pi mcp.json written");
  const pconf = JSON.parse(readFileSync(pi.path, "utf8")) as { mcpServers?: Record<string, unknown> };
  assert.ok(pconf.mcpServers?.lorex, "pi MCP entry written");

  const omp = installHooks("omp", dir);
  assert.ok(omp.path.endsWith(join(".omp", "mcp.json")), "omp mcp.json written");
  const oconf = JSON.parse(readFileSync(omp.path, "utf8")) as { mcpServers?: Record<string, unknown> };
  assert.ok(oconf.mcpServers?.lorex, "omp MCP entry written");

  installHooks("pi", dir);
  installHooks("omp", dir);
  const st = hooksStatus(dir);
  assert.ok(st.find((s) => s.agent === "pi")?.configured, "pi detected");
  assert.ok(st.find((s) => s.agent === "omp")?.configured, "omp detected");

  assert.ok(uninstallHooks("pi", dir).removed, "pi entry removed");
  assert.ok(uninstallHooks("omp", dir).removed, "omp entry removed");
  assert.ok(!hooksStatus(dir).find((s) => s.agent === "pi")?.configured, "pi clean");
  assert.ok(!hooksStatus(dir).find((s) => s.agent === "omp")?.configured, "omp clean");
}

// ── Local models: env passthrough + silent absent ────────────────────────────

import { detectLocalModels, resetLocalModelsCache } from "../infrastructure/local-models.js";

{
  const prevUrl = process.env.LOREX_EMBED_URL;
  const prevBase = process.env.LOREX_LLM_BASE_URL;
  delete process.env.LOREX_EMBED_URL;
  delete process.env.LOREX_LLM_BASE_URL;
  resetLocalModelsCache();

  const none = await detectLocalModels();
  assert.ok(!none.embedUrl || typeof none.embedUrl === "string", "absent Ollama resolves without throwing");

  process.env.LOREX_EMBED_URL = "http://localhost:11434";
  resetLocalModelsCache();
  const explicit = await detectLocalModels();
  assert.equal(explicit.embedUrl, "http://localhost:11434", "explicit env wins");
  assert.equal(explicit.embedModel, "nomic-embed-text", "default embed model");

  if (prevUrl === undefined) delete process.env.LOREX_EMBED_URL;
  else process.env.LOREX_EMBED_URL = prevUrl;
  if (prevBase === undefined) delete process.env.LOREX_LLM_BASE_URL;
  else process.env.LOREX_LLM_BASE_URL = prevBase;
  resetLocalModelsCache();
}

{
  const dir = freshDir();
  const oldCwd = process.cwd();
  const malformed = "{ not valid JSON";
  writeFileSync(join(dir, ".mcp.json"), malformed);
  process.chdir(dir);
  try {
    await assert.rejects(() => runCli(["wire", "--agent", "claude"]), /refusing to overwrite/);
    assert.equal(readFileSync(join(dir, ".mcp.json"), "utf8"), malformed,
      "wiring never replaces an invalid user MCP config");
  } finally {
    process.chdir(oldCwd);
  }
}

{
  const home = mkdtempSync(join(tmpdir(), "lorex-home-test-"));
  const dir = mkdtempSync(join(tmpdir(), "lorex-cli-test-"));
  const fakeUser = mkdtempSync(join(tmpdir(), "lorex-user-test-"));
  const prevHome = process.env.LOREX_HOME;
  const prevCwd = process.cwd();
  const prevUserProfile = process.env.USERPROFILE;
  const prevAppData = process.env.APPDATA;
  const prevAgentHome = process.env.LOREX_AGENT_HOME;
  process.env.LOREX_HOME = home;
  process.env.USERPROFILE = fakeUser;
  process.env.APPDATA = join(fakeUser, "AppData", "Roaming");
  process.env.LOREX_AGENT_HOME = fakeUser;
  process.chdir(dir);
  try {
    // --yes keeps the suite non-interactive: without it, a terminal run (TTY)
    // would stop at setup's "Where should memory live?" prompt.
    const setupOutput = await captureOutput(() => runCli(["setup", "--workspace", "cli-test", "--yes"]));
    assert.ok(setupOutput.includes("shared store works: OpenCode identity recalled a Claude Code source"), "setup verifies cross-agent memory and source attribution with independent store clients");
    assert.ok(existsSync(join(dir, ".mcp.json")), ".mcp.json written");
    assert.ok(existsSync(join(dir, ".claude", "settings.json")), "claude hooks written");
    assert.ok(existsSync(join(dir, ".codex", "hooks.json")), "codex hooks written");
    assert.ok(existsSync(join(dir, ".cursor", "mcp.json")), "cursor MCP written");
    assert.ok(readFileSync(join(dir, ".mcp.json"), "utf8").includes("claude-code"), "generic project MCP preserves Claude Code attribution");
    assert.ok(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8").includes("cursor"), "Cursor MCP preserves agent attribution");
    const codexMcp = readFileSync(join(fakeUser, ".codex", "config.toml"), "utf8");
    assert.ok(codexMcp.includes("mcp_servers.lorex") && codexMcp.includes('"codex"'), "Codex MCP wired with agent attribution");
    assert.equal(JSON.parse(readFileSync(join(dir, ".lorex.json"), "utf8")).workspace, "cli-test");

    await runCli(["status"]);
    await runCli(["add", "CLI smoke fact because testing"]);
    await runCli(["profile"]);
    await runCli(["open-loops"]);
    await runCli(["dream"]);
    const reviews = await captureOutput(() => runCli(["reviews"]));
    assert.ok(reviews.includes("No inferred memories"), "review queue is accessible from the CLI");
    await runCli(["consolidate"]);
    await runCli(["doctor"]);

    await runCli(["add", "Output probe fact because testing"]);
    const human = await captureOutput(() => runCli(["ask", "output probe fact"]));
    assert.ok(!human.trimStart().startsWith("{"), "default output is human-readable");
    assert.ok(human.includes("Sources"), "human output lists sources");
    const machine = await captureOutput(() => runCli(["ask", "output probe fact", "--json"]));
    assert.ok(machine.trimStart().startsWith("{"), "--json returns raw receipt");
    assert.equal((JSON.parse(machine) as { op?: string }).op, "recall", "JSON parses with op field");
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.LOREX_HOME;
    else process.env.LOREX_HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevAgentHome === undefined) delete process.env.LOREX_AGENT_HOME;
    else process.env.LOREX_AGENT_HOME = prevAgentHome;
  }

  // Sandboxed HOME assertions (no real user paths touched)
  assert.ok(
    !existsSync(join(fakeUser, "AppData", "Roaming", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")),
    "core setup does not modify optional Cline settings",
  );
}

// ── Installer precision: a user's own "lorex"-named hook is never touched ────

{
  const dir = freshDir();
  const settingsPath = join(dir, ".claude", "settings.json");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify(
      { hooks: { Stop: [
        { hooks: [{ type: "command", command: "echo 'lorex is my favourite tool'" }] },
        { hooks: [{ type: "command", command: "npx -y @lorex/cli harness --agent claude-code" }] },
      ] } },
      null,
      2,
    ),
  );

  installHooks("claude-code", dir);
  const installed = readFileSync(settingsPath, "utf8");
  assert.ok(installed.includes("my favourite tool"), "install leaves the user's own hook alone");
  assert.ok(!installed.includes("npx -y @lorex/cli"), "install replaces a stale transient Lorex hook");
  assert.equal((installed.match(/harness --agent claude-code/g) ?? []).length, 4, "exactly one current hook is installed for each lifecycle event");

  uninstallHooks("claude-code", dir);
  const cleaned = readFileSync(settingsPath, "utf8");
  assert.ok(cleaned.includes("my favourite tool"), "uninstall keeps the user's own hook");
  assert.ok(!cleaned.includes("harness --agent"), "our hooks are removed");
}

{
  const dir = freshDir();
  writeFileSync(join(dir, ".windsurfrules"), "# notes\nsomeone said lorex is neat\n");

  installHooks("windsurf", dir);
  const rules = readFileSync(join(dir, ".windsurfrules"), "utf8");
  assert.ok(rules.includes("someone said lorex is neat"), "existing rules content kept");
  assert.ok(rules.includes("lorex:end"), "our block is appended despite the stray mention");
}

// ── help --json: the machine-readable surface, and it cannot drift ───────────

{
  const out = await captureOutput(() => runCli(["help", "--json"]));
  const parsed = JSON.parse(out) as { version?: string; commands?: Array<{ name: string; usage?: string }> };
  assert.ok(parsed.version, "help --json reports the version");
  const commands = parsed.commands ?? [];
  assert.ok(commands.length >= 25, `registry covers the surface, got ${commands.length}`);
  assert.ok(commands.every((c) => c.name && c.usage), "every command has a name and a usage line");

  // The registry must cover every dispatch case in the CLI, or an agent
  // discovering the surface would miss a command that exists.
  const names = new Set(commands.map((c) => c.name));
  const source = readFileSync(join("src", "interfaces", "cli.ts"), "utf8");
  const dispatched = [...source.matchAll(/^\s+case "([^"]+)": return cmd/gm)].map((m) => m[1]!);
  const aliases = new Set(["remember", "recall", "--help", "-h"]);
  const missing = dispatched.filter((c) => !aliases.has(c) && !names.has(c));
  assert.deepEqual(missing, [], `commands missing from help --json: ${missing.join(", ")}`);
  assert.ok(names.has("reflect"), "reflect is discoverable through help --json");
  assert.ok(names.has("reviews") && names.has("review"), "human inference review is discoverable through help --json");
  assert.ok(names.has("context"), "context is discoverable through help --json");
}

console.log("✓ hook installer tests passed");
