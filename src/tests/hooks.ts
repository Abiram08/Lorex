/** Hook installer tests: writes into temp dirs, idempotent, all four agents. */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { installHooks, isAgentSupported, hooksStatus, uninstallHooks, lorexBin, skillMd } from "../interfaces/agent-hooks.js";
import { runCli } from "../interfaces/cli.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "lorex-hooks-test-"));
}

{
  assert.ok(isAgentSupported("claude-code"));
  assert.ok(isAgentSupported("cursor"));
  assert.ok(isAgentSupported("windsurf"));
  assert.ok(isAgentSupported("codex"));
  assert.ok(isAgentSupported("opencode"));
  assert.ok(isAgentSupported("gemini"));
  assert.ok(isAgentSupported("cline"));
  assert.ok(isAgentSupported("aider"));
  assert.ok(!isAgentSupported("not-an-agent"));

  const bin = lorexBin();
  assert.ok(bin === "lorex" || bin.startsWith("npx"), `bin resolves, got ${bin}`);
}

{
  const dir = freshDir();
  const { path } = installHooks("claude-code", dir);
  assert.ok(path.endsWith(join(".claude", "settings.json")));
  const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown[]>>;
  assert.ok("SessionStart" in settings.hooks, "SessionStart installed");
  assert.ok("Stop" in settings.hooks, "Stop installed");
  assert.ok("PreCompact" in settings.hooks, "PreCompact installed for compaction survival");

  const flat = JSON.stringify(settings);
  assert.ok(flat.includes("capture --auto"), "auto-capture wired");

  installHooks("claude-code", dir);
  const twice = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown[]>>;
  assert.equal(JSON.stringify(twice), flat, "re-install is idempotent");
}

{
  const dir = freshDir();
  const { path } = installHooks("cursor", dir);
  const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown[]>>;
  assert.ok("SessionStart" in settings.hooks && "Stop" in settings.hooks);
  assert.ok(JSON.stringify(settings).includes("capture --auto"), "cursor captures on stop");
}

{
  const dir = freshDir();
  const { path } = installHooks("windsurf", dir);
  assert.ok(existsSync(path));
  const rules = readFileSync(path, "utf8");
  assert.ok(rules.includes("resume --plain") && rules.includes("capture --auto"), "rules cover load + save");
  assert.ok(rules.toLowerCase().includes("compact"), "rules mention compaction survival");

  installHooks("windsurf", dir);
  assert.equal(readFileSync(path, "utf8"), rules, "re-install is idempotent");
}

{
  const dir = freshDir();
  const { path } = installHooks("codex", dir);
  const md = readFileSync(path, "utf8");
  assert.ok(md.includes("resume --plain") && md.includes("capture --auto"));
}

// ── Skill file ─────────────────────────────────────────────────────────────────

{
  const dir = freshDir();
  installHooks("claude-code", dir);
  const skill = join(dir, ".claude", "skills", "lorex", "SKILL.md");
  assert.ok(existsSync(skill), "SKILL.md written");
  const body = readFileSync(skill, "utf8");
  assert.ok(body.includes("recall") && body.includes("remember"), "skill covers recall + save");
}

// ── Status ───────────────────────────────────────────────────────────────────

{
  const dir = freshDir();
  const before = hooksStatus(dir);
  assert.ok(before.every((s) => !s.configured), "clean dir: nothing configured");

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
  assert.ok(!JSON.stringify(settings).includes("capture --auto"), "no capture commands remain");

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
  assert.ok(status.every((s) => !s.configured), "all clean after uninstall");
}

// ── New agents: opencode, gemini, aider ──────────────────────────────────────

{
  const dir = freshDir();

  const oc = installHooks("opencode", dir);
  assert.ok(oc.path.endsWith("opencode.json"));
  const oconf = JSON.parse(readFileSync(oc.path, "utf8")) as { mcp?: Record<string, unknown> };
  assert.ok(oconf.mcp?.lorex, "opencode MCP entry written");
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
  assert.ok(!after.mcp?.lorex, "opencode clean");

  assert.ok(uninstallHooks("aider", dir).removed, "aider guidance removed");
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

// ── Plugin packaging: valid JSON + skill parity ──────────────────────────────

{
  const pluginJson = JSON.parse(readFileSync("plugin/plugin.json", "utf8")) as Record<string, unknown>;
  assert.ok(pluginJson.name === "lorex" && typeof pluginJson.version === "string", "plugin.json valid");

  const market = JSON.parse(readFileSync(".claude-plugin/marketplace.json", "utf8")) as {
    plugins?: Array<{ name?: string }>;
  };
  assert.ok(market.plugins?.some((p) => p.name === "lorex"), "marketplace lists lorex");

  const hooksJson = JSON.parse(readFileSync("plugin/hooks/hooks.json", "utf8")) as {
    hooks?: Record<string, unknown>;
  };
  assert.ok(hooksJson.hooks?.SessionStart && hooksJson.hooks?.Stop && hooksJson.hooks?.PreCompact, "plugin hooks cover lifecycle");
  assert.ok(JSON.stringify(hooksJson).includes("npx -y @lorex/cli"), "plugin hooks work without install");

  const skill = readFileSync("plugin/skills/lorex/SKILL.md", "utf8");
  assert.equal(skill, skillMd("npx -y @lorex/cli"), "plugin skill matches installer source");
}

{
  const home = mkdtempSync(join(tmpdir(), "lorex-home-test-"));
  const dir = mkdtempSync(join(tmpdir(), "lorex-cli-test-"));
  const fakeUser = mkdtempSync(join(tmpdir(), "lorex-user-test-"));
  const prevHome = process.env.LOREX_HOME;
  const prevCwd = process.cwd();
  const prevUserProfile = process.env.USERPROFILE;
  const prevAppData = process.env.APPDATA;
  process.env.LOREX_HOME = home;
  process.env.USERPROFILE = fakeUser;
  process.env.APPDATA = join(fakeUser, "AppData", "Roaming");
  process.chdir(dir);
  try {
    await runCli(["setup", "--workspace", "cli-test"]);
    assert.ok(existsSync(join(dir, ".mcp.json")), ".mcp.json written");
    assert.ok(existsSync(join(dir, ".claude", "settings.json")), "claude hooks written");

    await runCli(["status"]);
    await runCli(["add", "CLI smoke fact because testing"]);
    await runCli(["profile"]);
    await runCli(["open-loops"]);
    await runCli(["dream"]);
    await runCli(["consolidate"]);
  } finally {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.LOREX_HOME;
    else process.env.LOREX_HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
  }

  // Sandboxed HOME assertions (no real user paths touched)
  assert.ok(
    existsSync(join(fakeUser, "AppData", "Roaming", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")),
    "cline wired in sandbox APPDATA",
  );
}

console.log("✓ hook installer tests passed");
