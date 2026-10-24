/** Command-line interface. */

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, saveProjectWorkspace, saveActiveTask, projectConfigFile, projectRoot, defaultWorkspace, configFile, type Config } from "../infrastructure/config.js";
import { lorexHome, storeDbPath } from "../infrastructure/paths.js";
import { resolveIdentity } from "../infrastructure/identity.js";
import { type HydraDBLike } from "../infrastructure/store.js";
import { MockHydraDB } from "../infrastructure/mock-hydradb.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { LorexEngine } from "../engine.js";
import { runStdioServer } from "./mcp-server.js";
import { agentHome, coreAgentConnections, installHooks, isAgentSupported } from "./agent-hooks.js";
import { ensureDurableLorexCommand, lorexCommand, lorexMcpCommand } from "../infrastructure/runtime-command.js";
import { liveDaemon } from "../daemon/lock.js";
import { detectLocalModels, type LocalModels } from "../infrastructure/local-models.js";
import { VERSION } from "../infrastructure/version.js";
import { safeTaskText, taskContext, TASK_KINDS, validateTaskId } from "./task-context.js";

function println(s = ""): void { process.stdout.write(s + "\n"); }

/** Probe Ollama and export endpoints so embed/LLM paths light up with zero config. */
async function applyLocalModels(): Promise<LocalModels> {
  const found = await detectLocalModels();
  if (found.embedUrl && !process.env.LOREX_EMBED_URL) {
    process.env.LOREX_EMBED_URL = found.embedUrl;
    if (found.embedModel) process.env.LOREX_EMBED_MODEL = found.embedModel;
  }
  if (found.llmBaseUrl && !process.env.LOREX_LLM_BASE_URL) {
    process.env.LOREX_LLM_BASE_URL = found.llmBaseUrl;
    if (found.llmApiKey) process.env.LOREX_LLM_API_KEY = found.llmApiKey;
    if (found.llmModel && !process.env.LOREX_SYNTH_MODEL) process.env.LOREX_SYNTH_MODEL = found.llmModel;
  }
  return found;
}

function modelSummary(found: LocalModels): string {
  const parts: string[] = [];
  parts.push(found.embedUrl ? `semantic: on (${found.embedModel ?? "embeddings"} via ${found.embedUrl})` : "semantic: off (FTS only)");
  parts.push(found.llmBaseUrl ? `llm: on (${found.llmBaseUrl})` : "llm: off (deterministic synthesis)");
  return parts.join(" · ");
}

const BANNER = String.raw`
  ██╗      ██████╗ ██████╗ ███████╗██╗  ██╗
  ██║     ██╔═══██╗██╔══██╗██╔════╝╚██╗██╔╝
  ██║     ██║   ██║██████╔╝█████╗   ╚███╔╝
  ██║     ██║   ██║██╔══██╗██╔══╝   ██╔██╗
  ███████╗╚██████╔╝██║  ██║███████╗██╔╝ ██╗
  ╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
`;

const AGENT_SETUP: Array<{ name: string; file: string; snippet: (ws: string) => string }> = [
  {
    name: "Claude Code",
    file: ".mcp.json in your project root",
    // Workspace auto-resolves from stored config — plain `lorex start` is enough.
    snippet: (_ws) =>
      JSON.stringify(
        { mcpServers: { lorex: { command: "lorex", args: ["start"] } } },
        null,
        2,
      ),
  },
  {
    name: "Codex",
    file: "~/.codex/config.toml",
    snippet: (_ws) =>
      `[mcp_servers.lorex]\ncommand = "lorex"\nargs = ["start"]`,
  },
];

function upsertTomlSection(text: string, section: string, block: string): string {
  const header = `[${section}]`;
  const start = text.split(/\r?\n/).findIndex((line) => line.trim() === header);
  if (start < 0) return text + (text && !text.endsWith("\n") ? "\n" : "") + block;
  const lines = text.split(/\r?\n/);
  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end] ?? "")) end++;
  const replacement = block.replace(/\n$/, "").split("\n");
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n").replace(/\n*$/, "\n");
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON — refusing to overwrite it`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object — refusing to overwrite it`);
  }
  return parsed as Record<string, unknown>;
}

/** One command: workspace + agent wiring + hooks + smoke test. */
async function cmdSetup(args: string[]): Promise<void> {
  const at = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const cwd = projectRoot();
  const config = loadConfig();
  const workspace =
    at("--workspace")?.trim() || config.workspace ||
    defaultWorkspace(cwd);

  const nonInteractive = args.includes("--yes") || args.includes("-y") || !process.stdin.isTTY;
  const currentDir = config.dataDir || lorexHome();
  let dataDir = at("--data-dir")?.trim() || config.dataDir || "";
  if (!dataDir && !nonInteractive) {
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      println(`  Where should memory live? (one SQLite file, yours forever)`);
      const answer = await new Promise<string>((resolve) => {
        rl.question(`  Data dir [${currentDir}]: `, (a) => resolve(a.trim()));
      });
      if (answer) dataDir = answer;
    } finally {
      rl.close();
    }
    println();
  }
  if (dataDir) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dataDir, { recursive: true });
  }
  saveProjectWorkspace(workspace, cwd);
  if (dataDir) saveConfig({ dataDir });

  let runtime;
  try {
    runtime = ensureDurableLorexCommand();
  } catch (error) {
    process.exitCode = 1;
    println(`[fail] Runtime: ${(error as Error).message}`);
    return;
  }

  println(`Setting up Lorex for workspace "${workspace}"`);
  println(`Runtime: ${runtime.source === "managed-runtime" ? runtime.args[0] : runtime.command} (offline-safe)`);
  println(`Memory lives at: ${storeDbPath(dataDir || undefined)}\n`);

  println("[1/3] Wiring agents (MCP)…");
  try {
    await cmdWire(["--agent", "all", "--workspace", workspace]);
  } catch (error) {
    process.exitCode = 1;
    println(`  [fail] MCP wiring: ${(error as Error).message}`);
    println("  Repair the named configuration file without deleting unrelated settings, then run lorex again.");
    return;
  }

  println("\n[2/3] Installing agent hooks and guidance…");
  const requiredFailures: string[] = [];
  // Keep one-command setup useful across the supported local coding agents.
  for (const agent of ["claude-code", "codex", "cursor", "opencode", "grok"] as const) {
    try {
      const { path } = installHooks(agent, cwd);
      println(`  [ok] ${agent} → ${path}`);
      if (agent === "codex") println("       In Codex, open /hooks and trust the Lorex project hooks once.");
      if (agent === "grok") println("       In Grok Build, trust project hooks/MCP with /hooks-trust and use Lorex MCP to recall.");
    } catch (e) {
      println(`  [skip] ${agent}: ${(e as Error).message}`);
      requiredFailures.push(agent);
    }
  }

  println("\n[3/3] Smoke test…");
  const storePath = resolveLocalStorePath({ ...config, dataDir: dataDir || config.dataDir });
  const client = new SqliteStore({ path: storePath });
  const secondClient = new SqliteStore({ path: storePath });
  const engine = new LorexEngine(client, resolveIdentity(cwd, { workspace, agent: "claude-code" }));
  const second = new LorexEngine(secondClient, resolveIdentity(cwd, { workspace, agent: "opencode" }));
  await engine.ensureReady();
  await engine.remember("Lorex setup verified", { id: "lorex_setup", agent: "claude-code" });
  const q = await engine.recall({ query: "setup verified", maxResults: 1 });
  const shared = await second.recall({ query: "setup verified", maxResults: 1 });
  client.close();
  secondClient.close();
  println(q.sources.length > 0 ? "  [ok] remember → recall round-trip works" : "  [warn] recall empty — retry in a few seconds");

  // This verifies store/collection sharing with independent clients and agent
  // attribution. It does not pretend that a real external agent fired a hook.
  const sharedSource = shared.sources.find((source) => source.content.includes("Lorex setup verified"));
  const sharedOk = sharedSource?.agent === "claude-code";
  println(sharedOk
    ? "  [ok] shared store works: OpenCode identity recalled a Claude Code source"
    : "  [warn] shared store or source attribution failed across agent identities");

  const connections = coreAgentConnections(cwd);
  println("\nConfigured agent bridges:");
  for (const connection of connections) {
    println(`  ${connection.configured ? "[ok]" : "[fail]"} ${connection.label}: ${connection.capabilities.join(" · ") || "not configured"}`);
    if (!connection.configured && connection.action) println(`       ${connection.action}`);
  }
  const connectionFailures = connections.filter((connection) => !connection.configured).map((connection) => connection.label);
  if (requiredFailures.length || connectionFailures.length || !q.sources.length || !sharedOk) {
    process.exitCode = 1;
    const failures = [...new Set([...requiredFailures, ...connectionFailures])];
    println(`\nSetup incomplete: ${failures.length ? `agent bridges failed (${failures.join(", ")})` : "shared memory smoke test failed"}. Run lorex doctor after fixing this.`);
    return;
  }
  println(`\nDone. Restart agents and complete any trust step shown above.`);
  println("Configuration is verified; real agent hook execution must still be confirmed with a completed turn.");
  println(`Daily use: lorex add "fact because reason" · lorex ask "question?" · lorex (status)`);
}

/** Bare `lorex`: what do I have, what's pending. */
async function cmdStatus(args: string[]): Promise<void> {
  const useMock = args.includes("--mock");
  const config = useMock ? mockConfig() : loadConfig();
  const identity = identityFrom(args, config);
  const client = buildClient(useMock, config);

  println(`Lorex status — ${identity.workspace ? `workspace "${identity.workspace}"` : `project "${identity.collectionLabel}"`} (agent: ${identity.agent})`);
  println(`Memory lives at: ${resolveLocalStorePath(config)}`);
  const runtime = lorexCommand();
  println(`Runtime: ${runtime.durable ? "offline-safe" : "temporary"} (${runtime.source})`);
  if (config.activeTask) println(`Active shared task: ${config.activeTask}`);

  if (!(client instanceof SqliteStore)) {
    println(`Backend: mock (detailed stats need the local store)`);
    return;
  }

  const stats = client.getLifecycleStats(identity.collection);
  const loops = client.getOpenLoops(identity.collection);
  const handoffs = client.topByType(identity.collection, "handoff");
  const profile = client.getProfile(identity.collection, "project");

  const parts = Object.entries(stats.byType).map(([t, n]) => `${n} ${t}`);
  println(`Memory: ${stats.total} facts${parts.length ? ` (${parts.join(", ")})` : ""} · avg strength ${stats.avgStrength.toFixed(2)}`);
  if (stats.staleCount) println(`Stale: ${stats.staleCount} weak · ${stats.expiredCount} expired-validity`);
  println(`Open loops: ${loops.length}${loops[0] ? ` — oldest: "${loops[0].text.slice(0, 80)}" (${loops[0].age_days}d)` : ""}`);
  println(`Handoff: ${handoffs[0] ? `"${handoffs[0].text.slice(0, 100)}"` : "none recorded"}`);
  println(`Profile: ${profile ? `fresh (${profile.updated_at.slice(0, 10)})` : "not built yet — run lorex profile"}`);

  println("Agent bridges (configured files; not proof that an external agent fired a hook):");
  for (const connection of coreAgentConnections(projectRoot())) {
    println(`  ${connection.configured ? "[ok]" : "[!!]"} ${connection.label}: ${connection.capabilities.join(" · ") || connection.detail}`);
    if (connection.action) println(`       ${connection.action}`);
  }
}

/** A scoped, append-only brief and progress stream for simultaneous agents. */
async function cmdTask(args: string[]): Promise<void> {
  const [verb, rawId] = args;
  const at = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const config = loadConfig();
  const identity = identityFrom(args, config);
  const positionalId = rawId && !rawId.startsWith("--") ? rawId : undefined;
  const id = verb === "leave" ? undefined : validateTaskId(at("--task") ?? positionalId ?? config.activeTask ?? "");
  const store = new SqliteStore({ path: resolveLocalStorePath(config) });
  try {
    if (verb === "create") {
      store.createTask(identity.collection, id!, safeTaskText(at("--brief") ?? "", 4000));
      saveActiveTask(id!);
      println(`Task ${id} is active. Other agents in this project now receive its fresh context on each prompt.`);
    } else if (verb === "use") {
      if (!store.getTask(identity.collection, id!)) throw new Error(`task ${id} does not exist in this workspace`);
      saveActiveTask(id!);
      println(`Using shared task ${id}.`);
    } else if (verb === "note") {
      const kind = at("--kind") ?? "progress";
      if (!TASK_KINDS.includes(kind as typeof TASK_KINDS[number])) throw new Error(`kind must be ${TASK_KINDS.join("|")}`);
      const body = safeTaskText(at("--text") ?? "", 4000);
      const seq = store.appendTaskEvent(identity.collection, id!, at("--agent") ?? identity.agent,
        kind, body, at("--session"));
      println(`Recorded ${id} event #${seq}.`);
    } else if (verb === "show") {
      const after = Math.max(0, Number(at("--after") ?? "0") || 0);
      const task = store.getTask(identity.collection, id!, after, 100);
      if (!task) throw new Error(`task ${id} does not exist in this workspace`);
      if (args.includes("--json")) println(JSON.stringify(task));
      else if (after > 0) println([`Task ${id} events after #${after}:`, ...task.events.map((e) => `#${e.seq} [${e.agent}/${e.kind}] ${e.body}`)].join("\n"));
      else println(taskContext(store, identity.collection, id!, 8000));
    } else if (verb === "leave") {
      saveActiveTask(undefined);
      println("No active shared task. Stored task history remains available.");
    } else {
      throw new Error('Usage: lorex task create ID --brief "..." | use ID | note --text "..." [--kind progress|decision|blocker|handoff] | show [ID] [--after N] | leave');
    }
  } finally { store.close(); }
}

/** Connect this project to coding agents. Writes configs instead of printing snippets. */
async function cmdWire(args: string[]): Promise<void> {
  ensureDurableLorexCommand();
  const at = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const only = at("--agent"); // claude | cursor | windsurf | codex | all (default: file-based agents)
  const cwd = projectRoot();

  // Resolve + persist workspace so `lorex start` needs no flags.
  const config = loadConfig();
  const workspace =
    at("--workspace")?.trim() || config.workspace ||
    defaultWorkspace(cwd);
  saveProjectWorkspace(workspace, cwd);

  const done: string[] = [];
  const wantFileAgents = !only || only === "all" || ["claude", "windsurf"].includes(only);
  const wantCodex = only === "all" || only === "codex";

  if (wantFileAgents) {
    const mcpPath = join(cwd, ".mcp.json");
    const existing = readJsonFile(mcpPath);
    const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
    servers.lorex = lorexMcpCommand("claude-code");
    existing.mcpServers = servers;
    writeFileSync(mcpPath, JSON.stringify(existing, null) + "\n");
    done.push(`MCP: ${mcpPath} (Claude Code)`);
  }

  if (!only || only === "all" || only === "cursor") {
    const cursorPath = join(cwd, ".cursor", "mcp.json");
    mkdirSync(join(cwd, ".cursor"), { recursive: true });
    const existing = readJsonFile(cursorPath);
    const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
    servers.lorex = lorexMcpCommand("cursor");
    existing.mcpServers = servers;
    writeFileSync(cursorPath, JSON.stringify(existing, null, 2) + "\n");
    done.push(`MCP: ${cursorPath} (Cursor)`);
  }

  if (wantCodex) {
    const codexPath = join(agentHome(), ".codex", "config.toml");
    mkdirSync(join(agentHome(), ".codex"), { recursive: true });
    const current = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : "";
    const entry = lorexMcpCommand("codex");
    const block = `[mcp_servers.lorex]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`;
    const updated = upsertTomlSection(current, "mcp_servers.lorex", block);
    if (updated !== current) writeFileSync(codexPath, updated);
    done.push(`MCP: ${codexPath} (Codex${updated === current ? ", already current" : ""})`);
  }

  println(`Lorex wired for workspace "${workspace}".`);
  for (const d of done) println(`  [ok] ${d}`);
  println("  Restart your agent — memory tools appear automatically, no flags needed.");
}

/** Install agent lifecycle hooks so memory loads without being asked. */
async function cmdHooks(args: string[]): Promise<void> {
  const sub = args[0] ?? "install";
  const at = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (sub === "status") {
    const { hooksStatus } = await import("./agent-hooks.js");
    for (const s of hooksStatus(projectRoot())) {
      println(`  ${s.configured ? "[ok]" : "[--]"} ${s.agent}: ${s.detail}`);
    }
    return;
  }

  if (sub === "uninstall") {
    const { uninstallHooks, isAgentSupported: supported } = await import("./agent-hooks.js");
    const only = at("--agent");
    const agents = only ? [only] : ["claude-code", "codex", "opencode", "grok", "pi", "omp", "aider", "cline", "cursor", "windsurf", "gemini"];
    for (const agent of agents) {
      if (!supported(agent)) {
        println(`Unknown agent: "${agent}". Supported: claude-code, codex, opencode, grok, pi, omp, aider, cline, cursor, windsurf, gemini`);
        process.exitCode = 1;
        return;
      }
      const { path, removed } = uninstallHooks(agent, projectRoot());
      println(removed ? `  [ok] ${agent}: removed from ${path}` : `  [--] ${agent}: nothing to remove (${path})`);
    }
    println("Note: MCP wiring (.mcp.json) is separate — delete the lorex block to fully detach.");
    return;
  }

  if (sub !== "install") {
    println('Usage: lorex hooks [install|status|uninstall] [--agent claude-code|cursor|windsurf|codex|opencode|grok|gemini|cline|aider]');
    return;
  }
  const agent = at("--agent") ?? "claude-code";

  if (!isAgentSupported(agent)) {
    println(`Unknown agent: "${agent}". Supported: claude-code, cursor, windsurf, codex, opencode, grok, gemini, cline, aider`);
    process.exitCode = 1;
    return;
  }

  ensureDurableLorexCommand();
  const { path, description } = installHooks(agent, projectRoot());
  println(`Hooks installed: ${path}`);
  for (const line of description.split("\n")) println(`  ${line}`);
}

async function cmdInit(argv: string[] = []): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const nonInteractive = argv.includes("--yes") || argv.includes("-y") || !process.stdin.isTTY;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    println(BANNER);
    println("  Lorex — local-first memory for coding agents.");
    println(`  Memory home: ${lorexHome()}`);
    println();

    const root = projectRoot();
    const suggestion = defaultWorkspace(root);
    const workspace =
      flag("--workspace")?.trim() ||
      (nonInteractive ? suggestion : (await prompt(rl, `  Workspace [${suggestion}]: `)) || suggestion);

    const defaultDir = storeDbPath();
    const dataDir =
      flag("--data-dir")?.trim() ||
      (nonInteractive ? "" : await prompt(rl, `  Data dir [${defaultDir}]: `));
    if (dataDir) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(dataDir, { recursive: true });
    }

    saveProjectWorkspace(workspace, root);
    if (dataDir) saveConfig({ dataDir });
    println();
    println(`  Workspace saved to ${projectConfigFile(root)}; data location in ${configFile()}.`);
    println(`  Memory lives at: ${storeDbPath(dataDir || undefined)}`);

    println();
    println("  Verifying…");
    const verifyClient = new SqliteStore({ path: storeDbPath(dataDir || undefined) });
    const verifyIdentity = resolveIdentity(process.cwd(), { workspace });
    const verifyEngine = new LorexEngine(verifyClient, verifyIdentity);
    await verifyEngine.ensureReady();
    const probe = await verifyEngine.recall({ query: "smoke", maxResults: 1 });
    void probe;
    println(`  [ok] Local store ready. No network needed.`);

    println();
    println("  Connect your agents — Lorex runs as an MCP server:");
    for (const target of AGENT_SETUP) {
      println();
      println(`  ${target.name} — ${target.file}`);
      for (const line of target.snippet(workspace).split("\n")) println(`    ${line}`);
    }

    println();
    println("  Try it now:");
    println('    lorex add "Session storage moved to Redis because Atlas timed out"');
    println('    lorex ask "what do we use for sessions?"');
    println("    lorex resume                     what the last agent left you");
    println();
  } finally {
    rl.close();
  }
}

function identityFrom(args: string[], config: Config) {
  const at = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  // Flag > env (handled inside resolveIdentity) > stored config workspace.
  const workspace = at("--workspace") ?? process.env.LOREX_WORKSPACE ?? config.workspace;
  return resolveIdentity(process.cwd(), {
    database: config.databaseOverride,
    collection: config.collectionOverride,
    workspace,
    agent: at("--agent"),
  });
}

function resolveLocalStorePath(config?: Config): string {
  return storeDbPath(config?.dataDir);
}

function buildClient(useMock: boolean, config: Config): HydraDBLike {
  // SQLite is the store. --mock falls back to the in-memory JSON backend.
  if (useMock && !process.argv.includes("--sqlite")) {
    return new MockHydraDB({ persistPath: join(lorexHome(), "mock-store.json") });
  }
  const store = new SqliteStore({ path: resolveLocalStorePath(config) });
  store.autoEmbedder();
  return store;
}

/** Hook commands receive the exact session identity and event on stdin. */
async function cmdHarness(args: string[]): Promise<void> {
  const { runHarnessEvent } = await import("./harness.js");
  type HookInput = import("./harness.js").HookInput;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > 1_000_000) throw new Error("hook input exceeds 1 MB");
    chunks.push(bytes);
  }
  let input: HookInput;
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookInput; }
  catch { process.stderr.write("lorex harness: invalid hook JSON\n"); return; }
  const agentIndex = args.indexOf("--agent");
  const agent = agentIndex >= 0 ? args[agentIndex + 1] ?? "unknown" : "unknown";
  if (!input || typeof input !== "object") return;
  if (agent === "grok") {
    const grok = input as HookInput & { hookEventName?: string; sessionId?: string; workspaceRoot?: string; lastAssistantMessage?: string; assistantMessage?: string };
    input.hook_event_name ??= grok.hookEventName;
    input.session_id ??= grok.sessionId;
    input.cwd ??= grok.workspaceRoot;
    input.last_assistant_message ??= grok.lastAssistantMessage;
    input.assistant_message ??= grok.assistantMessage;
  }
  if (!input.hook_event_name) return;
  if (agent === "cursor") {
    input.session_id ??= input.conversation_id;
    input.turn_id ??= input.generation_id;
    input.cwd ??= input.workspace_roots?.[0];
  }
  if (!input.session_id) return;
  if (input.cwd && existsSync(input.cwd)) process.chdir(input.cwd);
  const config = loadConfig();
  const engine = new LorexEngine(new SqliteStore({ path: resolveLocalStorePath(config) }), identityFrom(["--agent", agent], config));
  try {
    const output = await runHarnessEvent(engine, input, agent);
    if (output) println(output);
  } catch (e) {
    process.stderr.write(`lorex harness (${agent} ${input.hook_event_name}): ${(e as Error).message}. The event was not committed; retry the hook or run lorex doctor.\n`);
    if (agent === "cursor" || input.hook_event_name === "Stop" || input.hook_event_name === "PreCompact") println("{}");
  }
}

async function cmdStart(args: string[]): Promise<void> {
  const useMock = args.includes("--mock");
  await applyLocalModels();
  const config = useMock ? mockConfig() : loadConfig();
  const identity = identityFrom(args, config);
  if (identity.warning) {
    process.stderr.write(`lorex: ${identity.warning}\n`);
  }
  const client = buildClient(useMock, config);
  const engine = new LorexEngine(client, identity);
  await runStdioServer(engine);
}

async function cmdUsage(args: string[]): Promise<void> {
  const useMock = args.includes("--mock");
  const config = useMock ? mockConfig() : loadConfig();
  const identity = identityFrom(args, config);
  const client = buildClient(useMock, config);
  const engine = new LorexEngine(client, identity);
  const u = engine.usage;
  println("Lorex usage (this project)\n==========================");
  println(`Writes:      ${u.writesThisHour}/${u.limits.writesPerHour} this hour · ${u.writesToday}/${u.limits.writesPerDay} today`);
  println(`Queries:     ${u.queriesThisHour}/${u.limits.queriesPerHour} this hour`);
  println(`Ingested:    ${u.ingestTokensToday}/${u.limits.ingestTokensPerDay} tokens today`);
  println("\nAdjust via LOREX_MAX_WRITES_PER_HOUR, LOREX_MAX_WRITES_PER_DAY,");
  println("LOREX_MAX_QUERIES_PER_HOUR, LOREX_MAX_INGEST_TOKENS_PER_DAY env vars.");
}

async function cmdDoctor(args: string[]): Promise<void> {
  const useMock = args.includes("--mock");
  println("Lorex doctor\n=============\n");
  const config = useMock ? mockConfig() : loadConfig();
  println(`[ok] mode — local (no network)`);
  println(`     store: ${resolveLocalStorePath(config)}`);

  const identity = identityFrom(args, config);
  println(`[ok] identity — database=${identity.databaseLabel} collection=${identity.collectionLabel}`);
  println(`     (ids: ${identity.database} / ${identity.collection})`);
  println(
    `     agent=${identity.agent}` +
      (identity.workspace ? ` · workspace=${identity.workspace}` : "") +
      ` · resolved from ${identity.provenance.database}/${identity.provenance.collection}`,
  );
  if (identity.warning) println(`[warn] identity — ${identity.warning}`);

  const client = buildClient(useMock, config);
  println("[ok] client — initialized");

  println("\nSmoke test:");
  const engine = new LorexEngine(client, identity);
  await engine.ensureReady();

  const r1 = await engine.remember("Lorex local memory is working", {
    validFrom: new Date().toISOString(),
    id: "lorex_smoke",
  });
  println(`  remember: ${r1.summary}`);

  const r2 = await engine.recall({ query: "is local memory working" });

  if (r2.sources.length > 0) {
    println(`  recall:   ${r2.summary}`);
  } else {
    println("  recall:   no results yet — retry `lorex doctor` in a few seconds.");
  }

  const r3 = await engine.history({ factId: "lorex_smoke" });
  println(`  history:  ${r3.summary}`);

  println(`\n[ok] smoke complete.`);

  println("\nMemory health:");
  const store = client as Partial<{
    getLifecycleStats(c: string): { total: number; byType: Record<string, number>; avgStrength: number; staleCount: number };
    getOpenLoops(c: string): Array<{ text: string; age_days: number }>;
    getQueryFailures(n?: number): Array<{ pattern: string; fails: number }>;
  }>;
  if (typeof store.getLifecycleStats === "function") {
    const stats = store.getLifecycleStats(identity.collection);
    const parts = Object.entries(stats.byType).map(([t, n]) => `${n} ${t}`).join(", ");
    println(`  facts: ${stats.total}${parts ? ` (${parts})` : ""} · avg strength ${stats.avgStrength.toFixed(2)} · ${stats.staleCount} stale`);
    const loops = typeof store.getOpenLoops === "function" ? store.getOpenLoops(identity.collection) : [];
    println(`  open loops: ${loops.length}`);
    const gaps = typeof store.getQueryFailures === "function" ? store.getQueryFailures(3) : [];
    for (const g of gaps) println(`  recall gap: "${g.pattern}" failed ${g.fails}x`);
  }
  const dream = await engine.dreamStatus();
  println(
    `  dream: ${dream.lastDreamAt ? `last ran ${dream.lastDreamAt.slice(0, 10)}` : "never run"}` +
      ` · ${dream.sessionsSince} new session(s) · ${dream.shouldRun ? "due" : dream.reason}`,
  );
  println(`  quality: run \`lorex reflect\` for duplicates, staleness and contradictions`);
  const models = await applyLocalModels();
  println(`\nModels: ${modelSummary(models)}`);
}

async function cmdOneShot(op: string, args: string[]): Promise<void> {
  const useMock = args.includes("--mock");
  const config = useMock ? mockConfig() : loadConfig();
  const identity = identityFrom(args, config);

  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  // Simple positional: `lorex add "text"` / `lorex ask "question"` — join
  // non-flag args so quoting is optional. Only value-flags consume the next arg,
  // so this list MUST name every flag that takes a value: a missing entry makes
  // its value fall through into the positional text and reach the wrong op.
  const VALUE_FLAGS = new Set([
    "--fact", "--query", "--id", "--because", "--validFrom", "--validTo",
    "--sourceRef", "--ttl", "--scope", "--relation", "--workspace", "--agent",
    "--file", "--in", "--out", "--transcript", "--sessionId", "--startedAt",
    "--next", "--decision", "--requestId", "--answer", "--rating", "--feedback",
    "--sourceIds", "--maxResults", "--maxTokens", "--mode", "--type", "--asOf",
    "--data-dir", "--kind", "--collection",
    "--content", "--url", "--factId", "--publish-dir",
  ]);
  const firstPositional = (() => {
    const parts: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a.startsWith("--")) {
        if (VALUE_FLAGS.has(a)) i++;
        continue;
      }
      parts.push(a);
    }
    const joined = parts.join(" ").trim();
    return joined || undefined;
  })();

  // Resident-daemon fast paths (the hot hook verbs): same store, warm process.
  // Falls back to the in-process engine below when the daemon is unreachable,
  // so behavior never depends on it.
  if (!useMock && (await runViaDaemon(op, args, firstPositional))) return;

  const client = buildClient(useMock, config);
  const engine = new LorexEngine(client, identity);

  let receipt;
  switch (op) {
    case "add":
    case "remember": {
      const fact = flag("--fact") ?? firstPositional;
      if (!fact) return println(JSON.stringify({ error: '--fact is required. Usage: lorex add "fact because reason" [--id id] [--because reason]' }));
      receipt = await engine.remember(fact, {
        validFrom: flag("--validFrom"),
        id: flag("--id"),
        sourceRef: flag("--sourceRef"),
        ttlSeconds: flag("--ttl") ? Number(flag("--ttl")) : undefined,
        because: flag("--because"),
        scope: flag("--scope") === "global" ? "global" : undefined,
        relation: flag("--relation") === "extends" ? "extends" : flag("--relation") === "supersedes" ? "supersedes" : undefined,
      });
      break;
    }
    case "ask":
    case "recall": {
      const query = flag("--query") ?? firstPositional;
      receipt = await engine.recall({
        query,
        asOf: flag("--asOf"),
        mode: flag("--mode") === "thinking" ? "thinking" : flag("--mode") === "fast" ? "fast" : undefined,
        type: flag("--type") as "memory" | "knowledge" | "all" | undefined,
        maxResults: flag("--maxResults") ? Number(flag("--maxResults")) : undefined,
        abstainOnAmbiguity: args.includes("--abstainOnAmbiguity") || undefined,
        synthesize: args.includes("--synthesize") || undefined,
      });
      break;
    }
    case "learn": {
      const content = flag("--content");
      const file = flag("--file");
      const url = flag("--url");
      if (file ?? url) {
        const result = await engine.ingestDocument({ path: file, url });
        println(JSON.stringify({
          op: "ingest-document",
          ...result,
          summary: `Ingested document: ${result.chunkCount} chunks, ${result.factCount} facts`,
        }, null));
        return;
      }
      if (!content) return println(JSON.stringify({ error: "--content, --file, or --url required" }));
      receipt = await engine.learn(content, flag("--sourceRef"));
      break;
    }
    case "history": {
      receipt = await engine.history({
        factId: flag("--factId"),
        query: flag("--query"),
      });
      break;
    }
    case "list": {
      receipt = await engine.list({
        type: flag("--type") as "memory" | "knowledge" | "all" | undefined,
      });
      break;
    }
    case "resume": {
      receipt = await engine.resume();
      // Plain text for hooks (SessionStart stdout goes straight to context).
      if (args.includes("--plain")) {
        const r = receipt as { summary?: string; sources?: Array<{ excerpt?: string; agent?: string }> };
        println(r.summary ?? "No memory yet.");
        const handoffs = (r.sources ?? []).filter((s) => s.excerpt).slice(0, 5);
        for (const h of handoffs) println(`- ${h.excerpt}${h.agent ? ` (${h.agent})` : ""}`);
        return;
      }
      break;
    }
    case "graph": {
      const maxResults = flag("--maxResults") ? Number(flag("--maxResults")) : undefined;

      const { renderGraphHtml } = await import("./graph-render.js");
      const { writeFileSync, mkdirSync, existsSync, readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const publish = args.includes("--publish");
      const out = flag("--out") ?? "lorex-graph.html";
      const { graph } = await engine.graph({ query: flag("--query"), maxResults });
      writeFileSync(out, renderGraphHtml(graph, {
        workspace: identity.workspace,
        database: identity.database,
        collection: identity.collection,
        query: flag("--query"),
        redacted: publish,
      }));
      if (!publish) {
        println(JSON.stringify({
          op: "graph",
          out,
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          stats: graph.stats,
          summary: `Wrote ${out} - ${graph.nodes.length} nodes, ${graph.edges.length} edges, ` +
            `${graph.stats.explainedChanges}/${graph.stats.totalChanges} changes with a recorded reason.`,
        }, null));
        return;
      }

      // --publish: register the snapshot in the local gallery. The HTML is
      // fully self-contained (data baked in, no keys, no backend) — copy the
      // directory to any static host and it just works.
      const pubDir = flag("--publish-dir") ?? join(lorexHome(), "published");
      mkdirSync(pubDir, { recursive: true });
      const slug = `${identity.collection}-${Date.now().toString(36)}.html`;
      const snapPath = join(pubDir, slug);
      writeFileSync(snapPath, readFileSync(out, "utf8"));
      const indexPath = join(pubDir, "index.json");
      const entries = existsSync(indexPath)
        ? JSON.parse(readFileSync(indexPath, "utf8") as string) as Array<Record<string, unknown>>
        : [];
      const entry = {
        file: slug,
        title: flag("--query") ?? identity.collectionLabel,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        publishedAt: new Date().toISOString(),
      };
      entries.unshift(entry);
      writeFileSync(indexPath, JSON.stringify(entries.slice(0, 100), null, 2));
      const galleryHtml =
        `<!doctype html><meta charset="utf-8"><title>Lorex graph gallery</title>` +
        `<body style="font-family:system-ui;max-width:640px;margin:3rem auto">` +
        `<h1>Published context graphs</h1><ul>` +
        entries.map((e) =>
          `<li><a href="${String(e.file)}">${String(e.title)}</a> — ${e.nodes} nodes, ${e.edges} edges (${String(e.publishedAt).slice(0, 10)})</li>`,
        ).join("") +
        `</ul></body>`;
      writeFileSync(join(pubDir, "index.html"), galleryHtml);
      println(JSON.stringify({
        op: "graph-publish",
        out: snapPath,
        gallery: join(pubDir, "index.html"),
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        summary: `Published snapshot with data baked in (read-only, no credentials). ` +
          `Copy ${pubDir} to your static host (e.g. \`npx wrangler pages deploy ${pubDir}\` or \`gh-pages\`).`,
      }, null));
      return;
    }
    case "why": {
      receipt = await engine.why({
        factId: flag("--factId"),
        query: flag("--query"),
      });
      break;
    }
    case "context": {
      const query = flag("--query") ?? firstPositional;
      receipt = await engine.contextPack({
        query,
        maxTokens: flag("--maxTokens") ? Number(flag("--maxTokens")) : undefined,
        maxResults: flag("--maxResults") ? Number(flag("--maxResults")) : undefined,
        mode: flag("--mode") === "fast" ? "fast" : flag("--mode") === "thinking" ? "thinking" : undefined,
        type: flag("--type") as "memory" | "knowledge" | "all" | undefined,
      });
      // The plain pack goes straight into a SessionStart hook's context.
      if (args.includes("--plain")) {
        println(receipt.context ?? receipt.summary);
        return;
      }
      break;
    }
    case "handoff": {
      const decision = flag("--decision");
      if (!decision) return println(JSON.stringify({ error: "--decision required" }));
      receipt = await engine.handoff({
        decision,
        nextStep: flag("--next"),
        sessionId: flag("--sessionId"),
      });
      break;
    }
    case "dream": {
      // --auto honours the gates (enough new sessions, ≥24h since the last run),
      // which is what the session-end hook calls: a no-op most of the time.
      let r: Awaited<ReturnType<LorexEngine["dream"]>>;
      if (args.includes("--auto")) {
        const auto = await engine.dreamAuto();
        if (!auto.ran) {
          println(JSON.stringify({ op: "dream", ran: false, reason: auto.reason }, null));
          return;
        }
        r = auto.result;
      } else {
        r = await engine.dream();
      }
      println(JSON.stringify({
        op: "dream",
        ran: true,
        discovered: r.discovered.length,
        persisted: r.persisted,
        queued: r.queued,
        reinforced: r.reinforced.length,
        contradictions: r.contradictions.length,
        consolidationCandidates: r.consolidationCandidates,
        durationMs: r.durationMs,
        summary: `Dream found ${r.discovered.length} patterns, persisted ${r.persisted}, queued ${r.queued} for review, ` +
          `reinforced ${r.reinforced.length}, flagged ${r.contradictions.length} contradictions.`,
        result: r,
      }, null));
      return;
    }
    case "reflect": {
      const report = await engine.reflect();
      println(JSON.stringify({
        op: "reflect",
        ...report,
        summary: !report.available
          ? "Memory-quality metrics need the local SQLite backend (running with --mock)."
          : report.healthy
            ? `Memory looks clean (${report.total} memories).`
            : `${report.findings.length} finding(s) across ${report.total} memories.`,
      }, null));
      return;
    }
    case "consolidate": {
      const r = await engine.consolidate(args.includes("--prune"));
      println(JSON.stringify({
        op: "consolidate",
        ...r,
        summary: `Consolidation: ${r.expired} expired applied` +
          (args.includes("--prune") ? `, ${r.pruned} pruned, ${r.merged} merged` : `, ${r.planned - r.expired} more pending (pass --prune to apply)`),
      }, null));
      return;
    }
    case "open-loops": {
      const loops = await engine.openLoops();
      if (!loops.length) {
        println("No open loops — nothing unfinished.");
        return;
      }
      for (const l of loops) println(`- [${l.age_days}d] ${l.text} (${l.id})`);
      return;
    }
    case "profile": {
      const kind = flag("--kind") === "user" ? "user" : "project";
      const p = await engine.profile(kind, args.includes("--refresh"));
      if (!p) return println(JSON.stringify({ error: "profiles require the local SQLite backend" }));
      if (args.includes("--plain")) {
        const lines = [`Profile (${p.kind}, ${p.cached ? "cached" : "fresh"}):`];
        for (const pref of p.preferences.slice(0, 5)) lines.push(`- prefers: ${pref.text}`);
        for (const d of p.decisions.slice(0, 5)) lines.push(`- decided: ${d.text}`);
        for (const c of p.constraints.slice(0, 5)) lines.push(`- constraint: ${c}`);
        for (const l of p.openLoops.slice(0, 5)) lines.push(`- open: ${l.text}`);
        if (p.lastHandoff) lines.push(`- handoff: ${p.lastHandoff.decision}`);
        println(lines.join("\n"));
        return;
      }
      println(JSON.stringify({ op: "profile", ...p }, null));
      return;
    }
    case "export": {
      const rows = await engine.exportData(flag("--collection"));
      if (!rows) {
        return println(JSON.stringify({ error: "export requires the local SQLite backend" }));
      }
      const lines = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
      const out = flag("--out");
      if (out) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(out, lines);
        println(JSON.stringify({ op: "export", rows: rows.length, out }));
      } else {
        process.stdout.write(lines);
      }
      return;
    }
    case "import": {
      const file = flag("--file") ?? flag("--in");
      if (!file) return println(JSON.stringify({ error: "--file required" }));
      const { readFileSync } = await import("node:fs");
      const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
      const r = await engine.importData(rows, args.includes("--force"));
      if (!r) {
        return println(JSON.stringify({ error: "import requires the local SQLite backend" }));
      }
      println(JSON.stringify({ op: "import", ...r, summary: `Imported ${r.imported}, skipped ${r.skipped} existing.` }));
      return;
    }
    case "forget": {
      receipt = await engine.forget({
        factId: flag("--factId"),
        query: flag("--query"),
      });
      break;
    }
    case "report": {
      const requestId = flag("--requestId");
      if (!requestId) return println(JSON.stringify({ error: "--requestId required" }));
      receipt = await engine.report({
        requestId,
        answer: flag("--answer"),
        rating: flag("--rating") as "positive" | "negative" | "neutral" | undefined,
        feedback: flag("--feedback"),
        query: flag("--query"),
        sourceIds: flag("--sourceIds")?.split(",").map((s) => s.trim()).filter(Boolean),
      });
      break;
    }
    case "capture": {
      const { captureTranscript } = await import("../ingestion/session-capture.js");
      const transcriptPath = flag("--transcript") ?? flag("--file") ?? process.env.LOREX_TRANSCRIPT_PATH;

      if (transcriptPath) {
        // Explicit transcript path
        receipt = await captureTranscript(engine, {
          transcriptPath,
          sessionId: flag("--sessionId"),
          agent: flag("--agent"),
          startedAt: flag("--startedAt"),
        });
        receipt = {
          op: "capture",
          sources: [],
          mode_used: "fast",
          token_cost: receipt.tokenCount,
          abstained: receipt.errors.length > 0,
          summary: receipt.errors.length
            ? `Capture failed for ${receipt.sessionId}: ${receipt.errors.join("; ")}`
            : `Captured session ${receipt.sessionId}: ${receipt.chunkCount} chunks, ${receipt.factCount} facts`,
          result: receipt,
        };
      } else {
        receipt = {
          op: "capture", sources: [], mode_used: "fast", token_cost: 0, abstained: true,
          summary: "Specify --transcript <path>. Hooks provide their exact transcript automatically; Lorex no longer guesses the newest session.",
        };
      }
      break;
    }
    default:
      return println(JSON.stringify({ error: `Unknown command: ${op}` }));
  }

  if (args.includes("--json")) {
    println(JSON.stringify(receipt, null));
    return;
  }
  println(renderReceipt(receipt as {
    summary?: string;
    answer?: string;
    abstained?: boolean;
    sources?: Array<{ excerpt?: string; content?: string; score?: number }>;
  }, op));
}

function renderReceipt(receipt: {
  summary?: string;
  answer?: string;
  abstained?: boolean;
  sources?: Array<{ excerpt?: string; content?: string; score?: number }>;
}, op: string): string {
  const lines: string[] = [];
  if (receipt.abstained) {
    lines.push(receipt.summary ?? "No supporting evidence found.");
  } else if (receipt.answer && (op === "ask" || op === "recall" || op === "context")) {
    lines.push(receipt.answer);
  } else {
    lines.push(receipt.summary ?? "Done.");
  }
  const sources = receipt.sources ?? [];
  if (sources.length && !receipt.abstained && op !== "context") {
    lines.push("");
    lines.push(`Sources (${sources.length}):`);
    for (const s of sources.slice(0, 5)) {
      const text = (s.excerpt ?? s.content ?? "").split("\n")[0]?.slice(0, 120) ?? "";
      lines.push(`- ${text}${typeof s.score === "number" ? ` (${s.score.toFixed(2)})` : ""}`);
    }
    if (sources.length > 5) lines.push(`…and ${sources.length - 5} more (use --json for full output)`);
  }
  return lines.join("\n");
}

function mockConfig(): Config {
  return {
    databaseOverride: undefined,
    collectionOverride: undefined,
  };
}

const closedReadlines = new WeakSet<object>();

function prompt(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  if (closedReadlines.has(rl)) return Promise.resolve("");

  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      rl.off("close", onClose);
      resolve(value);
    };
    const onClose = () => {
      closedReadlines.add(rl);
      done("");
    };
    rl.once("close", onClose);
    try {
      rl.question(q, (answer) => done(answer.trim()));
    } catch {
      onClose();
    }
  });
}

// ── Resident daemon: fast paths, autostart, and control ─────────────────────

async function daemonHealthy(port: number, timeoutMs = 400): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(port: number, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await daemonHealthy(port, 300)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/** Start the daemon if it is not up. Returns its port, or null when it cannot start. */
async function ensureDaemon(waitMs = 2500): Promise<number | null> {
  const live = liveDaemon();
  if (live && ((await daemonHealthy(live.port, 400)) || (await waitForHealth(live.port, waitMs)))) {
    return live.port;
  }
  const entry = fileURLToPath(new URL("../index.js", import.meta.url));
  if (!existsSync(entry)) return null; // running under tsx — no built entry to spawn
  const port = loadConfig().daemonPort ?? 3777;
  try {
    const child = spawn(process.execPath, [entry, "daemon", "run"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch {
    return null;
  }
  return (await waitForHealth(port, waitMs)) ? port : null;
}

async function daemonFetch(
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; text: string } | null> {
  const live = liveDaemon();
  if (!live) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${live.port}${path}`, {
      method: init.method ?? "GET",
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 1500),
    });
    return { status: res.status, text: await res.text() };
  } catch {
    return null;
  }
}

/**
 * Daemon fast paths for the hot hook verbs. Used only for the output modes the
 * daemon reproduces exactly (plain packs, queued jobs); everything else stays
 * in-process so CLI output never changes shape.
 */
async function runViaDaemon(op: string, args: string[], firstPositional: string | undefined): Promise<boolean> {
  const cwd = process.cwd();
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  if (op === "context" && args.includes("--plain")) {
    const params = new URLSearchParams({ cwd });
    const query = flag("--query") ?? firstPositional;
    if (query) params.set("q", query);
    const maxTokens = flag("--maxTokens");
    if (maxTokens) params.set("maxTokens", maxTokens);
    const res = await daemonFetch(`/v1/context/plain?${params}`);
    if (!res || res.status !== 200) return false;
    println(res.text);
    return true;
  }

  if (op === "resume" && args.includes("--plain")) {
    const res = await daemonFetch(`/resume?${new URLSearchParams({ cwd })}`);
    if (!res || res.status !== 200) return false;
    const parsed = JSON.parse(res.text) as { summary?: string; sources?: Array<{ excerpt?: string; agent?: string }> };
    println(parsed.summary ?? "No memory yet.");
    for (const h of (parsed.sources ?? []).filter((s) => s.excerpt).slice(0, 5)) {
      println(`- ${h.excerpt}${h.agent ? ` (${h.agent})` : ""}`);
    }
    return true;
  }

  if (op === "capture" && args.includes("--auto")) {
    const res = await daemonFetch("/v1/hooks/pre-compact", { method: "POST", body: { cwd } });
    if (!res || res.status !== 200) return false;
    println(JSON.stringify({ op: "capture", queued: true, summary: "Session queued for capture by the resident daemon." }, null));
    return true;
  }

  if (op === "dream" && args.includes("--auto")) {
    const res = await daemonFetch("/v1/hooks/dream", { method: "POST", body: { cwd } });
    if (!res || res.status !== 200) return false;
    println(JSON.stringify({ op: "dream", queued: true, summary: "Dream queued by the resident daemon." }, null));
    return true;
  }

  return false;
}

async function cmdDaemon(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  const live = liveDaemon();

  if (sub === "status") {
    if (!live) return println("Lorex daemon: not running.");
    const healthy = await daemonHealthy(live.port);
    return println(
      `Lorex daemon: running (pid ${live.pid}, port ${live.port})${healthy ? "" : " — not answering yet"}.`,
    );
  }

  if (sub === "stop") {
    if (!live) return println("Lorex daemon: not running.");
    try {
      process.kill(live.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && (await daemonHealthy(live.port, 250))) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    if (await daemonHealthy(live.port, 250)) return println(`Lorex daemon: still stopping (pid ${live.pid}).`);
    return println(`Lorex daemon stopped (pid ${live.pid}).`);
  }

  if (sub === "start") {
    const port = await ensureDaemon(3000);
    if (port === null) {
      println("Could not start the daemon (no built entry, or startup failed).");
      println("Dev: run `npm run build` first, then retry — or run `lorex daemon run` in a second terminal.");
      process.exitCode = 1;
      return;
    }
    println(`Lorex daemon running at http://127.0.0.1:${port}`);
    println(`Console: http://127.0.0.1:${port}/`);
    return;
  }

  if (sub === "run") {
    const { startDaemonService } = await import("../daemon/server.js");
    const portArg = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : undefined;
    const handle = await startDaemonService({ cwd: process.cwd(), port: portArg });
    println(`Lorex daemon listening at ${handle.url} (pid ${process.pid})`);
    println(`Console: ${handle.url}/`);
    const shutdown = (): void => {
      void handle.stop().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise<void>(() => undefined); // foreground until signalled
    return;
  }

  println("Usage: lorex daemon [start|stop|status|run]");
  process.exitCode = 1;
}

async function cmdConsole(): Promise<void> {
  const port = await ensureDaemon(3000);
  if (port === null) {
    println("Could not start the daemon (no built entry, or startup failed).");
    println("Dev: run `npm run build` first, then retry — or run `lorex daemon run` in a second terminal.");
    process.exitCode = 1;
    return;
  }
  const url = `http://127.0.0.1:${port}/`;
  println(`Lorex console: ${url}`);
  println("The daemon keeps running in the background; `lorex daemon stop` stops it.");
  if (process.env.LOREX_NO_BROWSER === "1") return;
  try {
    const [opener, openerArgs] = process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
    spawn(opener as string, openerArgs as string[], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the printed URL is enough */
  }
}

async function cmdAdmin(args: string[]): Promise<void> {
  if (!args.length) {
    println("lorex admin <command> — the full command surface.");
    println("Public verbs: lorex (console) · remember · ask · context · doctor · daemon.");
    println("Run `lorex help --json` for the machine-readable registry.");
    return;
  }
  await runCli(args);
}

export interface CliCommandInfo {
  name: string;
  summary: string;
  usage: string;
  aliases?: string[];
}

/**
 * The machine-readable command surface (`lorex help --json`), so an agent can
 * discover what this CLI does without being told. A test reads the dispatch
 * table in this file and fails if a command is missing here, so the two cannot
 * drift apart.
 */
export const CLI_COMMANDS: CliCommandInfo[] = [
  { name: "console", summary: "Open the optional local browser interface", usage: "lorex console" },
  { name: "daemon", summary: "Run, stop, or inspect the resident Lorex service", usage: "lorex daemon [start|stop|status|run]" },
  { name: "admin", summary: "Run any command from the full surface", usage: "lorex admin <command> [args…]" },
  { name: "setup", summary: "Wire agents, install hooks, and smoke-test in one command", usage: "lorex setup [--workspace name] [--data-dir dir] [--yes]" },
  { name: "status", summary: "What is stored, what is pending, which agents are wired", usage: "lorex status [--mock]" },
  { name: "init", summary: "Interactive first-run setup", usage: "lorex init [--workspace name] [--data-dir dir] [--yes]" },
  { name: "wire", summary: "Connect this project to agents (writes MCP config)", usage: "lorex wire [--agent name] [--workspace name]" },
  { name: "hooks", summary: "Install, inspect, or remove agent lifecycle hooks", usage: "lorex hooks [install|status|uninstall] [--agent name]" },
  { name: "start", summary: "Run the MCP server over stdio", usage: "lorex start [--mock]" },
  { name: "doctor", summary: "Verify setup, memory health, and model status", usage: "lorex doctor [--mock]" },
  { name: "usage", summary: "Show rate-limit consumption", usage: "lorex usage" },
  { name: "add", summary: "Store a fact, with an optional reason", usage: 'lorex add "fact because reason" [--id id] [--scope global]', aliases: ["remember"] },
  { name: "ask", summary: "Retrieve context and answer from it, or abstain", usage: 'lorex ask "question?" [--asOf ISO] [--mode thinking]', aliases: ["recall"] },
  { name: "learn", summary: "Store grounding content verbatim, or ingest a file/URL", usage: "lorex learn --content ... | --file path | --url URL" },
  { name: "history", summary: "Version timeline for a fact, including superseded values", usage: "lorex history [--factId id] [--query text]" },
  { name: "list", summary: "Snapshot of recent memories", usage: "lorex list [--type memory|knowledge|all]" },
  { name: "resume", summary: "Session-start pack with cross-agent attribution", usage: "lorex resume [--plain]" },
  { name: "context", summary: "Typed, budgeted context pack for injection", usage: 'lorex context ["question?"] [--plain] [--maxTokens n]' },
  { name: "task", summary: "Share one task brief and append-only progress across agents", usage: 'lorex task create ID --brief "..." | note --text "..." | show [ID] | leave' },
  { name: "reflect", summary: "Memory quality: duplicates, staleness, contradictions, gaps", usage: "lorex reflect [--json]" },
  { name: "report", summary: "Send retrieval feedback that adjusts future ranking", usage: "lorex report --requestId id [--rating positive|negative|neutral] [--query text]" },
  { name: "capture", summary: "Ingest an exact agent transcript", usage: "lorex capture --transcript path" },
  { name: "harness", summary: "Agent lifecycle hook bridge (reads event JSON on stdin)", usage: "lorex harness --agent claude-code|codex" },
  { name: "forget", summary: "Soft-delete a fact topic; history is retained", usage: "lorex forget [--factId id] [--query text]" },
  { name: "graph", summary: "Render a static context graph", usage: "lorex graph [--query text] [--out file.html] [--publish]" },
  { name: "why", summary: "Explain why a fact changed, from the recorded reasons", usage: "lorex why [--factId id] [--query text]" },
  { name: "handoff", summary: "Record a decision and the next step for the next agent", usage: 'lorex handoff --decision "..." [--next "..."]' },
  { name: "dream", summary: "Mine sessions for patterns; --auto respects the gates", usage: "lorex dream [--auto]" },
  { name: "consolidate", summary: "Apply expired TTLs; --prune also merges and prunes", usage: "lorex consolidate [--prune]" },
  { name: "open-loops", summary: "Tasks recorded but never acted on", usage: "lorex open-loops" },
  { name: "profile", summary: "Standing user/project state, no query needed", usage: "lorex profile [--kind user|project] [--refresh] [--plain]" },
  { name: "export", summary: "Dump memories as JSONL for backup or sync", usage: "lorex export [--collection c] [--out file]" },
  { name: "import", summary: "Merge a JSONL dump; local rows win unless --force", usage: "lorex import --file path [--force]" },
  { name: "help", summary: "Show help; --json prints this command surface", usage: "lorex help [--json]" },
];

export async function runCli(argv: string[]): Promise<void> {
  // A bare first run provisions the project and agent bridges. Subsequent
  // invocations show the local memory status directly in the terminal.
  const cmd = argv[0] ?? "status";
  const rest = argv.slice(1);

  if (argv.length === 0) {
    const root = projectRoot();
    const configured = existsSync(projectConfigFile(root));
    const wired = coreAgentConnections(root).every((entry) => entry.configured);
    if (!configured || !wired) {
      await cmdSetup(["--yes"]);
      if (process.exitCode) return;
      println();
    }
  }

  switch (cmd) {
    case "console": return cmdConsole();
    case "daemon": return cmdDaemon(rest);
    case "admin": return cmdAdmin(rest);
    case "setup": return cmdSetup(rest);
    case "harness": return cmdHarness(rest);
    case "status": return cmdStatus(rest);
    case "task": return cmdTask(rest);
    case "init": return cmdInit(rest);
    case "wire": return cmdWire(rest);
    case "hooks": return cmdHooks(rest);
    case "start": return cmdStart(rest);
    case "doctor": return cmdDoctor(rest);
    case "usage": return cmdUsage(rest);
    case "add": return cmdOneShot("add", rest);
    case "ask": return cmdOneShot("ask", rest);
    case "remember": return cmdOneShot("remember", rest);
    case "recall": return cmdOneShot("recall", rest);
    case "learn": return cmdOneShot("learn", rest);
    case "history": return cmdOneShot("history", rest);
    case "list": return cmdOneShot("list", rest);
    case "resume": return cmdOneShot("resume", rest);
    case "report": return cmdOneShot("report", rest);
    case "capture": return cmdOneShot("capture", rest);
    case "forget": return cmdOneShot("forget", rest);
    case "graph": return cmdOneShot("graph", rest);
    case "why": return cmdOneShot("why", rest);
    case "context": return cmdOneShot("context", rest);
    case "handoff": return cmdOneShot("handoff", rest);
    case "dream": return cmdOneShot("dream", rest);
    case "reflect": return cmdOneShot("reflect", rest);
    case "consolidate": return cmdOneShot("consolidate", rest);
    case "open-loops": return cmdOneShot("open-loops", rest);
    case "profile": return cmdOneShot("profile", rest);
    case "export": return cmdOneShot("export", rest);
    case "import": return cmdOneShot("import", rest);
    case "help":
    case "--help":
    case "-h":
      // `help --json` is the machine-readable surface an agent uses to discover
      // what this CLI can do without being told. Same registry as the dispatch
      // table, guarded by a drift test.
      if (rest.includes("--json")) {
        println(JSON.stringify({ version: VERSION, commands: CLI_COMMANDS }, null, 2));
        return;
      }
      println(USAGE);
      return;
    default:
      println(`Unknown command: ${cmd}\n`);
      println(USAGE);
      process.exitCode = 1;
  }
}

const USAGE = `Lorex — local-first memory for coding agents.

  Production setup (1 command; hooks work offline afterward):
    npm install -g @lorex/cli && lorex setup

  Quick trial (generated hooks may later need npm cache/network):
    npx @lorex/cli setup

Public commands:
  lorex                      Set up this project on first run, then show terminal status
  lorex remember "fact"      Store a fact, with an optional reason (alias: add)
  lorex ask "question?"      Retrieve context and answer from it, or abstain
  lorex context [--plain]    Typed, budgeted context pack for injection
  lorex doctor               Verify setup, memory health, and model status
  lorex daemon [start|stop|status|run]
  lorex console              Open the optional local browser interface

Agent wiring:
  lorex wire                 Connect this project to your agents (.mcp.json)
  lorex hooks install        Agents auto-load memory every session
  lorex hooks status         Which agents have Lorex wired

Everything else — the full surface:
  lorex admin <command>      Any command from the full list (below)
  lorex help --json          The machine-readable command registry

Full list:
  setup · init · status · start · usage · learn · history
  list · resume · reflect · report · capture · forget · graph · why · handoff
  dream · consolidate · open-loops · profile · export · import

All commands run local-first (no key needed).

Shared memory across agents (spaces):
  LOREX_SPACE=<name>   Every agent naming the same space shares memory; the
                       console shows the current space for this project.
  --agent <name>       Who is writing (auto-detected: claude-code, cursor,
                       codex, vscode). Recall shows attribution.

  # Agent A records a decision and what comes next
  LOREX_WORKSPACE=checkout lorex handoff \
    --decision "Switched sessions to Redis" --next "Wire up the logout path"
  # Agent B picks up exactly where A stopped
  LOREX_WORKSPACE=checkout lorex resume
`;
