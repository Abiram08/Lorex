/**
 * Daemon tests: singleton lock, spaces over the API, hook fast paths, console
 * assets, settings, and MCP over HTTP — all against a throwaway LOREX_HOME and
 * real SQLite, in-process (no spawning).
 */

import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemonService } from "../daemon/server.js";
import { readDaemonInfo, liveDaemon } from "../daemon/lock.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";

const home = mkdtempSync(join(tmpdir(), "lorex-daemon-home-"));
const project = mkdtempSync(join(tmpdir(), "lorex-daemon-project-"));
process.env.LOREX_HOME = home;
process.env.LOREX_NO_LIMITS = "1";

const daemon = await startDaemonService({ port: 0, cwd: project });
const base = daemon.url;

async function getJson(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`);
  assert.ok(res.ok, `GET ${path} → ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assert.ok(res.ok, `POST ${path} → ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

try {
  // ── Health + lock ─────────────────────────────────────────────────────────

  const health = await getJson("/health");
  assert.equal(health.ok, true, "health responds");
  const wrongHostStatus = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(`${base}/health`, { headers: { Host: "other.example" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(wrongHostStatus, 403, "loopback daemon rejects unexpected Host headers");
  const crossSite = await fetch(`${base}/v1/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: JSON.stringify({ text: "must never be stored" }),
  });
  assert.equal(crossSite.status, 403, "cross-site browser requests cannot mutate local memory");
  const sameSite = await fetch(`${base}/health`, { headers: { Origin: base } });
  assert.equal(sameSite.status, 200, "the local console origin remains allowed");

  const info = readDaemonInfo();
  assert.equal(info?.pid, process.pid, "lock records this process");
  assert.equal(info?.port, daemon.port, "lock records the actual port");
  assert.ok(liveDaemon(), "liveDaemon sees the running daemon");

  await assert.rejects(
    () => startDaemonService({ port: 0, cwd: project }),
    /already running/,
    "a second daemon refuses to start",
  );

  // ── Spaces ────────────────────────────────────────────────────────────────

  const spaces1 = (await getJson("/v1/spaces")) as {
    supported: boolean;
    current: string;
    spaces: Array<{ id: string; name: string; source: string }>;
  };
  assert.equal(spaces1.supported, true, "sqlite backend supports spaces");
  assert.ok(spaces1.spaces.some((s) => s.id === spaces1.current), "the project space was auto-registered");

  const created = await postJson("/v1/spaces", { name: "checkout", description: "checkout flows" });
  assert.equal(created.id, "ws_checkout", "space id is namespaced");

  const patch = await fetch(`${base}/v1/spaces/ws_checkout`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Checkout" }),
  });
  assert.ok(patch.ok, "space rename works");
  const spaces2 = (await getJson("/v1/spaces")) as { spaces: Array<{ id: string; name: string; source: string }> };
  const renamed = spaces2.spaces.find((s) => s.id === "ws_checkout");
  assert.equal(renamed?.name, "Checkout");
  assert.equal(renamed?.source, "user", "renaming claims the space");

  // ── Memories over the API ─────────────────────────────────────────────────

  const added = await postJson("/v1/memories", {
    text: "Daemon storage uses SQLite WAL because concurrent hooks write often",
  });
  assert.equal(added.ok, true, "remember works through the daemon");

  const learned = await postJson("/v1/knowledge", {
    content: "The operations guide says to inspect the local SQLite store before changing daemon settings.",
    sourceRef: "operations-guide",
  });
  assert.equal(learned.ok, true, "console can store source text through the daemon");
  const knowledge = (await getJson("/v1/memories?type=knowledge")) as { sources: Array<{ excerpt?: string }> };
  assert.ok(knowledge.sources.some((source) => source.excerpt?.includes("operations guide")), "stored source text is browsable");

  const search = (await postJson("/v4/search", { query: "what does daemon storage use?" })) as {
    answer?: string;
    sources?: Array<{ excerpt?: string }>;
  };
  const found = (search.answer ?? "").includes("SQLite") ||
    (search.sources ?? []).some((s) => (s.excerpt ?? "").includes("SQLite"));
  assert.ok(found, "recall finds the memory through the daemon");

  // ── Hook fast paths ───────────────────────────────────────────────────────

  const pack = await (await fetch(`${base}/v1/context/plain`)).text();
  assert.ok(pack.includes("SQLite"), "snapshot context pack includes the recent fact");

  const hook = (await postJson("/v1/hooks/session-start", { cwd: project })) as { text?: string; tokens?: number };
  assert.ok((hook.text ?? "").includes("SQLite"), "session-start returns the injectable pack");
  const missingCapture = await fetch(`${base}/v1/hooks/stop`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  assert.equal(missingCapture.status, 400, "stop does not report a queued capture without session evidence");
  const queuedCapture = await postJson("/v1/hooks/stop", {
    cwd: project, agent: "codex", sessionId: "daemon-test-session",
    prompt: "We decided to use append-only task events for concurrent agents.",
    response: "Recorded the task event design.",
  });
  assert.equal(queuedCapture.queued, true);
  let captured = false;
  for (let i = 0; i < 20; i++) {
    const result = await getJson("/v1/memories?query=append-only%20task%20events");
    captured = JSON.stringify(result).includes("append-only task events");
    if (captured) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(captured, "daemon hook payload is actually captured");
  assert.ok(typeof hook.tokens === "number", "session-start reports token cost");

  const compact = await postJson("/v1/hooks/pre-compact", {
    cwd: project, agent: "codex", sessionId: "daemon-compact-session",
    prompt: "We decided to preserve pre-compact user decisions.", response: "Recorded.",
  });
  assert.equal(compact.queued, true, "pre-compact hook enqueues supplied evidence");

  // ── Console assets ────────────────────────────────────────────────────────

  const html = await fetch(`${base}/`);
  assert.equal(html.status, 200);
  assert.ok(html.headers.get("content-security-policy")?.includes("default-src 'self'"), "console has a content policy");
  assert.ok((await html.text()).includes("Lorex — Local console"), "console page is served");
  assert.equal((await fetch(`${base}/app.js`)).status, 200, "console app is served");
  assert.equal((await fetch(`${base}/styles.css`)).status, 200, "console styles are served");

  // ── Status, reviews, settings ─────────────────────────────────────────────

  const status = (await getJson("/v1/status")) as {
    ok: boolean;
    currentMemories: number;
    spaces: { current: { id: string } | null };
  };
  assert.equal(status.ok, true);
  assert.ok(status.currentMemories >= 1, "status counts the current space's memories");
  assert.ok(status.spaces.current, "status reports the current space");

  const reviews = (await getJson("/v1/reviews")) as { items: unknown[] };
  assert.deepEqual(reviews.items, [], "review queue starts empty");
  const reviewStore = new SqliteStore({ path: join(home, "local-store.db") });
  reviewStore.enqueueReview({
    id: "daemon_review",
    collection: status.spaces.current!.id,
    kind: "dream",
    confidence: 0.7,
    payload: { text: "Potential learned preference", factKey: "dream_daemon_review", memoryType: "preference", confidence: 0.7, source: "frequency", sourceIds: [] },
  });
  reviewStore.close();
  assert.equal(((await getJson("/v1/reviews")) as { items: unknown[] }).items.length, 1, "review endpoint exposes pending learning");
  assert.equal((await postJson("/v1/reviews/daemon_review", { decision: "decline" })).resolved, true, "review endpoint resolves a proposal");
  assert.equal(((await getJson("/v1/reviews")) as { items: unknown[] }).items.length, 0, "resolved review leaves the pending queue");

  const settings = await getJson("/v1/settings");
  assert.ok(typeof settings.storePath === "string" && (settings.storePath as string).includes(home), "settings shows the isolated store path");

  // ── MCP over HTTP ─────────────────────────────────────────────────────────

  const mcpRes = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "daemon-test", version: "0" } },
    }),
  });
  assert.equal(mcpRes.status, 200, `MCP initialize → ${mcpRes.status}`);
  const mcpText = await mcpRes.text();
  assert.ok(mcpText.includes("protocolVersion") || mcpText.includes("serverInfo"), "MCP initialize responds with a handshake");

  const oversizedMcp = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "remember", arguments: { values: Array.from({ length: 10_001 }, () => 1) } },
    }),
  });
  assert.equal(oversizedMcp.status, 413, "MCP rejects structurally oversized input before schema validation");

  const nextDir = join(home, "next-store");
  const changeDir = await fetch(`${base}/v1/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataDir: nextDir }),
  });
  assert.equal(changeDir.status, 200);
  assert.equal((await changeDir.json() as { restart_required: boolean }).restart_required, true, "changing the data directory requires restart");

  console.log("✓ daemon tests passed");
} finally {
  await daemon.stop();
  assert.equal(readDaemonInfo(), null, "stop clears the lock");
  // Never leak test homes into the OS temp dir.
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
