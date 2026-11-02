/**
 * The resident Lorex service: one process, one port.
 *
 * Serves the console, the REST v1 API, the hook fast paths, SSE activity
 * events, the live graph, and MCP over HTTP — all against the same local
 * SQLite store. Every client (CLI, hooks, agents) falls back to running the
 * engine in-process when the daemon is down, so it can never become a
 * single point of failure.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { LorexEngine } from "../engine.js";
import { loadConfig, saveConfig } from "../infrastructure/config.js";
import { resolveIdentity } from "../infrastructure/identity.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { lorexHome, storeDbPath } from "../infrastructure/paths.js";
import { RateLimitError } from "../infrastructure/rate-limiter.js";
import { VERSION } from "../infrastructure/version.js";
import { detectLocalModels, type LocalModels } from "../infrastructure/local-models.js";
import { providerFromConfig } from "../infrastructure/embeddings.js";
import { renderGraphHtml } from "../interfaces/graph-render.js";
import { hooksStatus, installHooks, uninstallHooks, isAgentSupported } from "../interfaces/agent-hooks.js";
import { createServer as createMcpServer } from "../interfaces/mcp-server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { clearDaemonInfo, liveDaemon, writeDaemonInfo } from "./lock.js";
import { normalizeSession } from "../ingestion/normalizer.js";

export interface DaemonOptions {
  host?: string;
  port?: number;
  /** Project directory used when a request does not carry its own cwd. */
  cwd?: string;
  consoleDir?: string;
}

export interface DaemonHandle {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

const MAX_BODY = 1024 * 1024;
const MAX_MCP_INPUT_ELEMENTS = 10_000;

/**
 * Count container members before the MCP SDK validates a tools/call payload.
 * The HTTP body cap limits bytes; this separate structural cap prevents a
 * compact, deeply populated JSON value from turning validation into an
 * unbounded allocation. Stdio remains a local, trusted-agent transport.
 */
function structuredElementCount(value: unknown, stopAfter = MAX_MCP_INPUT_ELEMENTS): number {
  const pending: unknown[] = [value];
  let count = 0;
  while (pending.length) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      count += current.length;
      if (count > stopAfter) return count;
      pending.push(...current);
    } else if (current && typeof current === "object") {
      const values = Object.values(current as Record<string, unknown>);
      count += values.length;
      if (count > stopAfter) return count;
      pending.push(...values);
    }
  }
  return count;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T | null> {
  try {
    return JSON.parse(await readBody(req)) as T;
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  type = "text/plain; charset=utf-8",
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(body);
}

/** `.lorex.json` in a project pins which space that project writes to. */
function projectSpace(cwd: string): string | undefined {
  const file = join(cwd, ".lorex.json");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { space?: string };
    return parsed.space?.trim() || undefined;
  } catch {
    return undefined;
  }
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export async function startDaemonService(opts: DaemonOptions = {}): Promise<DaemonHandle> {
  const host = opts.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `refusing to bind the daemon to "${host}" — it serves the console and the full memory API. Loopback only.`,
    );
  }
  const existing = liveDaemon();
  if (existing) {
    throw new Error(`Lorex daemon already running (pid ${existing.pid}, port ${existing.port}).`);
  }

  const bootCwd = opts.cwd ?? process.cwd();
  const requestedPort = opts.port ?? loadConfig(bootCwd).daemonPort ?? 3777;

  // Best-effort: light up optional local embeddings / synthesis with zero config.
  // Keep the resolved provider explicit; detectLocalModels does not mutate env.
  const localModels = await detectLocalModels().catch((): LocalModels => ({}));
  const embeddingProvider = providerFromConfig({
    url: localModels.embedUrl,
    model: localModels.embedModel,
    openAI: process.env.LOREX_EMBED_OPENAI === "1",
    apiKey: process.env.LOREX_EMBED_API_KEY,
  });

  const engines = new Map<string, LorexEngine>();
  const stores = new Map<string, SqliteStore>();
  const identityKey = (engine: LorexEngine): string => {
    const identity = engine.getIdentity();
    return `${identity.database}|${identity.collection}|${identity.agent}`;
  };
  const engineFor = async (cwd: string, agent?: string): Promise<LorexEngine> => {
    const config = loadConfig(cwd);
    const workspace = config.workspace ?? process.env.LOREX_SPACE?.trim() ?? projectSpace(cwd);
    const identity = resolveIdentity(cwd, {
      database: config.databaseOverride,
      collection: config.collectionOverride,
      workspace,
      agent,
    });
    const key = `${identity.database}|${identity.collection}|${identity.agent}`;
    let engine = engines.get(key);
    if (!engine) {
      const store = new SqliteStore({ path: storeDbPath(config.dataDir) });
      store.setEmbedder(embeddingProvider);
      engine = new LorexEngine(store, identity);
      engines.set(key, engine);
      stores.set(key, store);
    }
    await engine.ensureReady();
    // Any request touching a workspace also resumes durable jobs left by a
    // previous daemon process. queueMicrotask keeps request setup non-blocking.
    queueMicrotask(() => void drainJobs(engine!));
    return engine;
  };

  const consoleDir = opts.consoleDir ?? join(dirname(fileURLToPath(import.meta.url)), "../../console");
  const startedAt = new Date().toISOString();
  let actualPort = requestedPort;

  // ── Live activity events (SSE) ─────────────────────────────────────────────

  const sseClients = new Set<ServerResponse>();
  const broadcast = (event: Record<string, unknown>): void => {
    const payload = `data: ${JSON.stringify({ ...event, at: new Date().toISOString() })}\n\n`;
    for (const client of sseClients) {
      try { client.write(payload); } catch { sseClients.delete(client); }
    }
  };

  // ── Durable background jobs (acknowledge only after SQLite commit) ────────

  const draining = new Set<string>();
  const drainJobs = async (engine: LorexEngine): Promise<void> => {
    const key = identityKey(engine);
    if (draining.has(key)) return;
    const store = stores.get(key);
    if (!store) return;
    draining.add(key);
    try {
      let job;
      while ((job = store.claimBackgroundJob(engine.getIdentity().collection))) {
        broadcast({ type: "job-start", name: job.kind, id: job.id, attempt: job.attempts });
        try {
          let summary: string;
          if (job.kind === "capture") {
            const sessionId = String(job.payload.sessionId ?? "");
            const prompt = String(job.payload.prompt ?? "");
            const response = String(job.payload.response ?? "");
            const agent = String(job.payload.agent ?? "unknown");
            const occurredAt = typeof job.payload.occurredAt === "string" ? job.payload.occurredAt : undefined;
            if (!sessionId || !prompt || !response) throw new Error("durable capture job is missing session evidence");
            const identity = engine.getIdentity();
            const captureId = `hook_${createHash("sha256").update(`${agent}|${sessionId}|${prompt}|${response}`).digest("hex").slice(0, 24)}`;
            const session = normalizeSession(captureId, identity.database, identity.collection,
              [{ role: "user", content: prompt }, { role: "assistant", content: response, occurredAt }],
              { agent, source: "daemon-hook" });
            const captured = await engine.ingestSession(session);
            if (captured.partial || captured.errors.length) throw new Error(captured.errors.join("; ") || "partial hook capture");
            summary = `captured ${captured.factCount} memories from ${captured.sessionId}`;
            if (job.payload.withDream === true) {
              const dream = await engine.dreamAuto();
              if (dream.ran) summary += ` · dream: ${dream.result.discovered.length} patterns`;
            }
          } else if (job.kind === "dream") {
            const dream = await engine.dreamAuto();
            summary = dream.ran ? `dream: ${dream.result.discovered.length} patterns` : "dream: gates not met";
          } else {
            throw new Error(`unknown durable job kind: ${job.kind}`);
          }
          store.completeBackgroundJob(job.id);
          broadcast({ type: "job-done", name: job.kind, id: job.id, summary });
        } catch (error) {
          const message = (error as Error).message;
          store.failBackgroundJob(job.id, message, job.attempts);
          broadcast({ type: "job-error", name: job.kind, id: job.id, error: message, attempt: job.attempts });
          if (job.attempts < 5) {
            const retry = setTimeout(() => void drainJobs(engine), Math.min(60_000, 2 ** job.attempts * 1_000));
            retry.unref();
          }
        }
      }
    } finally {
      draining.delete(key);
    }
  };

  const bootEngine = await engineFor(bootCwd);
  try { await bootEngine.ensureSpace(); } catch { /* the console surfaces it */ }
  void drainJobs(bootEngine);

  // ── Request handling ──────────────────────────────────────────────────────

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Reject DNS rebinding attempts before any console or memory route runs.
    const requestHost = String(req.headers.host ?? "").toLowerCase();
    const allowedHosts = new Set([
      `127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`,
    ]);
    if (!allowedHosts.has(requestHost)) return json(res, 403, { error: "local host required" });

    // Browsers can send simple cross-site requests to loopback even without
    // CORS permission. Reject them before any read or mutation route runs.
    const origin = req.headers.origin;
    if (origin) {
      let originUrl: URL;
      try { originUrl = new URL(origin); }
      catch { return json(res, 403, { error: "invalid origin" }); }
      if (originUrl.protocol !== "http:" || !allowedHosts.has(originUrl.host)) {
        return json(res, 403, { error: "local origin required" });
      }
    }
    if (req.headers["sec-fetch-site"] === "cross-site") {
      return json(res, 403, { error: "cross-site requests are not allowed" });
    }

    const url = new URL(req.url ?? "/", `http://${host}`);
    const method = req.method ?? "GET";
    const path = url.pathname;
    const cwd = url.searchParams.get("cwd") ?? bootCwd;
    const agent = url.searchParams.get("agent") ?? undefined;

    if (method === "GET" && path === "/health") {
      return json(res, 200, { ok: true, version: VERSION, pid: process.pid, port: actualPort });
    }

    // Console (same origin, loopback only — same trust level as the API).
    if (method === "GET" && (path === "/" || path === "/index.html" || path === "/app.js" || path === "/styles.css")) {
      const file = path === "/" ? "index.html" : path.slice(1);
      const full = join(consoleDir, file);
      if (!existsSync(full)) return sendText(res, 404, "console assets missing", "text/plain; charset=utf-8");
      const headers: Record<string, string> = file === "index.html" ? {
        "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'",
        "Referrer-Policy": "no-referrer",
      } : {};
      return sendText(res, 200, readFileSync(full, "utf8"), STATIC_TYPES[extname(file)] ?? "application/octet-stream", headers);
    }

    if (method === "GET" && path === "/v1/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ type: "hello", at: new Date().toISOString() })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (method === "GET" && path === "/v1/status") {
      const engine = await engineFor(cwd, agent);
      const identity = engine.getIdentity();
      const spaces = await engine.listSpaces();
      const space = spaces?.find((s) => s.id === identity.collection) ?? null;
      const jobs = stores.get(identityKey(engine))?.backgroundJobCounts(identity.collection) ?? {};
      return json(res, 200, {
        ok: true,
        version: VERSION,
        daemon: { pid: process.pid, port: actualPort, startedAt },
        project: {
          cwd,
          database: identity.database,
          collection: identity.collection,
          workspace: identity.workspace,
          agent: identity.agent,
          label: identity.collectionLabel,
        },
        spaces: { total: spaces?.length ?? 0, current: space, autoNamed: space?.source === "auto" },
        memories: spaces?.reduce((sum, s) => sum + s.memories, 0) ?? 0,
        currentMemories: space?.memories ?? 0,
        usage: engine.usage,
        jobs,
        dream: await engine.dreamStatus(),
      });
    }

    // ── Spaces ───────────────────────────────────────────────────────────────

    if (method === "GET" && path === "/v1/spaces") {
      const engine = await engineFor(cwd, agent);
      const spaces = await engine.listSpaces();
      return json(res, 200, {
        spaces: spaces ?? [],
        current: engine.getIdentity().collection,
        supported: spaces !== null,
      });
    }

    if (method === "POST" && path === "/v1/spaces") {
      const body = (await readJson<{ name?: string; description?: string }>(req)) ?? {};
      const name = body.name?.trim();
      if (!name) return json(res, 400, { error: 'Usage: { "name": "checkout", "description": "..." }' });
      const engine = await engineFor(cwd, agent);
      const created = await engine.createSpace(name, body.description ?? "");
      if (!created) return json(res, 501, { error: "spaces require the SQLite backend" });
      broadcast({ type: "space-created", name, id: created.id });
      return json(res, 200, { ok: true, ...created });
    }

    if (method === "PATCH" && path.startsWith("/v1/spaces/")) {
      const id = decodeURIComponent(path.slice("/v1/spaces/".length));
      const body = (await readJson<{ name?: string; description?: string; archived?: boolean }>(req)) ?? {};
      const engine = await engineFor(cwd, agent);
      const ok = await engine.updateSpace(id, body);
      if (!ok) return json(res, 404, { error: "space not found, or nothing to change" });
      broadcast({ type: "space-updated", id });
      return json(res, 200, { ok: true });
    }

    // ── Memories ─────────────────────────────────────────────────────────────

    if (method === "GET" && path === "/v1/memories") {
      const engine = await engineFor(cwd, agent);
      const q = (url.searchParams.get("query") ?? url.searchParams.get("q") ?? "").trim();
      const type = (url.searchParams.get("type") ?? "all") as "memory" | "knowledge" | "all";
      const maxResults = Number(url.searchParams.get("maxResults")) || undefined;
      if (q) {
        const receipt = await engine.recall({ query: q, type, maxResults });
        return json(res, 200, {
          sources: receipt.sources,
          answer: receipt.answer,
          summary: receipt.summary,
          abstained: receipt.abstained,
          abstention_reason: receipt.abstention_reason,
          request_id: receipt.request_id,
        });
      }
      const receipt = await engine.list({ type, maxResults: maxResults ?? 50 });
      return json(res, 200, {
        sources: receipt.sources,
        answer: receipt.answer,
        summary: receipt.summary,
        abstained: receipt.abstained,
        request_id: receipt.request_id,
      });
    }

    if (method === "GET" && path.startsWith("/v1/memories/")) {
      const id = decodeURIComponent(path.slice("/v1/memories/".length));
      const engine = await engineFor(cwd, agent);
      const receipt = await engine.history({ factId: id });
      return json(res, 200, receipt);
    }

    if (method === "POST" && (path === "/v1/memories" || path === "/add" || path === "/v4/memories")) {
      const body = (await readJson<{ text?: string; content?: string; because?: string; id?: string; scope?: string }>(req)) ?? {};
      const input = (body.text ?? body.content ?? "").trim();
      if (!input) return json(res, 400, { error: 'Usage: { "text": "fact because reason" }' });
      const engine = await engineFor(cwd, agent);
      const receipt = await engine.remember(input, {
        id: body.id,
        because: body.because,
        scope: body.scope === "global" ? "global" : undefined,
      });
      broadcast({ type: "memory-added", summary: receipt.summary });
      return json(res, 200, { ok: true, summary: receipt.summary, result: receipt.result, request_id: receipt.request_id });
    }

    if (method === "POST" && path === "/v1/knowledge") {
      const body = (await readJson<{ content?: string; sourceRef?: string }>(req)) ?? {};
      const content = typeof body.content === "string" ? body.content.trim() : "";
      if (!content) return json(res, 400, { error: 'Usage: { "content": "source text", "sourceRef": "optional label" }' });
      if (body.sourceRef !== undefined && typeof body.sourceRef !== "string") {
        return json(res, 400, { error: "sourceRef must be a string" });
      }
      const engine = await engineFor(cwd, agent);
      const receipt = await engine.learn(content, body.sourceRef?.trim() || undefined);
      broadcast({ type: "knowledge-added", summary: receipt.summary });
      return json(res, 200, { ok: true, summary: receipt.summary, result: receipt.result, request_id: receipt.request_id });
    }

    if (method === "POST" && (path === "/search" || path === "/v4/search")) {
      const body = (await readJson<{ query?: string; q?: string; asOf?: string }>(req)) ?? {};
      const q = (body.query ?? body.q ?? "").trim();
      if (!q) return json(res, 400, { error: 'Usage: { "query": "question?" }' });
      const engine = await engineFor(cwd, agent);
      const receipt = await engine.recall({ query: q, asOf: body.asOf });
      return json(res, 200, {
        answer: receipt.answer,
        summary: receipt.summary,
        abstained: receipt.abstained,
        sources: receipt.sources,
        request_id: receipt.request_id,
      });
    }

    if (method === "POST" && path === "/v1/forget") {
      const body = (await readJson<{ factId?: string; query?: string }>(req)) ?? {};
      const engine = await engineFor(cwd, agent);
      const receipt = await engine.forget({ factId: body.factId, query: body.query });
      broadcast({ type: "memory-forgotten", summary: receipt.summary });
      return json(res, 200, { ok: true, summary: receipt.summary, request_id: receipt.request_id });
    }

    if (method === "POST" && path === "/v1/report") {
      const body = (await readJson<{
        requestId?: string;
        rating?: string;
        query?: string;
        answer?: string;
        feedback?: string;
        sourceIds?: string[];
      }>(req)) ?? {};
      if (!body.requestId) return json(res, 400, { error: "requestId is required" });
      const engine = await engineFor(cwd, agent);
      const receipt = await engine.report({
        requestId: body.requestId,
        rating: body.rating as "positive" | "negative" | "neutral" | undefined,
        query: body.query,
        answer: body.answer,
        feedback: body.feedback,
        sourceIds: body.sourceIds,
      });
      return json(res, 200, { ok: true, summary: receipt.summary });
    }

    // ── Context, profile, learner surfaces ───────────────────────────────────

    if (method === "GET" && (path === "/v1/context" || path === "/v1/context/plain")) {
      const engine = await engineFor(cwd, agent);
      const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? undefined;
      const maxTokens = Number(url.searchParams.get("maxTokens")) || undefined;
      const receipt = await engine.contextPack({ query: q ?? undefined, maxTokens });
      if (path.endsWith("/plain")) return sendText(res, 200, receipt.context ?? receipt.summary ?? "");
      const result = (receipt.result ?? {}) as Record<string, unknown>;
      return json(res, 200, {
        text: receipt.context ?? "",
        summary: receipt.summary,
        tokens: receipt.token_cost ?? 0,
        sections: result.sections,
        contributing_agents: result.contributing_agents,
        abstained: receipt.abstained,
        request_id: receipt.request_id,
      });
    }

    // ── Hook fast paths (what every agent session actually calls) ─────────────

    if (method === "POST" && path === "/v1/hooks/session-start") {
      const body = (await readJson<{ cwd?: string; agent?: string }>(req)) ?? {};
      const hookCwd = body.cwd ?? bootCwd;
      const engine = await engineFor(hookCwd, body.agent);
      const receipt = await engine.contextPack();
      broadcast({ type: "hook-session-start", cwd: hookCwd, tokens: receipt.token_cost ?? 0 });
      return json(res, 200, {
        text: receipt.context ?? receipt.summary ?? "",
        tokens: receipt.token_cost ?? 0,
        empty: !receipt.context,
      });
    }

    if (method === "POST" && (path === "/v1/hooks/stop" || path === "/v1/hooks/pre-compact")) {
      const body = (await readJson<{
        cwd?: string; agent?: string; sessionId?: string; prompt?: string; response?: string;
        last_assistant_message?: string; assistant_message?: string; text?: string; timestamp?: string;
      }>(req)) ?? {};
      const response = [body.response, body.last_assistant_message, body.assistant_message, body.text]
        .find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
      const occurredAt = typeof body.timestamp === "string" && !Number.isNaN(Date.parse(body.timestamp))
        ? body.timestamp
        : undefined;
      if (typeof body.sessionId !== "string" || !body.sessionId.trim() || typeof body.prompt !== "string" || !body.prompt.trim() || !response ||
          body.prompt.length > 40_000 || response.length > 40_000) {
        return json(res, 400, { error: "sessionId, prompt and a completed response (each <= 40000 chars) are required; response, last_assistant_message, assistant_message, and text are accepted" });
      }
      const sessionId = body.sessionId;
      const prompt = body.prompt;
      const completedResponse = response;
      const hookCwd = body.cwd ?? bootCwd;
      const withDream = path.endsWith("/stop");
      const engine = await engineFor(hookCwd, body.agent);
      const store = stores.get(identityKey(engine));
      if (!store) return json(res, 503, { error: "durable job store unavailable" });
      const jobId = `capture_${createHash("sha256").update(
        `${body.agent ?? "unknown"}|${sessionId}|${prompt}|${completedResponse}|${withDream}`,
      ).digest("hex").slice(0, 24)}`;
      store.enqueueBackgroundJob(engine.getIdentity().collection, jobId, "capture", {
        sessionId,
        prompt,
        response: completedResponse,
        occurredAt,
        agent: body.agent ?? "unknown",
        withDream,
      });
      void drainJobs(engine);
      return json(res, 200, { queued: true, job_id: jobId, durable: true });
    }

    if (method === "POST" && path === "/v1/hooks/dream") {
      const body = (await readJson<{ cwd?: string; agent?: string }>(req)) ?? {};
      const hookCwd = body.cwd ?? bootCwd;
      const engine = await engineFor(hookCwd, body.agent);
      const store = stores.get(identityKey(engine));
      if (!store) return json(res, 503, { error: "durable job store unavailable" });
      const jobId = `dream_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      store.enqueueBackgroundJob(engine.getIdentity().collection, jobId, "dream", {});
      void drainJobs(engine);
      return json(res, 200, { queued: true, job_id: jobId, durable: true });
    }

    if (method === "GET" && path === "/resume") {
      const engine = await engineFor(cwd, agent);
      const receipt = await engine.resume();
      return json(res, 200, { summary: receipt.summary, sources: receipt.sources });
    }

    if (method === "GET" && (path === "/v1/profile" || path === "/profile" || path === "/v4/profile")) {
      const engine = await engineFor(cwd, agent);
      const kind = url.searchParams.get("kind") === "user" ? "user" : "project";
      const profile = await engine.profile(kind, url.searchParams.has("refresh"));
      if (!profile) return json(res, 501, { error: "profiles require the SQLite backend" });
      return json(res, 200, profile);
    }

    if (method === "GET" && path === "/v1/reflect") {
      const engine = await engineFor(cwd, agent);
      return json(res, 200, await engine.reflect());
    }

    if (method === "GET" && path === "/v1/open-loops") {
      const engine = await engineFor(cwd, agent);
      return json(res, 200, { loops: await engine.openLoops() });
    }

    if (method === "POST" && path === "/v1/dream") {
      const engine = await engineFor(cwd, agent);
      if (url.searchParams.get("auto") === "1") return json(res, 200, await engine.dreamAuto());
      return json(res, 200, await engine.dream());
    }

    if (method === "POST" && path === "/v1/consolidate") {
      const engine = await engineFor(cwd, agent);
      return json(res, 200, await engine.consolidate(url.searchParams.get("prune") === "1"));
    }

    if (method === "GET" && path === "/v1/reviews") {
      const engine = await engineFor(cwd, agent);
      return json(res, 200, { items: await engine.reviews() });
    }

    const reviewMatch = path.match(/^\/v1\/reviews\/([^/]+)$/);
    if (method === "POST" && reviewMatch) {
      const body = (await readJson<{ decision?: string }>(req)) ?? {};
      if (body.decision !== "approve" && body.decision !== "decline") {
        return json(res, 400, { error: 'decision must be "approve" or "decline"' });
      }
      const engine = await engineFor(cwd, agent);
      const result = await engine.resolveReview(decodeURIComponent(reviewMatch[1]), body.decision);
      return json(res, result.resolved ? 200 : 404, result);
    }

    // ── Export / import ──────────────────────────────────────────────────────

    if (method === "GET" && path === "/v1/export") {
      const engine = await engineFor(cwd, agent);
      const rows = await engine.exportData(url.searchParams.get("collection") ?? undefined);
      if (!rows) return json(res, 501, { error: "export requires the SQLite backend" });
      return sendText(res, 200, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "application/x-ndjson");
    }

    if (method === "POST" && path === "/v1/import") {
      const body = (await readJson<{ jsonl?: string; force?: boolean }>(req)) ?? {};
      if (!body.jsonl?.trim()) return json(res, 400, { error: 'Usage: { "jsonl": "one JSON object per line" }' });
      const engine = await engineFor(cwd, agent);
      const rows: Array<Record<string, unknown>> = [];
      for (const line of body.jsonl.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          rows.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          return json(res, 400, { error: `invalid JSONL line: ${trimmed.slice(0, 80)}` });
        }
      }
      const result = await engine.importData(rows, !!body.force);
      if (!result) return json(res, 501, { error: "import requires the SQLite backend" });
      broadcast({ type: "imported", imported: result.imported, skipped: result.skipped });
      return json(res, 200, { ok: true, ...result });
    }

    // ── Connections (hooks install/status) ───────────────────────────────────

    if (method === "GET" && path === "/v1/connections") {
      return json(res, 200, { cwd, hooks: hooksStatus(cwd) });
    }

    if (method === "POST" && path === "/v1/connections") {
      const body = (await readJson<{ agent?: string; action?: string; cwd?: string }>(req)) ?? {};
      const targetCwd = body.cwd ?? cwd;
      const target = body.agent ?? "";
      if (!isAgentSupported(target)) return json(res, 400, { error: `unsupported agent "${target}"` });
      const result = body.action === "uninstall"
        ? uninstallHooks(target, targetCwd)
        : installHooks(target, targetCwd);
      broadcast({ type: "connection-updated", agent: target, action: body.action ?? "install" });
      return json(res, 200, { ok: true, ...result });
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    if (method === "GET" && path === "/v1/settings") {
      const config = loadConfig(cwd);
      return json(res, 200, {
        home: lorexHome(),
        storePath: storeDbPath(config.dataDir),
        dataDir: config.dataDir ?? null,
        port: actualPort,
        version: VERSION,
      });
    }

    if (method === "PATCH" && path === "/v1/settings") {
      const body = (await readJson<{ dataDir?: string | null; port?: number | null }>(req)) ?? {};
      if (body.dataDir !== undefined && body.dataDir !== null && typeof body.dataDir !== "string") {
        return json(res, 400, { error: "dataDir must be a string or null" });
      }
      if (body.port !== undefined && (typeof body.port !== "number" || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535)) {
        return json(res, 400, { error: "port must be an integer from 1 to 65535" });
      }
      if (body.dataDir !== undefined) saveConfig({ dataDir: body.dataDir ?? undefined });
      if (typeof body.port === "number") {
        saveConfig({ daemonPort: body.port });
      }
      broadcast({ type: "settings-updated" });
      return json(res, 200, { ok: true, restart_required: body.port !== undefined || body.dataDir !== undefined });
    }

    // ── Graph ────────────────────────────────────────────────────────────────

    if (method === "GET" && (path === "/graph" || path === "/v1/graph.json")) {
      const engine = await engineFor(cwd, agent);
      const q = url.searchParams.get("q") ?? url.searchParams.get("query") ?? undefined;
      const { graph } = await engine.graph({ query: q });
      if (path === "/v1/graph.json") return json(res, 200, graph);
      const identity = engine.getIdentity();
      return sendText(res, 200, renderGraphHtml(graph, {
        workspace: identity.workspace,
        database: identity.database,
        collection: identity.collection,
        query: q,
        liveUrl: "/v1/graph.json" + (q ? `?q=${encodeURIComponent(q)}` : ""),
        pollMs: 2500,
      }), "text/html; charset=utf-8");
    }

    // ── MCP over HTTP (stateless) ────────────────────────────────────────────

    if (path === "/mcp") {
      const body = method === "POST" ? await readJson<unknown>(req) : undefined;
      if (body !== undefined && body !== null && structuredElementCount(body) > MAX_MCP_INPUT_ELEMENTS) {
        return json(res, 413, { error: `MCP input has too many elements (max ${MAX_MCP_INPUT_ELEMENTS})` });
      }
      const engine = await engineFor(cwd, agent);
      const mcp = createMcpServer(engine);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body ?? undefined);
      return;
    }

    return json(res, 404, {
      error: "not found — see GET / for the console, /health, or the /v1 API",
      paths: [
        "/v1/status", "/v1/spaces", "/v1/memories", "/v1/knowledge", "/v1/context", "/v1/events",
        "/v1/reflect", "/v1/connections", "/v1/settings", "/v1/hooks/session-start",
        "/v1/hooks/stop", "/mcp",
      ],
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  const server = createHttpServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (error instanceof RateLimitError) {
        return json(res, 429, { error: error.message, reset_in_seconds: error.resetInSeconds });
      }
      json(res, 500, { error: (error as Error).message });
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of sseClients) {
      try { client.write(": ping\n\n"); } catch { sseClients.delete(client); }
    }
  }, 25_000);
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, resolve);
  });
  actualPort = (server.address() as AddressInfo).port;
  writeDaemonInfo({ pid: process.pid, port: actualPort, startedAt });

  const stop = async (): Promise<void> => {
    clearInterval(heartbeat);
    clearDaemonInfo(process.pid);
    for (const client of sseClients) {
      try { client.end(); } catch { /* already closed */ }
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const store of stores.values()) {
      try { store.close(); } catch { /* best effort */ }
    }
  };

  return { url: `http://${host}:${actualPort}`, port: actualPort, stop };
}
