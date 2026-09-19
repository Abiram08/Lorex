/**
 * Agent hook installers: writes lifecycle hooks into each agent's config
 * so memory loads automatically every session.
 *
 * Each agent gets the integration it needs:
 *   claude-code → .claude/settings.json (SessionStart, PreCompact, Stop)
 *   cursor      → .cursor/settings.json (SessionStart, Stop)
 *   windsurf    → .windsurfrules (memory context)
 *   codex       → CODEX.md (instructions)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function readJson(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function hookExists(list: Array<Record<string, unknown>>, command: string): boolean {
  return list.some((h) => JSON.stringify(h).includes(command));
}

function ensureHook(
  hooks: Record<string, Array<Record<string, unknown>>>,
  event: string,
  matcher: string | undefined,
  command: string,
): void {
  const list = hooks[event] ?? [];
  if (hookExists(list, command)) return;
  list.push({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command }],
  });
  hooks[event] = list;
}

// ── Claude Code ──────────────────────────────────────────────────────────────

function loadHookSettings(cwd: string, dir: string, file: string): { path: string; hooks: Record<string, Array<Record<string, unknown>>>; save: () => void } {
  const dirPath = join(cwd, dir);
  mkdirSync(dirPath, { recursive: true });
  const path = join(dirPath, file);
  const settings = readJson(path);
  const hooks = (settings.hooks ?? {}) as Record<string, Array<Record<string, unknown>>>;
  return { path, hooks, save: () => { settings.hooks = hooks; writeJson(path, settings); } };
}

function installClaudeCode(cwd: string): string {
  const { path, hooks, save } = loadHookSettings(cwd, ".claude", "settings.json");

  ensureHook(hooks, "SessionStart", "startup", "lorex resume --plain");
  ensureHook(hooks, "SessionStart", "compact", "lorex resume --plain");
  ensureHook(hooks, "Stop", undefined, "lorex resume --plain");
  ensureHook(hooks, "PreCompact", undefined, "lorex capture --auto 2>/dev/null || true");

  // Auto-capture on stop
  const stopList = hooks.Stop ?? [];
  if (!hookExists(stopList, "lorex capture")) {
    stopList.push({ hooks: [{ type: "command", command: "lorex capture --auto 2>/dev/null || true" }] });
  }
  hooks.Stop = stopList;

  save();
  return path;
}

// ── Cursor ───────────────────────────────────────────────────────────────────

function installCursor(cwd: string): string {
  const { path, hooks, save } = loadHookSettings(cwd, ".cursor", "settings.json");

  ensureHook(hooks, "SessionStart", undefined, "lorex resume --plain");
  ensureHook(hooks, "Stop", undefined, "lorex capture --auto 2>/dev/null || true");

  save();
  return path;
}

// ── Windsurf ─────────────────────────────────────────────────────────────────

function installWindsurf(cwd: string): string {
  const rulesPath = join(cwd, ".windsurfrules");
  const existing = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : "";
  if (existing.includes("lorex")) return rulesPath;

  const block = [
    existing,
    "\n# Lorex Memory",
    "At session start, run `lorex resume --plain` to load project memory.",
    "At session end, run `lorex capture --auto` to save decisions.",
    "Before compacting context or clearing the session, run `lorex capture --auto` so decisions survive the wipe.\n",
  ].filter(Boolean).join("\n");

  writeFileSync(rulesPath, block);
  return rulesPath;
}

// ── Codex ────────────────────────────────────────────────────────────────────

function installCodex(cwd: string): string {
  const instructionsPath = join(cwd, "CODEX.md");
  const existing = existsSync(instructionsPath) ? readFileSync(instructionsPath, "utf8") : "";
  if (existing.includes("lorex")) return instructionsPath;

  const block = [
    existing,
    "\n## Lorex Memory",
    "Before starting work, run `lorex resume --plain` to load project memory.",
    "At session end, run `lorex capture --auto` to save decisions.",
    "Before compacting context or clearing the session, run `lorex capture --auto` so decisions survive the wipe.\n",
  ].filter(Boolean).join("\n");

  writeFileSync(instructionsPath, block);
  return instructionsPath;
}

export type AgentKind = "claude-code" | "cursor" | "windsurf" | "codex";

const INSTALLERS: Record<AgentKind, (cwd: string) => string> = {
  "claude-code": installClaudeCode,
  cursor: installCursor,
  windsurf: installWindsurf,
  codex: installCodex,
};

export function installHooks(agent: AgentKind, cwd: string): { path: string; description: string } {
  const path = INSTALLERS[agent](cwd);
  const descriptions: Record<AgentKind, string> = {
    "claude-code": "SessionStart → memory loads every session\n  PreCompact → session captured before compaction wipe\n  Stop → session auto-captured",
    cursor: "SessionStart → memory loads every session\n  Stop → session auto-captured",
    windsurf: "Memory context added to .windsurfrules",
    codex: "Memory instructions added to CODEX.md",
  };
  return { path, description: descriptions[agent] };
}

export function isAgentSupported(agent: string): agent is AgentKind {
  return agent in INSTALLERS;
}
