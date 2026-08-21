/** Command-line interface. */

import { createInterface } from "node:readline";
import { basename, join } from "node:path";
import { loadConfig, saveConfig, configFile, type Config } from "../infrastructure/config.js";
import { lorexHome } from "../infrastructure/paths.js";
import { resolveIdentity } from "../infrastructure/identity.js";
import { HydraDBClient, type HydraDBLike } from "../infrastructure/hydradb-client.js";
import { MockHydraDB } from "../infrastructure/mock-hydradb.js";
import { WriteQueue } from "../infrastructure/write-queue.js";
import { LorexEngine } from "../engine.js";
import { runStdioServer } from "./mcp-server.js";
import { startDashboard } from "./dashboard.js";

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
    snippet: (ws) =>
      JSON.stringify(
        { mcpServers: { lorex: { command: "lorex", args: ["start", "--workspace", ws] } } },
        null,
        2,
      ),
  },
  {
    name: "Codex",
    file: "~/.codex/config.toml",
    snippet: (ws) =>
      `[mcp_servers.lorex]\ncommand = "lorex"\nargs = ["start", "--workspace", "${ws}"]`,
  },
];

async function cmdInit(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    println(BANNER);
    println(`  Memory home: ${lorexHome()}`);
    if (!process.stdin.isTTY) println("  (non-interactive input — unanswered prompts take defaults)");
    println();

    let existing: Config | null = null;
    try {
      existing = loadConfig();
    } catch {
      existing = null;
    }

    println("  Step 1 of 3 — Connect HydraDB");
    println("  Lorex stores memory in your own HydraDB database. You bring the key.");
    println("  Get one at https://hydradb.com");
    println();

    let apiKey = existing?.apiKey ?? "";
    if (apiKey) {
      println(`  A key is already configured (…${apiKey.slice(-4)}).`);
      const replace = await prompt(rl, "  Replace it? [y/N] ");
      if (replace.toLowerCase().startsWith("y")) apiKey = "";
    }
    if (!apiKey) {
      apiKey = await prompt(rl, "  HydraDB API key: ");
      if (!apiKey) {
        println("\n  No key entered. Run `lorex init` again when you have one.");
        println("  Everything works offline meanwhile — add --mock to any command.\n");
        process.exitCode = 1;
        return;
      }
    }

    const baseUrl =
      (await prompt(rl, "  Base URL [https://api.hydradb.com]: ")) || "https://api.hydradb.com";

    println();
    println("  Step 2 of 3 — Name your workspace");
    println("  Every agent that names the same workspace reads and writes the same");
    println("  memory, on any machine. Without one, memory is scoped to this clone.");
    println();

    const suggestion = basename(process.cwd()).toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const workspace = (await prompt(rl, `  Workspace [${suggestion}]: `)) || suggestion;

    saveConfig({ apiKey, baseUrl });
    println();
    println(`  Saved to ${configFile()} (owner-readable only).`);

    println();
    println("  Verifying…");
    const client = new HydraDBClient({ apiKey, baseUrl, timeoutMs: 8_000, queueCap: 500 });
    const probe = await Promise.race([
      client.ping(slugWorkspace(workspace)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
    ]);

    if (!probe) {
      println("  [??] No response within 20s. Setup is saved; run `lorex doctor` to retry.");
    } else if (probe.authed && probe.reachable) {
      println(`  [ok] HydraDB reachable and authenticated (${probe.latencyMs}ms).`);
    } else if (!probe.authed) {
      println("  [!!] Key rejected. Check it and run `lorex init` again.");
    } else {
      println(`  [!!] Could not reach ${baseUrl}: ${probe.error ?? "unknown error"}`);
    }

    println();
    println("  Step 3 of 3 — Connect your agents");
    println("  Lorex runs as an MCP server. Point each agent at it:");
    for (const target of AGENT_SETUP) {
      println();
      println(`  ${target.name} — ${target.file}`);
      for (const line of target.snippet(workspace).split("\n")) println(`    ${line}`);
    }

    println();
    println("  Then, from any terminal:");
    println("    lorex doctor                     check the connection");
    println("    lorex resume                     what the last agent left you");
    println("    lorex graph --live               live context graph in a browser");
    println();
  } finally {
    rl.close();
  }
}

function slugWorkspace(input: string): string {
  return `ws_${input.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function identityFrom(args: string[], config: Config) {
  const at = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return resolveIdentity(process.cwd(), {
    database: config.databaseOverride,
    collection: config.collectionOverride,
    workspace: at("--workspace"),
    agent: at("--agent"),
  });
}

function buildClient(useMock: boolean, config: Config): HydraDBLike {
  if (useMock) {
    return new MockHydraDB({ persistPath: join(lorexHome(), "mock-store.json") });
  }
  return new HydraDBClient(config);
}

async function cmdStart(args: string[]): Promise<void> {
  const useMock = args.includes("--mock");
  const config = useMock ? mockConfig() : loadConfig();
  const identity = identityFrom(args, config);
  if (identity.warning) {
    process.stderr.write(`lorex: ${identity.warning}\n`);
  }
  const client = buildClient(useMock, config);
  const engine = new LorexEngine(client, identity, config.queueCap);
  const shutdown = (): void => {
    void engine.queue.flush().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await runStdioServer(engine);
}

async function cmdUsage(args: string[]): Promise<void> {
  const useMock = args.includes("--mock");
  const config = useMock ? mockConfig() : loadConfig();
  const identity = identityFrom(args, config);
  const client = buildClient(useMock, config);
  const engine = new LorexEngine(client, identity, config.queueCap);
  const u = engine.usage;
  println("Lorex usage (this project)\n==========================");
  println(`Writes:      ${u.writesThisHour}/${u.limits.writesPerHour} this hour · ${u.writesToday}/${u.limits.writesPerDay} today`);
  println(`Queries:     ${u.queriesThisHour}/${u.limits.queriesPerHour} this hour`);
  println(`Ingested:    ${u.ingestTokensToday}/${u.limits.ingestTokensPerDay} tokens today`);
  println(`Write queue: ${engine.queueLength} pending`);
  println("\nAdjust via LOREX_MAX_WRITES_PER_HOUR, LOREX_MAX_WRITES_PER_DAY,");
  println("LOREX_MAX_QUERIES_PER_HOUR, LOREX_MAX_INGEST_TOKENS_PER_DAY env vars.");
}

async function cmdDoctor(args: string[]): Promise<void> {
  const useMock = args.includes("--mock");
  println("Lorex doctor\n=============\n");
  const config = useMock ? mockConfig() : loadConfig();
  println(`[ok] config — base URL: ${config.baseUrl}${useMock ? " (MOCK)" : ""}`);

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

  const queue = new WriteQueue(client, config.queueCap);
  println(`[ok] write queue — ${queue.pending().length} pending (cap ${config.queueCap})`);

  println("\nSmoke test:");
  const engine = new LorexEngine(client, identity, config.queueCap);
  await engine.ensureReady();

  const r1 = await engine.remember("We use HydraDB for agent memory", {
    validFrom: new Date().toISOString(),
    id: "stack_memory",
  });
  println(`  remember: ${r1.summary}`);

  let r2 = await engine.recall({ query: "what memory database" });
  for (let attempt = 0; attempt < 6 && r2.sources.length === 0; attempt++) {
    if (attempt === 0) println("  recall:   waiting for the index…");
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    r2 = await engine.recall({ query: "what memory database" });
  }

  if (r2.sources.length > 0) {
    println(`  recall:   ${r2.summary}`);
  } else {
    println("  recall:   no results yet — the write is stored but not searchable.");
    println("            HydraDB indexes asynchronously; retry in a minute.");
  }

  const r3 = await engine.history({ factId: "stack_memory" });
  println(`  history:  ${r3.summary}`);

  println(`\n[ok] smoke complete.`);
}

async function cmdDashboard(args: string[]): Promise<void> {
  println("Starting Lorex Dashboard...\n");
  const useMock = args.includes("--mock");
  const config = useMock ? mockConfig() : loadConfig();
  const identity = identityFrom(args, config);
  const client = buildClient(useMock, config);
  const engine = new LorexEngine(client, identity, config.queueCap);
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
  const engine = new LorexEngine(client, identity, config.queueCap);

  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  let receipt;
  switch (op) {
    case "remember": {
      const fact = flag("--fact");
      if (!fact) return println(JSON.stringify({ error: "--fact required" }));
      receipt = await engine.remember(fact, {
        validFrom: flag("--validFrom"),
        id: flag("--id"),
        sourceRef: flag("--sourceRef"),
        ttlSeconds: flag("--ttl") ? Number(flag("--ttl")) : undefined,
        because: flag("--because"),
      });
      break;
    }
    case "recall": {
      receipt = await engine.recall({
        query: flag("--query"),
        asOf: flag("--asOf"),
        mode: flag("--mode") === "thinking" ? "thinking" : flag("--mode") === "fast" ? "fast" : undefined,
        type: flag("--type") as "memory" | "knowledge" | "all" | undefined,
        maxResults: flag("--maxResults") ? Number(flag("--maxResults")) : undefined,
        abstainOnAmbiguity: args.includes("--abstainOnAmbiguity") || undefined,
      });
      break;
    }
    case "learn": {
      const content = flag("--content");
      if (!content) return println(JSON.stringify({ error: "--content required" }));
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
    case "resume":
      receipt = await engine.resume();
      break;
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
      const { writeFileSync } = await import("node:fs");
      const out = flag("--out") ?? "lorex-graph.html";
      const { graph } = await engine.graph({ query: flag("--query"), maxResults });
      writeFileSync(out, renderGraphHtml(graph, {
        workspace: identity.workspace,
        database: identity.database,
        collection: identity.collection,
        query: flag("--query"),
      }));
      println(JSON.stringify({
        op: "graph",
        out,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        stats: graph.stats,
        summary: `Wrote ${out} - ${graph.nodes.length} nodes, ${graph.edges.length} edges, ` +
          `${graph.stats.explainedChanges}/${graph.stats.totalChanges} changes with a recorded reason.`,
      }, null, 2));
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
      });
      break;
    }
    case "capture": {
      const sessionId = flag("--sessionId");
      const file = flag("--file");
      if (!sessionId) return println(JSON.stringify({ error: "--sessionId required" }));
      if (!file) return println(JSON.stringify({ error: "--file required (JSON file with turns)" }));

      const { normalizeSession } = await import("../ingestion/normalizer.js");
      const { readFileSync } = await import("node:fs");
      const turns = JSON.parse(readFileSync(file, "utf8"));
      const session = normalizeSession(sessionId, identity.database, identity.collection, turns, {
        startedAt: flag("--startedAt"),
        agent: "cli",
        source: "capture",
      });
      const result = await engine.ingestSession(session);
      receipt = {
        op: "ingest",
        sources: [],
        mode_used: "fast",
        token_cost: result.tokenCount,
        abstained: false,
        summary: `Ingested session ${result.sessionId}: ${result.chunkCount} chunks, ${result.factCount} facts${result.partial ? " (partial)" : ""}`,
        result,
      };
      break;
    }
    default:
      return println(JSON.stringify({ error: `Unknown command: ${op}` }));
  }

  println(JSON.stringify(receipt, null, 2));
}

function mockConfig() {
  return {
    apiKey: "mock",
    baseUrl: "http://mock.local",
    timeoutMs: 5000,
    queueCap: 500,
    databaseOverride: undefined as string | undefined,
    collectionOverride: undefined as string | undefined,
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
  const cmd = argv[0] ?? "help";
  const rest = argv.slice(1);

  switch (cmd) {
    case "init": return cmdInit();
    case "start": return cmdStart(rest);
    case "doctor": return cmdDoctor(rest);
    case "usage": return cmdUsage(rest);
    case "dashboard": return cmdDashboard(rest);
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

const USAGE = `Lorex — agent memory and context layer on HydraDB.

Usage:
  lorex init                Configure HydraDB API key
  lorex start [--mock]      Start MCP server
  lorex doctor [--mock]     Verify setup
  lorex usage [--mock]      Show rate-limit usage and queue status
  lorex dashboard [--mock]  Local dashboard on 127.0.0.1:3000 (--port to change)

One-shot (JSON):
  lorex remember --fact "..." [--id id] [--because "..."] [--validFrom ISO] [--ttl s]
  lorex recall [--query "..."] [--asOf ISO] [--mode fast|thinking]
  lorex why [--factId id] [--query "..."]      Why a decision changed
  lorex graph [--query "..."] [--out f.html]   Render the context graph
  lorex graph --live [--port 4100]             Live graph that redraws as agents write
  lorex handoff --decision "..." [--next "..."] Hand work to the next agent
  lorex learn --content "..." [--sourceRef ref]
  lorex history [--factId id] [--query "..."]
  lorex list [--type memory|knowledge|all]
  lorex resume
  lorex forget [--factId id] [--query "..."]
  lorex report --requestId id [--answer "..."] [--rating positive|negative|neutral]
  lorex capture --sessionId id --file turns.json [--startedAt ISO]

All commands support --mock for offline testing.

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
