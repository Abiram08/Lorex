/** Hook installer tests: writes into temp dirs, idempotent, all four agents. */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { installHooks, isAgentSupported } from "../interfaces/agent-hooks.js";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "lorex-hooks-test-"));
}

{
  assert.ok(isAgentSupported("claude-code"));
  assert.ok(isAgentSupported("cursor"));
  assert.ok(isAgentSupported("windsurf"));
  assert.ok(isAgentSupported("codex"));
  assert.ok(!isAgentSupported("not-an-agent"));
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
  assert.ok(flat.includes("lorex capture"), "auto-capture wired");

  installHooks("claude-code", dir);
  const twice = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown[]>>;
  assert.equal(JSON.stringify(twice), flat, "re-install is idempotent");
}

{
  const dir = freshDir();
  const { path } = installHooks("cursor", dir);
  const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown[]>>;
  assert.ok("SessionStart" in settings.hooks && "Stop" in settings.hooks);
  assert.ok(JSON.stringify(settings).includes("lorex capture"), "cursor captures on stop");
}

{
  const dir = freshDir();
  const { path } = installHooks("windsurf", dir);
  assert.ok(existsSync(path));
  const rules = readFileSync(path, "utf8");
  assert.ok(rules.includes("lorex resume") && rules.includes("lorex capture"), "rules cover load + save");
  assert.ok(rules.toLowerCase().includes("compact"), "rules mention compaction survival");

  installHooks("windsurf", dir);
  assert.equal(readFileSync(path, "utf8"), rules, "re-install is idempotent");
}

{
  const dir = freshDir();
  const { path } = installHooks("codex", dir);
  const md = readFileSync(path, "utf8");
  assert.ok(md.includes("lorex resume") && md.includes("lorex capture"));
}

console.log("✓ hook installer tests passed");
