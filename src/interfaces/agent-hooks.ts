/**
 * Agent hook installers: writes lifecycle hooks into each agent's config
 * so memory loads automatically every session.
 *
 * Each agent gets the integration it needs:
 *   claude-code → .claude/settings.json (SessionStart, PreCompact, Stop) + skill
 *   cursor      → .cursor/settings.json (SessionStart, Stop)
 *   windsurf    → .windsurfrules (memory context)
 *   codex       → CODEX.md (instructions)
 *   opencode    → opencode.json (MCP) + AGENTS.md (guidance)
 *   gemini      → ~/.gemini/settings.json (MCP) + GEMINI.md (guidance)
 *   cline       → cline_mcp_settings.json (MCP) + .clinerules (guidance)
 *   aider       → AGENTS.md (conventions; shell commands, no MCP)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

/**
 * Command prefix for hooks/skills/rules. Global installs use `lorex`;
 * npx/one-shot runs fall back to `npx -y @lorex/cli` so hooks work
 * even when the binary was never installed.
 */
export function lorexBin(): string {
  try {
    execSync(process.platform === "win32" ? "where lorex" : "which lorex", { stdio: "ignore" });
    return "lorex";
  } catch {
    return "npx -y @lorex/cli";
  }
}

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

export const skillMd = (bin: string): string => `---
name: lorex-memory
description: Persistent project memory via Lorex. Recall past decisions before answering about prior work; save decisions, preferences, and corrections as they happen.
---

# Lorex memory

You have project memory tools (MCP: recall, remember, handoff, resume) and CLI equivalents (\`${bin} ask\`, \`${bin} add\`).

## When to recall

Before answering questions about prior work, past decisions, user preferences,
or "why is it like this" — recall first. Skip recall for pure coding tasks
where the full context is already in front of you.

## When to save

- After an architecture or library decision → remember it with the reason
- When the user states a preference → remember it with scope: global
- When correcting a previous approach → remember the correction
- When finishing a unit of work → handoff with the decision + next step

Keep it to durable facts. Session chatter is captured automatically; only
save what the next session would need.
`;

function installSkill(cwd: string): string {
  const dir = join(cwd, ".claude", "skills", "lorex");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  if (!existsSync(path)) writeFileSync(path, skillMd(lorexBin()));
  return path;
}

function installClaudeCode(cwd: string): string {
  installSkill(cwd);
  const bin = lorexBin();
  const { path, hooks, save } = loadHookSettings(cwd, ".claude", "settings.json");

  ensureHook(hooks, "SessionStart", "startup", `${bin} resume --plain`);
  ensureHook(hooks, "SessionStart", "compact", `${bin} resume --plain`);
  ensureHook(hooks, "Stop", undefined, `${bin} resume --plain`);
  ensureHook(hooks, "PreCompact", undefined, `${bin} capture --auto 2>/dev/null || true`);

  const stopList = hooks.Stop ?? [];
  if (!hookExists(stopList, "capture --auto")) {
    stopList.push({ hooks: [{ type: "command", command: `${bin} capture --auto 2>/dev/null || true` }] });
  }
  hooks.Stop = stopList;

  save();
  return path;
}

// ── Cursor ───────────────────────────────────────────────────────────────────

function installCursor(cwd: string): string {
  const bin = lorexBin();
  const { path, hooks, save } = loadHookSettings(cwd, ".cursor", "settings.json");

  ensureHook(hooks, "SessionStart", undefined, `${bin} resume --plain`);
  ensureHook(hooks, "Stop", undefined, `${bin} capture --auto 2>/dev/null || true`);

  save();
  return path;
}

// ── Windsurf ─────────────────────────────────────────────────────────────────

function installWindsurf(cwd: string): string {
  const bin = lorexBin();
  const rulesPath = join(cwd, ".windsurfrules");
  const existing = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : "";
  if (existing.includes("lorex")) return rulesPath;

  const block = [
    existing,
    "\n# Lorex Memory",
    `At session start, run \`${bin} resume --plain\` to load project memory.`,
    `At session end, run \`${bin} capture --auto\` to save decisions.`,
    `Before compacting context or clearing the session, run \`${bin} capture --auto\` so decisions survive the wipe.`,
    `Recall before answering about prior work; save decisions, preferences, and corrections with \`${bin} add\`. Skip recall for pure coding tasks with full context.`,
    "<!-- lorex:end -->\n",
  ].filter(Boolean).join("\n");

  writeFileSync(rulesPath, block);
  return rulesPath;
}

// ── Codex ────────────────────────────────────────────────────────────────────

function installCodex(cwd: string): string {
  const bin = lorexBin();
  const instructionsPath = join(cwd, "CODEX.md");
  const existing = existsSync(instructionsPath) ? readFileSync(instructionsPath, "utf8") : "";
  if (existing.includes("lorex")) return instructionsPath;

  const block = [
    existing,
    "\n## Lorex Memory",
    `Before starting work, run \`${bin} resume --plain\` to load project memory.`,
    `At session end, run \`${bin} capture --auto\` to save decisions.`,
    `Before compacting context or clearing the session, run \`${bin} capture --auto\` so decisions survive the wipe.`,
    `Recall before answering about prior work; save decisions, preferences, and corrections with \`${bin} add\`.`,
    "<!-- lorex:end -->\n",
  ].filter(Boolean).join("\n");

  writeFileSync(instructionsPath, block);
  return instructionsPath;
}

export type AgentKind =
  | "claude-code" | "cursor" | "windsurf" | "codex"
  | "opencode" | "gemini" | "cline" | "aider"
  | "pi" | "omp";

const INSTALLERS: Record<AgentKind, (cwd: string) => string> = {
  "claude-code": installClaudeCode,
  cursor: installCursor,
  windsurf: installWindsurf,
  codex: installCodex,
  opencode: installOpenCode,
  gemini: installGemini,
  cline: installCline,
  aider: installAider,
  pi: installPi,
  omp: installOmp,
};

function mcpServerEntry(): { command: string; args: string[] } {
  const bin = lorexBin();
  return bin === "lorex"
    ? { command: "lorex", args: ["start"] }
    : { command: "npx", args: ["-y", "@lorex/cli", "start"] };
}

const GUIDANCE_LINES = (bin: string): string[] => [
  `At session start, load project memory. At session end, save decisions.`,
  `Recall before answering about prior work; save decisions, preferences, and corrections.`,
  `Commands: \`${bin} resume --plain\` (load) · \`${bin} capture --auto\` (save) · \`${bin} add "fact because reason"\` (remember)`,
];

function appendGuidance(path: string, header: string, lines: string[]): string {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.includes("lorex")) return path;
  const block = [existing, `\n${header}`, ...lines, "<!-- lorex:end -->\n"].filter(Boolean).join("\n");
  writeFileSync(path, block);
  return path;
}

function installOpenCode(cwd: string): string {
  const path = join(cwd, "opencode.json");
  const config = readJson(path);
  const mcp = (config.mcp ?? {}) as Record<string, unknown>;
  mcp.lorex = { type: "local", ...mcpServerEntry(), enabled: true };
  config.mcp = mcp;
  writeJson(path, config);
  appendGuidance(join(cwd, "AGENTS.md"), "## Lorex Memory", GUIDANCE_LINES(lorexBin()));
  return path;
}

function installGemini(cwd: string): string {
  const settingsPath = join(homedir(), ".gemini", "settings.json");
  mkdirSync(join(homedir(), ".gemini"), { recursive: true });
  const settings = readJson(settingsPath);
  const servers = (settings.mcpServers ?? {}) as Record<string, unknown>;
  servers.lorex = mcpServerEntry();
  settings.mcpServers = servers;
  writeJson(settingsPath, settings);
  appendGuidance(join(cwd, "GEMINI.md"), "## Lorex Memory", GUIDANCE_LINES(lorexBin()));
  return settingsPath;
}

function clineSettingsPath(): string {
  const app = process.platform === "win32"
    ? process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : join(homedir(), ".config");
  return join(app, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
}

function installCline(cwd: string): string {
  const path = clineSettingsPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const settings = readJson(path);
  const servers = (settings.mcpServers ?? {}) as Record<string, unknown>;
  servers.lorex = { ...mcpServerEntry(), disabled: false };
  settings.mcpServers = servers;
  writeJson(path, settings);
  const rulesPath = join(cwd, ".clinerules");
  const existing = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : "";
  if (!existing.includes("lorex")) {
    const block = [existing, "\n# Lorex Memory", ...GUIDANCE_LINES(lorexBin()), "<!-- lorex:end -->\n"].filter(Boolean).join("\n");
    writeFileSync(rulesPath, block);
  }
  return path;
}

function installAider(cwd: string): string {
  return appendGuidance(join(cwd, "AGENTS.md"), "## Lorex Memory", [
    ...GUIDANCE_LINES(lorexBin()),
    "Aider has no MCP: run the commands above in your shell between sessions.",
  ]);
}

function installPi(cwd: string): string {
  const path = join(homedir(), ".pi", "agent", "mcp.json");
  mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
  const config = readJson(path);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers.lorex = { ...mcpServerEntry(), lifecycle: "lazy" };
  config.mcpServers = servers;
  writeJson(path, config);
  appendGuidance(join(cwd, "AGENTS.md"), "## Lorex Memory", GUIDANCE_LINES(lorexBin()));
  return path;
}

function installOmp(cwd: string): string {
  const path = join(cwd, ".omp", "mcp.json");
  mkdirSync(join(cwd, ".omp"), { recursive: true });
  const config = readJson(path);
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers.lorex = { type: "stdio", ...mcpServerEntry() };
  config.mcpServers = servers;
  writeJson(path, config);
  return path;
}

export function installHooks(agent: AgentKind, cwd: string): { path: string; description: string } {
  const path = INSTALLERS[agent](cwd);
  const descriptions: Record<AgentKind, string> = {
    "claude-code": "SessionStart → memory loads every session\n  PreCompact → session captured before compaction wipe\n  Stop → session auto-captured",
    cursor: "SessionStart → memory loads every session\n  Stop → session auto-captured",
    windsurf: "Memory context added to .windsurfrules",
    codex: "Memory instructions added to CODEX.md",
    opencode: "MCP added to opencode.json + guidance in AGENTS.md",
    gemini: "MCP added to ~/.gemini/settings.json + guidance in GEMINI.md",
    cline: "MCP added to cline settings + guidance in .clinerules",
    aider: "Memory conventions added to AGENTS.md (shell commands, no MCP)",
    pi: "MCP added to ~/.pi/agent/mcp.json + guidance in AGENTS.md",
    omp: "MCP added to .omp/mcp.json",
  };
  return { path, description: descriptions[agent] };
}

export function isAgentSupported(agent: string): agent is AgentKind {
  return agent in INSTALLERS;
}

function hooksContaining(path: string): string[] {
  const settings = readJson(path);
  const hooks = (settings.hooks ?? {}) as Record<string, Array<Record<string, unknown>>>;
  const found: string[] = [];
  for (const [event, list] of Object.entries(hooks)) {
    if (list.some((h) => JSON.stringify(h).includes("lorex"))) found.push(event);
  }
  return found;
}

/** Which agents have Lorex wired in this project. */
export function hooksStatus(cwd: string): Array<{ agent: AgentKind; configured: boolean; detail: string }> {
  const claude = hooksContaining(join(cwd, ".claude", "settings.json"));
  const cursor = hooksContaining(join(cwd, ".cursor", "settings.json"));
  const windsurfPath = join(cwd, ".windsurfrules");
  const codexPath = join(cwd, "CODEX.md");
  const windsurf = existsSync(windsurfPath) && readFileSync(windsurfPath, "utf8").includes("lorex");
  const codex = existsSync(codexPath) && readFileSync(codexPath, "utf8").includes("lorex");
  const openCode = (readJson(join(cwd, "opencode.json")).mcp as Record<string, unknown> | undefined)?.lorex !== undefined;  const gemini = (readJson(join(homedir(), ".gemini", "settings.json")).mcpServers as Record<string, unknown> | undefined)?.lorex !== undefined;
  const cline = (readJson(clineSettingsPath()).mcpServers as Record<string, unknown> | undefined)?.lorex !== undefined;
  const agentsPath = join(cwd, "AGENTS.md");
  const aider = existsSync(agentsPath) && readFileSync(agentsPath, "utf8").includes("lorex");
  const pi = (readJson(join(homedir(), ".pi", "agent", "mcp.json")).mcpServers as Record<string, unknown> | undefined)?.lorex !== undefined;
  const omp = (readJson(join(cwd, ".omp", "mcp.json")).mcpServers as Record<string, unknown> | undefined)?.lorex !== undefined;
  return [
    { agent: "claude-code", configured: claude.length > 0, detail: claude.length ? `hooks: ${claude.join(", ")}` : "no hooks" },
    { agent: "cursor", configured: cursor.length > 0, detail: cursor.length ? `hooks: ${cursor.join(", ")}` : "no hooks" },
    { agent: "windsurf", configured: windsurf, detail: windsurf ? ".windsurfrules" : "no rules" },
    { agent: "codex", configured: codex, detail: codex ? "CODEX.md" : "no instructions" },
    { agent: "opencode", configured: openCode, detail: openCode ? "opencode.json" : "no config" },
    { agent: "gemini", configured: gemini, detail: gemini ? "~/.gemini/settings.json" : "no config" },
    { agent: "cline", configured: cline, detail: cline ? "cline_mcp_settings.json" : "no config" },
    { agent: "aider", configured: aider, detail: aider ? "AGENTS.md" : "no conventions" },
    { agent: "pi", configured: pi, detail: pi ? "~/.pi/agent/mcp.json" : "no config" },
    { agent: "omp", configured: omp, detail: omp ? ".omp/mcp.json" : "no config" },
  ];
}

/** Remove Lorex entries. JSON configs are cleaned structurally; rules files only if our block is untouched. */
function removeGuidanceBlock(path: string, marker: string): { path: string; removed: boolean } {
  if (!existsSync(path)) return { path, removed: false };
  const existing = readFileSync(path, "utf8");
  const idx = existing.indexOf(marker);
  if (idx === -1) return { path, removed: false };
  const endMarker = "<!-- lorex:end -->";
  const endIdx = existing.indexOf(endMarker, idx);
  if (endIdx === -1) return { path, removed: false };
  const after = existing.slice(endIdx + endMarker.length);
  writeFileSync(path, (existing.slice(0, idx) + after).replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "") + "\n");
  return { path, removed: true };
}

export function uninstallHooks(agent: AgentKind, cwd: string): { path: string; removed: boolean } {
  if (agent === "claude-code" || agent === "cursor") {
    const dir = agent === "claude-code" ? ".claude" : ".cursor";
    const path = join(cwd, dir, "settings.json");
    const settings = readJson(path);
    const hooks = (settings.hooks ?? {}) as Record<string, Array<Record<string, unknown>>>;
    let removed = false;
    for (const [event, list] of Object.entries(hooks)) {
      const kept = list.filter((h) => !JSON.stringify(h).includes("lorex"));
      if (kept.length !== list.length) { removed = true; hooks[event] = kept; }
    }
    if (removed) { settings.hooks = hooks; writeJson(path, settings); }
    return { path, removed };
  }
  if (agent === "opencode") {
    const path = join(cwd, "opencode.json");
    const config = readJson(path);
    const mcp = (config.mcp ?? {}) as Record<string, unknown>;
    if (!("lorex" in mcp)) return { path, removed: false };
    delete mcp.lorex;
    config.mcp = mcp;
    writeJson(path, config);
    return { path, removed: true };
  }
  if (agent === "gemini") {
    const path = join(homedir(), ".gemini", "settings.json");
    const settings = readJson(path);
    const servers = (settings.mcpServers ?? {}) as Record<string, unknown>;
    if (!("lorex" in servers)) return { path, removed: false };
    delete servers.lorex;
    settings.mcpServers = servers;
    writeJson(path, settings);
    return { path, removed: true };
  }
  if (agent === "cline") {
    const path = clineSettingsPath();
    const settings = readJson(path);
    const servers = (settings.mcpServers ?? {}) as Record<string, unknown>;
    if (!("lorex" in servers)) return { path, removed: false };
    delete servers.lorex;
    settings.mcpServers = servers;
    writeJson(path, settings);
    return { path, removed: true };
  }
  if (agent === "aider") {
    return removeGuidanceBlock(join(cwd, "AGENTS.md"), "## Lorex Memory");
  }
  if (agent === "pi") {
    const path = join(homedir(), ".pi", "agent", "mcp.json");
    const config = readJson(path);
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    if (!("lorex" in servers)) return { path, removed: false };
    delete servers.lorex;
    config.mcpServers = servers;
    writeJson(path, config);
    return { path, removed: true };
  }
  if (agent === "omp") {
    const path = join(cwd, ".omp", "mcp.json");
    const config = readJson(path);
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    if (!("lorex" in servers)) return { path, removed: false };
    delete servers.lorex;
    config.mcpServers = servers;
    writeJson(path, config);
    return { path, removed: true };
  }
  const path = agent === "windsurf" ? join(cwd, ".windsurfrules") : join(cwd, "CODEX.md");
  return removeGuidanceBlock(path, agent === "windsurf" ? "# Lorex Memory" : "## Lorex Memory");
}
