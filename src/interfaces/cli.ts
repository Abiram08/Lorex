/** Command-line interface. */

import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { loadConfig, saveConfig, configFile, type Config } from "../infrastructure/config.js";
import { lorexHome, storeDbPath } from "../infrastructure/paths.js";
import { resolveIdentity } from "../infrastructure/identity.js";
import { type HydraDBLike } from "../infrastructure/store.js";
import { MockHydraDB } from "../infrastructure/mock-hydradb.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { LorexEngine } from "../engine.js";
import { runStdioServer } from "./mcp-server.js";
import { startDashboard } from "./dashboard.js";
import { installHooks, isAgentSupported } from "./agent-hooks.js";

function println(s = ""): void { process.stdout.write(s + "\n"); }

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
    name: "Claude Code / Cursor / Windsurf",
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

function readJsonFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** One command: workspace + agent wiring + hooks + smoke test. */
async function cmdSetup(args: string[]): Promise<void> {
  const at = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const cwd = process.cwd();
  const config = loadConfig();
  const workspace =
    at("--workspace")?.trim() || config.workspace ||
    basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, "-");

  const nonInteractive = args.includes("--yes") || args.includes("-y") || !process.stdin.isTTY;
  const currentDir = config.dataDir || storeDbPath();
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
  saveConfig({ workspace, ...(dataDir ? { dataDir } : {}) });

  println(`Setting up Lorex for workspace "${workspace}"`);
  println(`Memory lives at: ${storeDbPath(dataDir || undefined)}\n`);

  println("[1/3] Wiring agents (MCP)…");
  await cmdWire(at("--workspace") ? ["--workspace", at("--workspace")!] : []);

  println("\n[2/3] Installing hooks (auto-load + auto-capture)…");
  for (const agent of ["claude-code", "codex", "opencode", "pi", "omp", "aider", "cline"] as const) {
    try {
      const { path } = installHooks(agent, cwd);
      println(`  [ok] ${agent} → ${path}`);
    } catch (e) {
      println(`  [skip] ${agent}: ${(e as Error).message}`);
    }
  }

  println("\n[3/3] Smoke test…");
  const client = new SqliteStore({ path: resolveLocalStorePath({ ...config, dataDir: dataDir || config.dataDir }) });
  const engine = new LorexEngine(client, resolveIdentity(cwd, { workspace }));
  await engine.ensureReady();
  await engine.remember("Lorex setup verified", { id: "lorex_setup" });
  const q = await engine.recall({ query: "setup verified", maxResults: 1 });
  println(q.sources.length > 0 ? "  [ok] remember → recall round-trip works" : "  [warn] recall empty — retry in a few seconds");

  println(`\nDone. Restart your agent — memory works from the next session.`);
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

  const wired = existsSync(join(process.cwd(), ".mcp.json"));
  println(`Agent wiring: ${wired ? ".mcp.json present" : "not wired — run lorex setup"}`);
}

/** Connect this project to coding agents. Writes configs instead of printing snippets. */
async function cmdWire(args: string[]): Promise<void> {
  const at = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const only = at("--agent"); // claude | cursor | windsurf | codex | all (default: file-based agents)
  const cwd = process.cwd();

  // Resolve + persist workspace so `lorex start` needs no flags.
  const config = loadConfig();
  const workspace =
    at("--workspace")?.trim() || config.workspace ||
    basename(cwd).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (!config.workspace || at("--workspace")) saveConfig({ workspace });

  const done: string[] = [];
  const wantFileAgents = !only || only === "all" || ["claude", "cursor", "windsurf"].includes(only);
  const wantCodex = only === "all" || only === "codex";

  if (wantFileAgents) {
    const mcpPath = join(cwd, ".mcp.json");
    const existing = readJsonFile(mcpPath);
    const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
    const { lorexBin } = await import("./agent-hooks.js");
    const bin = lorexBin();
    servers.lorex = bin === "lorex"
      ? { command: "lorex", args: ["start"] }
      : { command: "npx", args: ["-y", "@lorex/cli", "start"] };
    existing.mcpServers = servers;
    writeFileSync(mcpPath, JSON.stringify(existing, null) + "\n");
    done.push(`MCP: ${mcpPath} (Claude Code, Cursor, Windsurf)`);
  }

  if (wantCodex) {
    const codexPath = join(homedir(), ".codex", "config.toml");
    mkdirSync(join(homedir(), ".codex"), { recursive: true });
    const current = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : "";
    if (!current.includes("mcp_servers.lorex")) {
      const { lorexBin: codexBin } = await import("./agent-hooks.js");
      const codexCmd = codexBin();
      const block = codexCmd === "lorex"
        ? `[mcp_servers.lorex]\ncommand = "lorex"\nargs = ["start"]\n`
        : `[mcp_servers.lorex]\ncommand = "npx"\nargs = ["-y", "@lorex/cli", "start"]\n`;
      writeFileSync(codexPath, current + (current.endsWith("\n") || !current ? "" : "\n") + block);
      done.push(`MCP: ${codexPath} (Codex)`);
    } else {
      done.push(`MCP: ${codexPath} already wired`);
    }
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
    for (const s of hooksStatus(process.cwd())) {
      println(`  ${s.configured ? "[ok]" : "[--]"} ${s.agent}: ${s.detail}`);
    }
    return;
  }

  if (sub === "uninstall") {
    const { uninstallHooks, isAgentSupported: supported } = await import("./agent-hooks.js");
    const only = at("--agent");
    const agents = only ? [only] : ["claude-code", "codex", "opencode", "pi", "omp", "aider", "cline", "cursor", "windsurf", "gemini"];
    for (const agent of agents) {
      if (!supported(agent)) {
        println(`Unknown agent: "${agent}". Supported: claude-code, codex, opencode, pi, omp, aider, cline, cursor, windsurf, gemini`);
        process.exitCode = 1;
        return;
      }
      const { path, removed } = uninstallHooks(agent, process.cwd());
      println(removed ? `  [ok] ${agent}: removed from ${path}` : `  [--] ${agent}: nothing to remove (${path})`);
    }
    println("Note: MCP wiring (.mcp.json) is separate — delete the lorex block to fully detach.");
    return;
  }

  if (sub !== "install") {
    println('Usage: lorex hooks [install|status|uninstall] [--agent claude-code|cursor|windsurf|codex|opencode|gemini|cline|aider]');
    return;
  }
  const agent = at("--agent") ?? "claude-code";

  if (!isAgentSupported(agent)) {
    println(`Unknown agent: "${agent}". Supported: claude-code, cursor, windsurf, codex, opencode, gemini, cline, aider`);
    process.exitCode = 1;
    return;
  }

  const { path, description } = installHooks(agent, process.cwd());
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

    const suggestion = basename(process.cwd()).toLowerCase().replace(/[^a-z0-9]+/g, "-");
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

    saveConfig({ workspace, ...(dataDir ? { dataDir } : {}) });
    println();
    println(`  Saved to ${configFile()} (owner-readable only).`);
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

async function cmdStart(args: string[]): Promise<void> {
  const useMock = args.includes("--mock");
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
}

async function cmdLocal(args: string[]): Promise<void> {
  // Zero-setup: no init, no key, no workspace flag. Everything auto-resolves.
  const config = loadConfig();
  const identity = identityFrom(args, config);
  const client = buildClient(false, config);
  const engine = new LorexEngine(client, identity);
  const at = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const { serveLocal } = await import("./local-server.js");
  const { url } = await serveLocal(engine, {
    host: at("--host") ?? "127.0.0.1",
    port: at("--port") ? Number(at("--port")) : 3777,
  });
  const semantic = process.env.LOREX_EMBED_URL?.trim()
    ? `semantic: on (${process.env.LOREX_EMBED_MODEL?.trim() || "nomic-embed-text"})`
    : "semantic: off (FTS only — set LOREX_EMBED_URL to enable)";
  println(`Lorex local memory API running at ${url}`);
  println(`  store:    ${resolveLocalStorePath(config)}`);
  println(`  memory:   ${semantic}`);
  println(`  POST ${url}/add     {"text": "fact because reason"}`);
  println(`  POST ${url}/search  {"query": "what changed?"}`);
  println(`  GET  ${url}/resume / GET /health / GET /profile`);
  println("  No setup needed — data lives on your machine. Press Ctrl+C to stop.\n");
  await new Promise(() => undefined); // run until killed
}

async function cmdDashboard(args: string[]): Promise<void> {
  println("Starting Lorex Dashboard...\n");
  const useMock = args.includes("--mock");
  const config = useMock ? mockConfig() : loadConfig();
  const identity = identityFrom(args, config);
  const client = buildClient(useMock, config);
  const engine = new LorexEngine(client, identity);
  await engine.ensureReady();

  const at = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(at("--port")) || 3000;
  const host = at("--host") ?? "127.0.0.1";
  const { url } = await startDashboard(engine, host, port);
  println(`Dashboard running at: ${url}`);
  println("Press Ctrl+C to stop.\n");
}

async function cmdOneShot(op: string, args: string[]): Promise<void> {
  const useMock = args.includes("--mock");
  const config = useMock ? mockConfig() : loadConfig();
  const identity = identityFrom(args, config);
  const client = buildClient(useMock, config);
  const engine = new LorexEngine(client, identity);

  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  // Simple positional: `lorex add "text"` / `lorex ask "question"` — join
  // non-flag args so quoting is optional. Only value-flags consume the next arg.
  const VALUE_FLAGS = new Set([
    "--fact", "--query", "--id", "--because", "--validFrom", "--validTo",
    "--sourceRef", "--ttl", "--scope", "--relation", "--workspace", "--agent",
    "--file", "--in", "--out", "--transcript", "--sessionId", "--startedAt",
    "--next", "--decision", "--requestId", "--answer", "--rating", "--feedback",
    "--sourceIds", "--maxResults", "--maxTokens", "--mode", "--type", "--asOf",
    "--data-dir", "--host", "--port", "--kind", "--collection",
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
      // Human-friendly output for `ask`: answer first, sources after.
      if (op === "ask") {
        const r = receipt as typeof receipt & { answer?: string; summary?: string; sources?: Array<{ excerpt?: string }> };
        if (r && typeof r === "object") {
          if ((r as { abstained?: boolean }).abstained) println((r as { summary?: string }).summary ?? "No supporting evidence found.");
          else println((r as { answer?: string }).answer ?? (r as { summary?: string }).summary ?? "");
          println("");
        }
      }
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

      if (args.includes("--live")) {
        const { serveGraph } = await import("./graph-server.js");
        await engine.ensureReady();
        const { url } = await serveGraph(engine, {
          query: flag("--query"),
          maxResults,
          port: flag("--port") ? Number(flag("--port")) : undefined,
        });
        println(`Live context graph: ${url}`);
        println("Redraws as agents write to memory. Press Ctrl+C to stop.\n");
        return;
      }

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
      const r = await engine.dream();
      println(JSON.stringify({
        op: "dream",
        discovered: r.discovered.length,
        persisted: r.persisted,
        reinforced: r.reinforced.length,
        contradictions: r.contradictions.length,
        consolidated: r.consolidated,
        durationMs: r.durationMs,
        summary: `Dream found ${r.discovered.length} patterns, persisted ${r.persisted}, ` +
          `reinforced ${r.reinforced.length}, flagged ${r.contradictions.length} contradictions.`,
        result: r,
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
      const { captureTranscript, autoCaptureSession } = await import("../ingestion/session-capture.js");
      const transcriptPath = flag("--transcript") ?? flag("--file");

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
          abstained: false,
          summary: `Captured session ${receipt.sessionId}: ${receipt.chunkCount} chunks, ${receipt.factCount} facts${receipt.partial ? " (partial)" : ""}`,
          result: receipt,
        };
      } else {
        // Auto-detect most recent session across known agent dirs
        const result = await autoCaptureSession(engine);
        if (!result) {
          receipt = {
            op: "capture",
            sources: [],
            mode_used: "fast",
            token_cost: 0,
            abstained: true,
            summary: "No recent agent session found (checked Claude Code, Codex).",
          };
        } else {
          receipt = {
            op: "capture",
            sources: [],
            mode_used: "fast",
            token_cost: result.tokenCount,
            abstained: false,
            summary: `Captured session ${result.sessionId}: ${result.chunkCount} chunks, ${result.factCount} facts`,
            result,
          };
        }
      }
      break;
    }
    default:
      return println(JSON.stringify({ error: `Unknown command: ${op}` }));
  }

  println(JSON.stringify(receipt, null));
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

export async function runCli(argv: string[]): Promise<void> {
  const cmd = argv[0] ?? "status";
  const rest = argv.slice(1);

  switch (cmd) {
    case "setup": return cmdSetup(rest);
    case "status": return cmdStatus(rest);
    case "init": return cmdInit(rest);
    case "local": return cmdLocal(rest);
    case "wire": return cmdWire(rest);
    case "hooks": return cmdHooks(rest);
    case "start": return cmdStart(rest);
    case "doctor": return cmdDoctor(rest);
    case "usage": return cmdUsage(rest);
    case "dashboard": return cmdDashboard(rest);
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
    case "handoff": return cmdOneShot("handoff", rest);
    case "dream": return cmdOneShot("dream", rest);
    case "consolidate": return cmdOneShot("consolidate", rest);
    case "open-loops": return cmdOneShot("open-loops", rest);
    case "profile": return cmdOneShot("profile", rest);
    case "export": return cmdOneShot("export", rest);
    case "import": return cmdOneShot("import", rest);
    case "help":
    case "--help":
    case "-h":
      println(USAGE);
      return;
    default:
      println(`Unknown command: ${cmd}\n`);
      println(USAGE);
      process.exitCode = 1;
  }
}

const USAGE = `Lorex — local-first memory for coding agents.

Start here (1 command, nothing to install):
  npx @lorex/cli setup

Or paste this into your agent and it does the rest:
  "Set up Lorex memory for this project by running npx @lorex/cli setup"

Daily use (3 commands):
  lorex add "fact because reason"   (or: npx @lorex/cli add "...")
  lorex ask "question?"
  lorex                             status: memory, loops, handoff, wiring

Zero setup (no init needed):
  lorex local                   start the memory API on http://127.0.0.1:3777
  lorex wire                    connect this project to your agents (writes .mcp.json)
  lorex hooks install [--agent ...]  agents auto-load memory every session
  lorex hooks status                 which agents have Lorex wired
  lorex hooks uninstall [--agent …]  remove Lorex from agent configs
  lorex add "fact because reason"
  lorex ask "question?"

Usage:
  lorex init [--workspace name] [--yes] [--local]   setup (workspace saved, key optional)
  lorex start               Start MCP server (local store)
  lorex doctor              Verify setup (fast local smoke test)
  lorex usage               Show rate-limit usage
  lorex dashboard           Local dashboard on 127.0.0.1:3000 (--port to change)

Simple (human output):
  lorex add "Session storage moved to Redis because Atlas timed out"
  lorex ask "what do we use for sessions?"

Full (JSON):
  lorex remember --fact "..." [--id id] [--because "..."] [--validFrom ISO] [--ttl s] [--scope global]
  lorex recall [--query "..."] [--asOf ISO] [--mode fast|thinking] [--synthesize]
  lorex why [--factId id] [--query "..."]      Why a decision changed
  lorex graph [--query "..."] [--out f.html]   Render the context graph
  lorex graph --publish [--publish-dir dir]    Bake a shareable snapshot + gallery
  lorex graph --live [--port 4100]             Live graph that redraws as agents write
  lorex handoff --decision "..." [--next "..."] Hand work to the next agent
  lorex learn --content "..." [--sourceRef ref]
  lorex learn --file ./runbook.md | --url https://…
  lorex history [--factId id] [--query "..."]
  lorex list [--type memory|knowledge|all]
  lorex resume
  lorex forget [--factId id] [--query "..."]
  lorex report --requestId id [--answer "..."] [--rating positive|negative|neutral]
  lorex dream                               Mine sessions for patterns, persist discoveries
  lorex consolidate [--prune]               Apply expired TTLs (and, with --prune, merges)
  lorex open-loops                          Tasks recorded but never acted on
  lorex profile [--kind user|project] [--refresh] [--plain]
                                            Standing state, no retrieval needed
  lorex export [--collection c] [--out f]   Dump memories as JSONL (backup, git, sync)
  lorex import --file f [--force]           Merge a dump (local wins unless --force)
  lorex capture --sessionId id --file turns.json [--startedAt ISO]

All commands run local-first (no key needed).

Shared memory across agents:
  --workspace <name>   Join a shared workspace. Every agent naming the same
                       workspace reads and writes the same memory, on any
                       machine. Also settable via LOREX_WORKSPACE.
  --agent <name>       Who is writing (auto-detected: claude-code, cursor,
                       codex, vscode). Recall shows attribution.

  # Agent A records a decision and what comes next
  LOREX_WORKSPACE=checkout lorex handoff \
    --decision "Switched sessions to Redis" --next "Wire up the logout path"
  # Agent B picks up exactly where A stopped
  LOREX_WORKSPACE=checkout lorex resume
`;
