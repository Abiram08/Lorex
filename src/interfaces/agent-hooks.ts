/**
 * Agent hook installers: writes lifecycle hooks into each agent's config
 * so memory loads automatically every session.
 *
 * Each agent gets the integration it needs:
 *   claude-code → .claude/settings.json (SessionStart, PreCompact, Stop) + skill
 *   cursor      → .cursor/hooks.json (native lifecycle hooks)
 *   windsurf    → .windsurfrules (memory context)
 *   codex       → .codex/hooks.json + AGENTS.md
 *   opencode    → opencode.json (MCP) + AGENTS.md (guidance)
 *   grok        → .grok/config.toml (MCP) + .grok/hooks/lorex.json
 *   gemini      → ~/.gemini/settings.json (MCP) + GEMINI.md (guidance)
 *   cline       → cline_mcp_settings.json (MCP) + .clinerules (guidance)
 *   aider       → AGENTS.md (conventions; shell commands, no MCP)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Also lets isolated installers/tests target a portable agent configuration home. */
export function agentHome(): string {
  return process.env.LOREX_AGENT_HOME?.trim() || homedir();
}

/**
 * Command prefix for hooks/skills/rules. Global installs use `lorex`;
 * npx/one-shot runs fall back to `npx -y @lorex/cli` so hooks work
 * even when the binary was never installed.
 */
export function lorexBin(): string {
  const entry = process.argv[1] ?? "";
  // `npx` temporarily places a `lorex` shim on PATH. Treating that shim as a
  // durable global install leaves broken hooks as soon as the npx process ends.
  if (process.env.npm_command === "exec" || process.env.npm_lifecycle_event === "npx" || /[\\/]_npx[\\/]/i.test(entry)) {
    return "npx -y @lorex/cli";
  }
  try {
    execSync(process.platform === "win32" ? "where lorex" : "which lorex", { stdio: "ignore" });
    return "lorex";
  } catch {
    return "npx -y @lorex/cli";
  }
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function hookExists(list: Array<Record<string, unknown>>, command: string): boolean {
  return list.some((h) => JSON.stringify(h).includes(command));
}

/** Our guidance blocks end with this marker, so idempotency and removal key off
 *  the block rather than a bare "lorex" appearing anywhere in the file. */
const GUIDANCE_END = "<!-- lorex:end -->";

/** Matches a command whose executable is actually lorex, in the forms this
 *  tool installs (`lorex …` or `npx -y @lorex/cli …`) — not any command whose
 *  text happens to contain the word. */
const LOREX_COMMAND =
  /(?:^|&&|;|\|)\s*(?:(?:npx|pnpm|yarn|bunx)\s+(?:-y\s+)?@lorex\/cli|lorex)(?:\s|$)/;

/**
 * True only for a hook this tool installed. Matching the literal substring
 * "lorex" would delete a user's own unrelated hook that happens to mention it.
 */
function isLorexHook(hook: Record<string, unknown>): boolean {
  const inner = (hook as { hooks?: Array<{ command?: unknown }> }).hooks;
  if (!Array.isArray(inner)) return false;
  return inner.some((h) => typeof h?.command === "string" && LOREX_COMMAND.test(h.command));
}

function ensureHook(
  hooks: Record<string, Array<Record<string, unknown>>>,
  event: string,
  matcher: string | undefined,
  command: string,
  handlerOptions: Record<string, unknown> = {},
): void {
  const list = hooks[event] ?? [];
  const existing = list.find((hook) => hookExists([hook], command));
  if (existing) {
    const handlers = (existing as { hooks?: Array<Record<string, unknown>> }).hooks;
    const handler = handlers?.find((candidate) => candidate.command === command);
    if (handler) Object.assign(handler, handlerOptions);
    hooks[event] = list;
    return;
  }
  list.push({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command, ...handlerOptions }],
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

function skillSource(): string {
  return fileURLToPath(new URL("../../.agents/skills/lorex/SKILL.md", import.meta.url));
}

/** One skill body powers project setup and Claude's installed skill. */
function skillMd(): string { return readFileSync(skillSource(), "utf8"); }

function installSkill(cwd: string): string {
  const dir = join(cwd, ".claude", "skills", "lorex");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  if (!existsSync(path)) writeFileSync(path, skillMd());
  return path;
}

/** Install the reusable product skill without replacing a user's local edits. */
function installProjectSkill(cwd: string): string {
  const path = join(cwd, ".agents", "skills", "lorex", "SKILL.md");
  if (!existsSync(path)) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, skillMd());
  }
  return path;
}

function installClaudeCode(cwd: string): string {
  installSkill(cwd);
  const bin = lorexBin();
  const { path, hooks, save } = loadHookSettings(cwd, ".claude", "settings.json");
  const command = `${bin} harness --agent claude-code`;
  ensureHook(hooks, "SessionStart", undefined, command);
  ensureHook(hooks, "UserPromptSubmit", undefined, command);
  ensureHook(hooks, "PreCompact", undefined, command);
  ensureHook(hooks, "Stop", undefined, command);
  // Remove legacy Lorex handlers so a reinstall does not double-capture.
  for (const event of Object.keys(hooks)) {
    hooks[event] = hooks[event]!.filter((hook) => !isLorexHook(hook) || hookExists([hook], "harness --agent"));
  }

  save();
  return path;
}

// ── Cursor ───────────────────────────────────────────────────────────────────

function installCursor(cwd: string): string {
  const bin = lorexBin();
  const path = join(cwd, ".cursor", "hooks.json");
  const config = readJson(path);
  const hooks = (config.hooks ?? {}) as Record<string, Array<{ command: string }>>;
  const command = `${bin} harness --agent cursor`;
  for (const event of ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "preCompact", "stop"]) {
    const list = hooks[event] ?? [];
    if (!list.some((hook) => hook.command === command)) list.push({ command });
    hooks[event] = list;
  }
  config.version = 1;
  config.hooks = hooks;
  writeJson(path, config);
  // Remove obsolete Claude-shaped Lorex hooks from Cursor settings only.
  const legacyPath = join(cwd, ".cursor", "settings.json");
  if (existsSync(legacyPath)) {
    const legacy = readJson(legacyPath);
    const oldHooks = (legacy.hooks ?? {}) as Record<string, Array<Record<string, unknown>>>;
    let changed = false;
    for (const [event, list] of Object.entries(oldHooks)) {
      const kept = list.filter((hook) => !isLorexHook(hook));
      if (kept.length !== list.length) { oldHooks[event] = kept; changed = true; }
    }
    if (changed) { legacy.hooks = oldHooks; writeJson(legacyPath, legacy); }
  }
  return path;
}

// ── Windsurf ─────────────────────────────────────────────────────────────────

function installWindsurf(cwd: string): string {
  const bin = lorexBin();
  const rulesPath = join(cwd, ".windsurfrules");
  const existing = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : "";
  if (existing.includes(GUIDANCE_END)) return rulesPath;

  const block = [
    existing,
    "\n# Lorex Memory",
    `At session start, run \`${bin} resume --plain\` to load project memory.`,
    `At session end, save durable decisions and corrections explicitly with \`${bin} add "fact because reason"\`.`,
    `Before compacting context or clearing the session, save any important unsaved decisions with \`${bin} add\`.`,
    `Recall before answering about prior work; save decisions, preferences, and corrections with \`${bin} add\`. Skip recall for pure coding tasks with full context.`,
    "<!-- lorex:end -->\n",
  ].filter(Boolean).join("\n");

  writeFileSync(rulesPath, block);
  return rulesPath;
}

// ── Codex ────────────────────────────────────────────────────────────────────

function installCodex(cwd: string): string {
  const bin = lorexBin();
  appendGuidance(join(cwd, "AGENTS.md"), "## Lorex Memory", GUIDANCE_LINES(bin));
  const { path, hooks, save } = loadHookSettings(cwd, ".codex", "hooks.json");
  const command = `${bin} harness --agent codex`;
  const contextOptions = { timeout: 30, additionalContextLimit: 1_200, statusMessage: "Loading Lorex memory" };
  const captureOptions = { timeout: 120, statusMessage: "Saving Lorex memory" };
  ensureHook(hooks, "SessionStart", undefined, command, contextOptions);
  ensureHook(hooks, "UserPromptSubmit", undefined, command, contextOptions);
  ensureHook(hooks, "PreCompact", undefined, command, captureOptions);
  ensureHook(hooks, "Stop", undefined, command, captureOptions);
  save();
  return path;
}

export type AgentKind =
  | "claude-code" | "cursor" | "windsurf" | "codex"
  | "opencode" | "grok" | "gemini" | "cline" | "aider"
  | "pi" | "omp";

const INSTALLERS: Record<AgentKind, (cwd: string) => string> = {
  "claude-code": installClaudeCode,
  cursor: installCursor,
  windsurf: installWindsurf,
  codex: installCodex,
  opencode: installOpenCode,
  grok: installGrok,
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
  `At session start, load project memory. At session end, save durable decisions explicitly.`,
  `Recall before answering about prior work; save decisions, preferences, and corrections.`,
  `Commands: \`${bin} resume --plain\` (load) · \`${bin} add "fact because reason"\` (remember)`,
];

function appendGuidance(path: string, header: string, lines: string[]): string {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.includes(GUIDANCE_END)) return path;
  const block = [existing, `\n${header}`, ...lines, "<!-- lorex:end -->\n"].filter(Boolean).join("\n");
  writeFileSync(path, block);
  return path;
}

function installOpenCode(cwd: string): string {
  const path = join(cwd, "opencode.json");
  const config = readJson(path);
  const mcp = (config.mcp ?? {}) as Record<string, unknown>;
  const entry = mcpServerEntry();
  const command = [entry.command, ...entry.args];
  // New projects use v2. Preserve a detected v1 layout rather than migrating
  // unrelated servers behind the user's back.
  const v1 = Object.keys(mcp).some((name) => name !== "servers");
  if (!v1) {
    const servers = (mcp.servers ?? {}) as Record<string, unknown>;
    servers.lorex = { type: "local", command };
    mcp.servers = servers;
  } else {
    mcp.lorex = { type: "local", command, enabled: true };
  }
  config.mcp = mcp;
  writeJson(path, config);
  appendGuidance(join(cwd, "AGENTS.md"), "## Lorex Memory", GUIDANCE_LINES(lorexBin()));
  return path;
}

function installGrok(cwd: string): string {
  const path = join(cwd, ".grok", "config.toml");
  mkdirSync(join(cwd, ".grok", "hooks"), { recursive: true });
  const entry = mcpServerEntry();
  const block = `[mcp_servers.lorex]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`;
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (!/^\[mcp_servers\.lorex\]\s*$/m.test(current)) {
    writeFileSync(path, current + (current && !current.endsWith("\n") ? "\n" : "") + block);
  }
  const hooksPath = join(cwd, ".grok", "hooks", "lorex.json");
  const command = `${lorexBin()} harness --agent grok`;
  const hooks: Record<string, Array<Record<string, unknown>>> = {};
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "PreCompact"]) {
    ensureHook(hooks, event, undefined, command, { timeout: event === "Stop" ? 120 : 30 });
  }
  writeJson(hooksPath, { hooks });
  appendGuidance(join(cwd, "AGENTS.md"), "## Lorex Memory", GUIDANCE_LINES(lorexBin()));
  return path;
}

function installGemini(cwd: string): string {
  const settingsPath = join(agentHome(), ".gemini", "settings.json");
  mkdirSync(join(agentHome(), ".gemini"), { recursive: true });
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
    ? process.env.APPDATA ?? join(agentHome(), "AppData", "Roaming")
    : process.platform === "darwin"
      ? join(agentHome(), "Library", "Application Support")
      : join(agentHome(), ".config");
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
  if (!existing.includes(GUIDANCE_END)) {
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
  const path = join(agentHome(), ".pi", "agent", "mcp.json");
  mkdirSync(join(agentHome(), ".pi", "agent"), { recursive: true });
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
  installProjectSkill(cwd);
  const descriptions: Record<AgentKind, string> = {
    "claude-code": "SessionStart → project memory\n  UserPromptSubmit → relevant recall\n  PreCompact/Stop → exact-session capture",
    cursor: "sessionStart → memory context\n  beforeSubmitPrompt/afterAgentResponse → captured turns",
    windsurf: "Memory context added to .windsurfrules",
    codex: "SessionStart/UserPromptSubmit/Stop hooks plus AGENTS.md guidance (Codex must trust project hooks)",
    opencode: "MCP added to opencode.json + guidance in AGENTS.md",
    grok: "MCP and lifecycle hooks added for Grok Build (project trust required)",
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
    if (list.some(isLorexHook)) found.push(event);
  }
  return found;
}

/** Which agents have Lorex wired in this project. */
export function hooksStatus(cwd: string): Array<{ agent: AgentKind; configured: boolean; detail: string }> {
  const claude = hooksContaining(join(cwd, ".claude", "settings.json"));
  const cursorConfig = readJson(join(cwd, ".cursor", "hooks.json"));
  const cursorHooks = (cursorConfig.hooks ?? {}) as Record<string, Array<{ command?: string }>>;
  const cursor = ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse"].every((event) =>
    cursorHooks[event]?.some((hook) => hook.command?.includes("harness --agent cursor")));
  const windsurfPath = join(cwd, ".windsurfrules");
  const codexPath = join(cwd, ".codex", "hooks.json");
  const windsurf = existsSync(windsurfPath) && readFileSync(windsurfPath, "utf8").includes(GUIDANCE_END);
  const codex = hooksContaining(codexPath);
  const openCodeMcp = (readJson(join(cwd, "opencode.json")).mcp ?? {}) as Record<string, unknown>;
  const openCode = openCodeMcp.lorex !== undefined || (openCodeMcp.servers as Record<string, unknown> | undefined)?.lorex !== undefined;
  const grok = /^\[mcp_servers\.lorex\]\s*$/m.test(existsSync(join(cwd, ".grok", "config.toml")) ? readFileSync(join(cwd, ".grok", "config.toml"), "utf8") : "")
    && hooksContaining(join(cwd, ".grok", "hooks", "lorex.json")).includes("SessionStart");
  const gemini = (readJson(join(agentHome(), ".gemini", "settings.json")).mcpServers as Record<string, unknown> | undefined)?.lorex !== undefined;
  const cline = (readJson(clineSettingsPath()).mcpServers as Record<string, unknown> | undefined)?.lorex !== undefined;
  const agentsPath = join(cwd, "AGENTS.md");
  const aider = existsSync(agentsPath) && readFileSync(agentsPath, "utf8").includes(GUIDANCE_END);
  const pi = (readJson(join(agentHome(), ".pi", "agent", "mcp.json")).mcpServers as Record<string, unknown> | undefined)?.lorex !== undefined;
  const omp = (readJson(join(cwd, ".omp", "mcp.json")).mcpServers as Record<string, unknown> | undefined)?.lorex !== undefined;
  return [
    { agent: "claude-code", configured: claude.length > 0, detail: claude.length ? `hooks: ${claude.join(", ")}` : "no hooks" },
    { agent: "cursor", configured: cursor, detail: cursor ? ".cursor/hooks.json" : "no hooks" },
    { agent: "windsurf", configured: windsurf, detail: windsurf ? ".windsurfrules" : "no rules" },
    { agent: "codex", configured: codex.includes("SessionStart") && codex.includes("UserPromptSubmit") && codex.includes("Stop"), detail: codex.length ? `hooks: ${codex.join(", ")}` : "no hooks" },
    { agent: "opencode", configured: openCode, detail: openCode ? "opencode.json" : "no config" },
    { agent: "grok", configured: grok, detail: grok ? ".grok/config.toml + hooks" : "no config" },
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
  const endMarker = GUIDANCE_END;
  const endIdx = existing.indexOf(endMarker, idx);
  if (endIdx === -1) return { path, removed: false };
  const after = existing.slice(endIdx + endMarker.length);
  writeFileSync(path, (existing.slice(0, idx) + after).replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "") + "\n");
  return { path, removed: true };
}

export function uninstallHooks(agent: AgentKind, cwd: string): { path: string; removed: boolean } {
  if (agent === "cursor") {
    const path = join(cwd, ".cursor", "hooks.json");
    const config = readJson(path);
    const hooks = (config.hooks ?? {}) as Record<string, Array<{ command?: string }>>;
    let removed = false;
    for (const [event, list] of Object.entries(hooks)) {
      const kept = list.filter((hook) => !hook.command?.includes("harness --agent cursor"));
      if (kept.length !== list.length) { hooks[event] = kept; removed = true; }
    }
    if (removed) { config.hooks = hooks; writeJson(path, config); }
    return { path, removed };
  }
  if (agent === "claude-code" || agent === "codex") {
    const dir = agent === "claude-code" ? ".claude" : ".codex";
    const path = join(cwd, dir, agent === "codex" ? "hooks.json" : "settings.json");
    const settings = readJson(path);
    const hooks = (settings.hooks ?? {}) as Record<string, Array<Record<string, unknown>>>;
    let removed = false;
    for (const [event, list] of Object.entries(hooks)) {
      const kept = list.filter((h) => !isLorexHook(h));
      if (kept.length !== list.length) { removed = true; hooks[event] = kept; }
    }
    if (removed) { settings.hooks = hooks; writeJson(path, settings); }
    if (agent === "codex") {
      removeGuidanceBlock(join(cwd, "AGENTS.md"), "## Lorex Memory");
      removeGuidanceBlock(join(cwd, "CODEX.md"), "## Lorex Memory");
    }
    return { path, removed };
  }
  if (agent === "opencode") {
    const path = join(cwd, "opencode.json");
    const config = readJson(path);
    const mcp = (config.mcp ?? {}) as Record<string, unknown>;
    const servers = mcp.servers as Record<string, unknown> | undefined;
    if (!("lorex" in mcp) && !servers?.lorex) return { path, removed: false };
    delete mcp.lorex;
    if (servers) delete servers.lorex;
    config.mcp = mcp;
    writeJson(path, config);
    return { path, removed: true };
  }
  if (agent === "grok") {
    const path = join(cwd, ".grok", "config.toml");
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    const updated = current.replace(/^\[mcp_servers\.lorex\]\r?\ncommand = [^\r\n]+\r?\nargs = [^\r\n]+\r?\n?/m, "");
    if (updated !== current) writeFileSync(path, updated);
    const hooksPath = join(cwd, ".grok", "hooks", "lorex.json");
    if (existsSync(hooksPath)) {
      const hooks = readJson(hooksPath);
      if (hooksContaining(hooksPath).length) writeJson(hooksPath, { ...hooks, hooks: {} });
    }
    return { path, removed: updated !== current };
  }
  if (agent === "gemini") {
    const path = join(agentHome(), ".gemini", "settings.json");
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
    const path = join(agentHome(), ".pi", "agent", "mcp.json");
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
  return removeGuidanceBlock(join(cwd, ".windsurfrules"), "# Lorex Memory");
}
