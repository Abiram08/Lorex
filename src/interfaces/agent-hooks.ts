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
import { fileURLToPath } from "node:url";
import { lorexCommand, lorexMcpCommand, renderLorexCommand } from "../infrastructure/runtime-command.js";

/** Also lets isolated installers/tests target a portable agent configuration home. */
export function agentHome(): string {
  return process.env.LOREX_AGENT_HOME?.trim() || homedir();
}

/** Shell command prefix used by lifecycle hooks and project guidance. */
export function lorexBin(): string {
  return renderLorexCommand(lorexCommand());
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
  return inner.some((h) => {
    if (typeof h?.command !== "string") return false;
    if (LOREX_COMMAND.test(h.command)) return true;
    // Managed npx runtimes invoke `node <durable package>/dist/index.js`.
    // Require both the package path and harness verb so unrelated Node hooks
    // that merely live near a folder named Lorex are never removed.
    return /(?:@lorex[\\/]cli|[\\/]\.lorex[\\/]runtime)[\\/].*dist[\\/]index\.js/i.test(h.command)
      && /\sharness\s+--agent(?:\s|$)/.test(h.command);
  });
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
  // Replace prior Lorex runtime commands without touching unrelated handlers.
  for (const event of Object.keys(hooks)) {
    hooks[event] = hooks[event]!.filter((hook) => !isLorexHook(hook) || hookExists([hook], command));
  }
  ensureHook(hooks, "SessionStart", undefined, command);
  ensureHook(hooks, "UserPromptSubmit", undefined, command);
  ensureHook(hooks, "PreCompact", undefined, command);
  ensureHook(hooks, "Stop", undefined, command);
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
    const list = (hooks[event] ?? []).filter((hook) => !hook.command?.includes("harness --agent cursor") || hook.command === command);
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
  for (const event of Object.keys(hooks)) {
    hooks[event] = hooks[event]!.filter((hook) => !isLorexHook(hook) || hookExists([hook], command));
  }
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

function mcpServerEntry(agent: string): { command: string; args: string[] } {
  return lorexMcpCommand(agent);
}

const GUIDANCE_LINES = (bin: string): string[] => [
  `At session start, load project memory. At session end, save durable decisions explicitly.`,
  `Recall before answering about prior work; save decisions, preferences, and corrections.`,
  `Commands: \`${bin} resume --plain\` (load) · \`${bin} add "fact because reason"\` (remember)`,
];

function upsertTomlSection(text: string, section: string, block: string): string {
  const lines = text.split(/\r?\n/);
  const header = `[${section}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return text + (text && !text.endsWith("\n") ? "\n" : "") + block;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end] ?? "")) end++;
  const replacement = block.replace(/\n$/, "").split("\n");
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n").replace(/\n*$/, "\n");
}

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
  const entry = mcpServerEntry("opencode");
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
  const entry = mcpServerEntry("grok");
  const block = `[mcp_servers.lorex]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`;
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const updated = upsertTomlSection(current, "mcp_servers.lorex", block);
  if (updated !== current) writeFileSync(path, updated);
  const hooksPath = join(cwd, ".grok", "hooks", "lorex.json");
  const command = `${lorexBin()} harness --agent grok`;
  const hookConfig = readJson(hooksPath);
  const hooks = (hookConfig.hooks ?? {}) as Record<string, Array<Record<string, unknown>>>;
  for (const event of Object.keys(hooks)) {
    hooks[event] = hooks[event]!.filter((hook) => !isLorexHook(hook) || hookExists([hook], command));
  }
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "PreCompact"]) {
    ensureHook(hooks, event, undefined, command, { timeout: event === "Stop" ? 120 : 30 });
  }
  hookConfig.hooks = hooks;
  writeJson(hooksPath, hookConfig);
  appendGuidance(join(cwd, "AGENTS.md"), "## Lorex Memory", GUIDANCE_LINES(lorexBin()));
  return path;
}

function installGemini(cwd: string): string {
  const settingsPath = join(agentHome(), ".gemini", "settings.json");
  mkdirSync(join(agentHome(), ".gemini"), { recursive: true });
  const settings = readJson(settingsPath);
  const servers = (settings.mcpServers ?? {}) as Record<string, unknown>;
  servers.lorex = mcpServerEntry("gemini");
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
  servers.lorex = { ...mcpServerEntry("cline"), disabled: false };
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
  servers.lorex = { ...mcpServerEntry("pi"), lifecycle: "lazy" };
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
  servers.lorex = { type: "stdio", ...mcpServerEntry("omp") };
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

export interface AgentConnectionStatus {
  agent: "claude-code" | "codex" | "cursor" | "opencode" | "grok";
  label: string;
  configured: boolean;
  capabilities: string[];
  detail: string;
  action?: string;
}

function guidanceInstalled(cwd: string): boolean {
  const path = join(cwd, "AGENTS.md");
  return existsSync(path) && readFileSync(path, "utf8").includes(GUIDANCE_END);
}

function jsonMcp(path: string, root: "mcpServers" | "mcp"): boolean {
  const config = readJson(path);
  const value = config[root] as Record<string, unknown> | undefined;
  if (root === "mcpServers") return value?.lorex !== undefined;
  return value?.lorex !== undefined || (value?.servers as Record<string, unknown> | undefined)?.lorex !== undefined;
}

function transientConfig(paths: string[]): boolean {
  const transient = /(?:^|[\s"'=,:])npx(?:\.cmd)?(?=[\s"',])[\s\S]{0,200}@lorex[\\/]cli/i;
  return paths.some((path) => existsSync(path) && transient.test(readFileSync(path, "utf8")));
}

function attributedConfig(path: string, agent: string): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  return text.includes("--agent") && text.includes(agent);
}

/** Honest configuration capabilities for the five core supported agents. */
export function coreAgentConnections(cwd: string): AgentConnectionStatus[] {
  const inspect = (agent: AgentConnectionStatus["agent"], label: string, fn: () => Omit<AgentConnectionStatus, "agent" | "label">): AgentConnectionStatus => {
    try { return { agent, label, ...fn() }; }
    catch (error) {
      return {
        agent, label, configured: false, capabilities: [],
        detail: (error as Error).message,
        action: `Repair the reported config, then run lorex setup again for ${label}.`,
      };
    }
  };
  const agentsGuidance = guidanceInstalled(cwd);
  return [
    inspect("claude-code", "Claude Code", () => {
      const hookPath = join(cwd, ".claude", "settings.json");
      const mcpPath = join(cwd, ".mcp.json");
      const hooks = hooksContaining(hookPath);
      const required = ["SessionStart", "UserPromptSubmit", "PreCompact", "Stop"];
      const mcp = jsonMcp(mcpPath, "mcpServers") && attributedConfig(mcpPath, "claude-code");
      const lifecycle = required.every((event) => hooks.includes(event));
      const guidance = existsSync(join(cwd, ".claude", "skills", "lorex", "SKILL.md"));
      const durable = !transientConfig([hookPath, mcpPath]);
      const configured = mcp && guidance && durable && lifecycle;
      return {
        configured,
        capabilities: [mcp && "MCP recall/write", lifecycle && "automatic context", lifecycle && "automatic capture", guidance && "skill guidance"].filter(Boolean) as string[],
        detail: `${mcpPath}; ${hookPath}`,
        action: configured ? "Restart Claude Code; verify one real SessionStart and Stop event before relying on capture." : "Run lorex setup to repair Claude Code MCP, skill, or lifecycle hooks.",
      };
    }),
    inspect("codex", "Codex", () => {
      const hookPath = join(cwd, ".codex", "hooks.json");
      const mcpPath = join(agentHome(), ".codex", "config.toml");
      const hooks = hooksContaining(hookPath);
      const required = ["SessionStart", "UserPromptSubmit", "PreCompact", "Stop"];
      const mcp = existsSync(mcpPath) && /^\[mcp_servers\.lorex\]\s*$/m.test(readFileSync(mcpPath, "utf8")) && attributedConfig(mcpPath, "codex");
      const lifecycle = required.every((event) => hooks.includes(event));
      const durable = !transientConfig([hookPath, mcpPath]);
      const configured = mcp && agentsGuidance && durable && lifecycle;
      return {
        configured,
        capabilities: [mcp && "MCP recall/write", lifecycle && "automatic context", lifecycle && "automatic capture", agentsGuidance && "AGENTS.md guidance"].filter(Boolean) as string[],
        detail: `${mcpPath}; ${hookPath}`,
        action: configured ? "Restart Codex and trust the project hooks in /hooks; real hook execution is not inferred from these files." : "Run lorex setup to repair Codex MCP, guidance, or lifecycle hooks.",
      };
    }),
    inspect("cursor", "Cursor", () => {
      const hookPath = join(cwd, ".cursor", "hooks.json");
      const mcpPath = join(cwd, ".cursor", "mcp.json");
      const config = readJson(hookPath);
      const hooks = (config.hooks ?? {}) as Record<string, Array<{ command?: string }>>;
      const required = ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "preCompact", "stop"];
      const lifecycle = required.every((event) => hooks[event]?.some((hook) => hook.command?.includes("harness --agent cursor")));
      const mcp = jsonMcp(mcpPath, "mcpServers") && attributedConfig(mcpPath, "cursor");
      const durable = !transientConfig([hookPath, mcpPath]);
      const configured = mcp && lifecycle && durable;
      return {
        configured,
        capabilities: [mcp && "MCP recall/write", lifecycle && "automatic context", lifecycle && "automatic capture"].filter(Boolean) as string[],
        detail: `${mcpPath}; ${hookPath}`,
        action: configured ? "Restart Cursor; verify one real sessionStart and afterAgentResponse event before relying on capture." : "Run lorex setup to repair Cursor MCP or native lifecycle hooks.",
      };
    }),
    inspect("opencode", "OpenCode", () => {
      const path = join(cwd, "opencode.json");
      const mcp = jsonMcp(path, "mcp") && attributedConfig(path, "opencode");
      const durable = !transientConfig([path]);
      const configured = mcp && agentsGuidance && durable;
      return {
        configured,
        capabilities: [mcp && "MCP recall/write", agentsGuidance && "AGENTS.md guidance", "no automatic capture"].filter(Boolean) as string[],
        detail: `${path}; ${join(cwd, "AGENTS.md")}`,
        action: configured ? "Restart OpenCode. Use Lorex MCP tools as guided; no lifecycle capture is claimed." : "Run lorex setup to repair OpenCode MCP or guidance.",
      };
    }),
    inspect("grok", "Grok Build", () => {
      const mcpPath = join(cwd, ".grok", "config.toml");
      const hookPath = join(cwd, ".grok", "hooks", "lorex.json");
      const hooks = hooksContaining(hookPath);
      const required = ["SessionStart", "UserPromptSubmit", "PreCompact", "Stop"];
      const mcp = existsSync(mcpPath) && /^\[mcp_servers\.lorex\]\s*$/m.test(readFileSync(mcpPath, "utf8")) && attributedConfig(mcpPath, "grok");
      const capture = required.every((event) => hooks.includes(event));
      const durable = !transientConfig([mcpPath, hookPath]);
      const configured = mcp && capture && agentsGuidance && durable;
      return {
        configured,
        capabilities: [mcp && "MCP recall/write", capture && "automatic capture hooks", agentsGuidance && "AGENTS.md guidance", "context via MCP guidance"].filter(Boolean) as string[],
        detail: `${mcpPath}; ${hookPath}`,
        action: configured ? "Restart Grok Build and approve /hooks-trust. Passive hook stdout is not claimed as automatic context injection." : "Run lorex setup to repair Grok Build MCP, guidance, or hooks.",
      };
    }),
  ];
}

/** Which agents have Lorex wired in this project. */
export function hooksStatus(cwd: string): Array<{ agent: AgentKind; configured: boolean; detail: string }> {
  const safe = (fn: () => boolean): boolean => { try { return fn(); } catch { return false; } };
  const windsurfPath = join(cwd, ".windsurfrules");
  const agentsPath = join(cwd, "AGENTS.md");
  const claude = safe(() => ["SessionStart", "UserPromptSubmit", "PreCompact", "Stop"].every((event) => hooksContaining(join(cwd, ".claude", "settings.json")).includes(event)));
  const codex = safe(() => ["SessionStart", "UserPromptSubmit", "PreCompact", "Stop"].every((event) => hooksContaining(join(cwd, ".codex", "hooks.json")).includes(event)));
  const cursor = safe(() => {
    const config = readJson(join(cwd, ".cursor", "hooks.json"));
    const hooks = (config.hooks ?? {}) as Record<string, Array<{ command?: string }>>;
    return ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "preCompact", "stop"].every((event) => hooks[event]?.some((hook) => hook.command?.includes("harness --agent cursor")));
  });
  const openCode = safe(() => jsonMcp(join(cwd, "opencode.json"), "mcp"));
  const grok = safe(() => ["SessionStart", "UserPromptSubmit", "PreCompact", "Stop"].every((event) => hooksContaining(join(cwd, ".grok", "hooks", "lorex.json")).includes(event)));
  return [
    { agent: "claude-code", configured: claude, detail: claude ? ".claude/settings.json" : "no complete hook set" },
    { agent: "codex", configured: codex, detail: codex ? ".codex/hooks.json" : "no complete hook set" },
    { agent: "cursor", configured: cursor, detail: cursor ? ".cursor/hooks.json" : "no complete hook set" },
    { agent: "opencode", configured: openCode, detail: openCode ? "MCP only; no lifecycle hooks" : "no config" },
    { agent: "grok", configured: grok, detail: grok ? ".grok/hooks/lorex.json" : "no complete hook set" },
    { agent: "windsurf", configured: safe(() => existsSync(windsurfPath) && readFileSync(windsurfPath, "utf8").includes(GUIDANCE_END)), detail: ".windsurfrules" },
    { agent: "gemini", configured: safe(() => (readJson(join(agentHome(), ".gemini", "settings.json")).mcpServers as Record<string, unknown> | undefined)?.lorex !== undefined), detail: "~/.gemini/settings.json" },
    { agent: "cline", configured: safe(() => (readJson(clineSettingsPath()).mcpServers as Record<string, unknown> | undefined)?.lorex !== undefined), detail: "cline_mcp_settings.json" },
    { agent: "aider", configured: safe(() => existsSync(agentsPath) && readFileSync(agentsPath, "utf8").includes(GUIDANCE_END)), detail: "AGENTS.md" },
    { agent: "pi", configured: safe(() => (readJson(join(agentHome(), ".pi", "agent", "mcp.json")).mcpServers as Record<string, unknown> | undefined)?.lorex !== undefined), detail: "~/.pi/agent/mcp.json" },
    { agent: "omp", configured: safe(() => (readJson(join(cwd, ".omp", "mcp.json")).mcpServers as Record<string, unknown> | undefined)?.lorex !== undefined), detail: ".omp/mcp.json" },
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
