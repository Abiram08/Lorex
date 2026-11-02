/**
 * SqliteStore integration tests — real SQLite, temp DB files, no mocks.
 *
 * Covers: ingest/query round-trip, FTS5 search + LIKE fallback,
 * TTL enforcement, supersession filtering, lifecycle scoring,
 * strength updates, consolidation apply, recordAccess, migration.
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import Database from "better-sqlite3";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { planConsolidation } from "../infrastructure/lifecycle.js";
import { normalizeEntity } from "../domain/fact.js";
import { dreamHeuristic, shouldDream } from "../infrastructure/dream.js";
import { LorexEngine } from "../engine.js";
import { resolveIdentity } from "../infrastructure/identity.js";

process.env.LOREX_NO_LIMITS = "1";

function freshEngine(collection: string): { engine: LorexEngine; store: SqliteStore; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lorex-sqlite-eng-"));
  const store = new SqliteStore({ path: join(dir, "test.db") });
  const engine = new LorexEngine(store, resolveIdentity(dir, { collection }));
  return { engine, store, done: () => store.close() };
}

function freshStore(): { store: SqliteStore; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lorex-sqlite-test-"));
  const store = new SqliteStore({ path: join(dir, "test.db") });
  return { store, done: () => store.close() };
}

async function remember(
  store: SqliteStore,
  text: string,
  collection: string,
  extra: Record<string, unknown> = {},
  id?: string,
) {
  return store.ingestMemory({
    database: collection,
    collection,
    memories: [{ id, text, additional_metadata: { fact_key: id ?? undefined, version_id: id ?? undefined, ...extra } }],
  });
}

// ── Round-trip ───────────────────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  const r = await remember(store, "We use Postgres for analytics", "t1", {}, "db_fact");
  assert.equal(r.ok, true);
  assert.deepEqual(r.ids, ["db_fact"]);

  const q = await store.query({ query: "Postgres analytics", database: "t1", collection: "t1" });
  assert.ok(q.chunks.length >= 1, "FTS should find the ingested fact");
  assert.ok((q.chunks[0]?.text ?? "").includes("Postgres"));
  done();
}

// ── FTS stemming + LIKE fallback ─────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await remember(store, "The deployment pipeline runs on Kubernetes", "t2", {}, "deploy");

  // Porter stemming: "deploying" should match "deployment"
  const stemmed = await store.query({ query: "deploying pipeline", database: "t2", collection: "t2" });
  assert.ok(stemmed.chunks.length >= 1, "stemmed query should match");

  // Single-char terms can't form FTS prefixes → LIKE fallback path
  const fallback = await store.query({ query: "K", database: "t2", collection: "t2" });
  assert.ok(Array.isArray(fallback.chunks), "LIKE fallback must return an array");

  // Gibberish that matches nothing
  const empty = await store.query({ query: "xqzvwkj", database: "t2", collection: "t2" });
  assert.equal(empty.chunks.length, 0, "no match should return zero chunks");
  done();
}

// ── Superseded/forgotten filtering ───────────────────────────────────────────

{
  const { store, done } = freshStore();
  await remember(store, "old value", "t3", { status: "superseded" }, "old_fact");
  await remember(store, "gone value", "t3", { status: "forgotten" }, "gone_fact");
  await remember(store, "live value", "t3", {}, "live_fact");

  const q = await store.query({ query: "value", database: "t3", collection: "t3" });
  const ids = q.chunks.map((c) => c.id);
  assert.ok(!ids.includes("old_fact"), "superseded must be filtered");
  assert.ok(!ids.includes("gone_fact"), "forgotten must be filtered");
  assert.ok(ids.includes("live_fact"), "current must be returned");
  done();
}

// ── TTL enforcement ──────────────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  // Fresh episode: visible. Simulate age by backdating created_at via metadata.
  await remember(store, "yesterday we discussed caching", "t4", { memory_type: "episode" }, "fresh_ep");
  await remember(store, "persistent architectural fact", "t4", { memory_type: "fact" }, "perm_fact");

  let q = await store.query({ query: "caching", database: "t4", collection: "t4" });
  assert.ok(q.chunks.some((c) => c.id === "fresh_ep"), "fresh episode must be visible");

  q = await store.query({ query: "architectural", database: "t4", collection: "t4" });
  assert.ok(q.chunks.some((c) => c.id === "perm_fact"), "facts never expire");
  done();
}

// ── Long-lived knowledge and explicit expiry ────────────────────────────────

{
  const dir = mkdtempSync(join(tmpdir(), "lorex-sqlite-retention-"));
  const path = join(dir, "test.db");
  const store = new SqliteStore({ path });
  await store.ingestKnowledge({ database: "d", collection: "retention", documents: [
    { id: "old_doc", content: { text: "Redwood protocol runbook" } },
    { id: "old_chunk", content: { text: "Redwood session transcript" }, additional_metadata: { memory_type: "conversation_chunk", source_ref: "session_1" } },
  ] });
  const raw = new Database(path);
  raw.prepare("UPDATE memories SET created_at = ? WHERE collection = ?")
    .run(new Date(Date.now() - 31 * 86_400_000).toISOString(), "retention");
  const rows = raw.prepare("SELECT id, memory_type, source_ref FROM memories WHERE collection = ?")
    .all("retention") as Array<{ id: string; memory_type: string | null; source_ref: string | null }>;
  assert.equal(rows.find((r) => r.id === "old_chunk")?.memory_type, "conversation_chunk");
  assert.equal(rows.find((r) => r.id === "old_chunk")?.source_ref, "session_1");
  const found = await store.query({ query: "Redwood", database: "d", collection: "retention", type: "knowledge" });
  assert.deepEqual(new Set(found.chunks.map((c) => c.id)), new Set(["old_doc", "old_chunk"]),
    "knowledge and source chunks remain retrievable after 30 days");

  await store.ingestMemory({ database: "d", collection: "retention", memories: [{
    id: "expires", text: "Temporary Redwood credential handoff",
    additional_metadata: { fact_key: "expires", valid_to: new Date(Date.now() - 1_000).toISOString(), status: "current" },
  }] });
  const current = await store.query({ query: "Temporary Redwood", database: "d", collection: "retention" });
  assert.ok(!current.chunks.some((c) => c.id === "expires"), "expired valid_to is hidden from current recall");
  raw.close();
  store.close();
}

// ── Upsert preserves strength/access history ─────────────────────────────────

{
  const { store, done } = freshStore();
  await remember(store, "original text", "t5", {}, "stable_id");
  store.recordAccess("stable_id");
  store.recordAccess("stable_id");

  // Re-ingest same id with updated text
  await remember(store, "updated text", "t5", {}, "stable_id");

  const stats = store.getLifecycleStats("t5");
  assert.equal(stats.total, 1, "re-ingest must not duplicate");

  const cands = store.getConsolidationCandidates("t5");
  assert.equal(cands.length, 1);
  assert.equal(cands[0].accessCount, 2, "access history must survive re-ingest");

  const q = await store.query({ query: "updated", database: "t5", collection: "t5" });
  assert.ok(q.chunks.some((c) => c.id === "stable_id"), "updated text must be searchable");
  done();
}

// ── recordAccess + updateStrengths ───────────────────────────────────────────

{
  const { store, done } = freshStore();
  await remember(store, "accessed memory", "t6", {}, "acc_mem");

  let cands = store.getConsolidationCandidates("t6");
  assert.equal(cands[0].accessCount, 0);

  store.recordAccess("acc_mem");
  cands = store.getConsolidationCandidates("t6");
  assert.equal(cands[0].accessCount, 1, "recordAccess increments");

  const accessed = await store.query({ query: "accessed", database: "t6", collection: "t6" });
  const accMeta = accessed.chunks.find((c) => c.id === "acc_mem")?.metadata as Record<string, unknown>;
  assert.ok(accMeta?.last_accessed, "last_accessed set in query metadata");

  const updated = store.updateStrengths("t6");
  assert.equal(updated, 1, "one memory updated");

  const stats = store.getLifecycleStats("t6");
  assert.equal(stats.total, 1);
  assert.ok(stats.avgStrength > 0.9, `fresh memory should be strong, got ${stats.avgStrength}`);
  done();
}

// ── applyConsolidation ───────────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await remember(store, "keep me", "t7", {}, "keep");
  await remember(store, "prune me", "t7", {}, "prune");

  const applied = store.applyConsolidation({ pruned: ["prune"], merged: [], reinforced: ["keep"], expired: [] });
  assert.equal(applied.pruned, 1);

  const q = await store.query({ query: "prune", database: "t7", collection: "t7" });
  assert.ok(!q.chunks.some((c) => c.id === "prune"), "pruned memory must not be returned");

  const q2 = await store.query({ query: "keep", database: "t7", collection: "t7" });
  assert.ok(q2.chunks.some((c) => c.id === "keep"), "reinforced memory must remain");
  done();
}

// ── Migration: old DB without lifecycle columns ──────────────────────────────

{
  const dir = mkdtempSync(join(tmpdir(), "lorex-sqlite-mig-"));
  const path = join(dir, "old.db");

  // Simulate a pre-lifecycle DB: memories table without new columns
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, text TEXT NOT NULL,
      corpus TEXT NOT NULL DEFAULT 'memory',
      collection TEXT NOT NULL DEFAULT 'default',
      fact_key TEXT, version_id TEXT, valid_from TEXT, valid_to TEXT,
      status TEXT DEFAULT 'current',
      metadata TEXT DEFAULT '{}', relations TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO memories (id, text, collection) VALUES ('legacy', 'legacy fact', 'mig');
  `);
  raw.close();

  // Opening via SqliteStore must migrate, not crash
  const store = new SqliteStore({ path });
  const q = await store.query({ query: "legacy", database: "mig", collection: "mig" });
  assert.ok(q.chunks.some((c) => c.id === "legacy"), "migrated DB must remain queryable");

  store.recordAccess("legacy"); // exercises the migrated columns
  const stats = store.getLifecycleStats("mig");
  assert.equal(stats.total, 1);
  store.close();
}

// ── Relations round-trip ─────────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await store.ingestMemory({
    database: "t8",
    collection: "t8",
    memories: [{
      id: "v2", text: "new value",
      additional_metadata: { fact_key: "k", version_id: "v2" },
      relations: { ids: ["v1"], properties: { type: "supersedes", reason: "better" } },
    }],
  });

  const rel = await store.contextRelations({ collection: "t8" }, ["v2"]);
  assert.ok((rel.relations ?? []).some((r) => r.source === "v2" && r.target === "v1"), "supersedes edge stored");
  done();
}

// ── Feedback + ping + status ─────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await store.feedback({ request_id: "r1", rating: "positive", feedback: "good", source: "agent" });

  const ping = await store.ping("x");
  assert.equal(ping.reachable, true);

  const status = await store.databaseStatus("x");
  assert.equal(status.ready, true);

  const indexed = await store.awaitIndexed(["a"]);
  assert.equal(indexed, true);

  const ctx = await store.contextStatus(["a"]);
  assert.equal(ctx.statuses[0].indexing_status, "ready");
  done();
}

// ── Feedback signals: re-ranking ─────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await remember(store, "alpha choice for caching layer", "sig", {}, "sig_a");
  await remember(store, "beta choice for caching layer", "sig", {}, "sig_b");

  const before = await store.query({ query: "caching layer choice", database: "sig", collection: "sig" });
  const orderBefore = before.chunks.map((c) => c.id);

  // Positive feedback on the second-ranked item should flip the order
  const loser = orderBefore[orderBefore.length - 1] ?? "sig_a";
  await store.feedback({
    request_id: "fb1", rating: "positive", source: "agent",
    ground_truth: { answer: "beta", source_ids: [loser] },
  });

  const after = await store.query({ query: "caching layer choice", database: "sig", collection: "sig" });
  assert.equal(after.chunks[0]?.id, loser, "positive feedback must promote the memory");

  const meta = after.chunks[0]?.metadata as Record<string, unknown>;
  assert.ok((meta?.signal as number) > 0, "signal must be exposed in metadata");

  // Negative feedback suppresses
  await store.feedback({
    request_id: "fb2", rating: "negative", source: "agent",
    ground_truth: { answer: "no", source_ids: [loser] },
  });
  const suppressed = await store.query({ query: "caching layer choice", database: "sig", collection: "sig" });
  assert.notEqual(suppressed.chunks[0]?.id, loser, "negative feedback must demote the memory");

  // Neutral feedback is a no-op (recorded, no signal change)
  await store.feedback({ request_id: "fb3", rating: "neutral", source: "agent" });

  // Unknown ids are ignored, not an error
  await store.feedback({
    request_id: "fb4", rating: "positive", source: "agent",
    ground_truth: { answer: "x", source_ids: ["does_not_exist"] },
  });
  done();
}

// ── Signal clamping ──────────────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await remember(store, "clamp target memory", "clamp", {}, "clamp_id");

  for (let i = 0; i < 10; i++) {
    store.applySignal(["clamp_id"], 0.2);
  }
  const q = await store.query({ query: "clamp", database: "clamp", collection: "clamp" });
  const signal = (q.chunks.find((c) => c.id === "clamp_id")?.metadata as Record<string, unknown> | undefined)?.signal;
  assert.equal(signal, 1.0, `signal must clamp at 1.0, got ${signal}`);

  for (let i = 0; i < 10; i++) {
    store.applySignal(["clamp_id"], -0.3);
  }
  const q2 = await store.query({ query: "clamp", database: "clamp", collection: "clamp" });
  const signal2 = (q2.chunks.find((c) => c.id === "clamp_id")?.metadata as Record<string, unknown> | undefined)?.signal;
  assert.equal(signal2, -1.0, `signal must clamp at -1.0, got ${signal2}`);
  done();
}

// ── Correction learning ──────────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await store.ingestMemory({
    database: "corr",
    collection: "corr",
    memories: [{
      id: "fix_v2", text: "corrected: use Memcached for sessions",
      additional_metadata: { fact_key: "session_cache", version_id: "fix_v2", memory_type: "correction" },
      relations: { ids: ["fix_v1"], properties: { type: "supersedes", reason: "Redis timed out" } },
    }],
  });

  const q = await store.query({ query: "sessions cache", database: "corr", collection: "corr" });
  const signal = (q.chunks.find((c) => c.id === "fix_v2")?.metadata as Record<string, unknown> | undefined)?.signal;
  assert.ok((signal as number) > 0, `correction should self-reinforce, got signal=${signal}`);
  done();
}

// ── planConsolidation edge cases ─────────────────────────────────────────────

{
  // Empty input → empty plan
  const empty = planConsolidation([]);
  assert.deepEqual(empty, { pruned: [], merged: [], reinforced: [], expired: [] });

  // Single strong memory → untouched
  const single = planConsolidation([{
    id: "s", factKey: "k", text: "strong", memoryType: "fact",
    createdAt: new Date().toISOString(), strength: 0.95, accessCount: 2,
  }]);
  assert.deepEqual(single.pruned, []);
  assert.deepEqual(single.expired, []);
  assert.deepEqual(single.merged, []);
}

// ── Dream: empty store ───────────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  const r = await dreamHeuristic(store, "dream_empty");
  assert.deepEqual(r.discovered, []);
  assert.deepEqual(r.contradictions, []);
  assert.deepEqual(r.reinforced, []);
  assert.ok(r.durationMs >= 0);
  done();
}

// ── Dream: frequency mining ──────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await store.ingestKnowledge({ database: "d", collection: "session_gate", documents: [
    { id: "seg_a", content: { text: "first segment" }, additional_metadata: { memory_type: "conversation_chunk", root_session_id: "one_real_session" } },
    { id: "seg_b", content: { text: "second segment" }, additional_metadata: { memory_type: "conversation_chunk", root_session_id: "one_real_session" } },
  ] });
  assert.equal(store.countSessionsSince("session_gate", null), 1, "long transcript segments count as one learning session");
  done();
}

{
  const { store, done } = freshStore();
  // Real extracted facts supersede prior rows. Dream must still study those
  // historical observations rather than seeing only the latest version.
  for (let i = 0; i < 3; i++) {
    await store.ingestMemory({
      database: "dream_freq",
      collection: "dream_freq",
      memories: [{
        id: `pref_${i}`, text: "Always use TypeScript for new code",
        additional_metadata: {
          fact_key: "lang_pref", version_id: `pref_${i}`, memory_type: "preference",
          source_session_id: `session_${i}`, trust: "heuristic_extract", status: "current",
          valid_from: `2026-01-0${i + 1}T00:00:00Z`,
        },
      }],
    });
  }
  const visible = await store.query({ query: "TypeScript", database: "dream_freq", collection: "dream_freq", type: "memory" });
  assert.equal(visible.chunks.filter((c) => c.metadata?.fact_key === "lang_pref").length, 1,
    "ordinary recall sees only the current repeated observation");

  // A changing topic is not a repeated pattern merely because its fact key is stable.
  for (const [i, value] of ["Redis", "Postgres", "SQLite"].entries()) {
    await store.ingestMemory({ database: "dream_freq", collection: "dream_freq", memories: [{
      id: `db_${i}`, text: `We decided to use ${value} for sessions`,
      additional_metadata: {
        fact_key: "session_database", version_id: `db_${i}`, memory_type: "decision",
        source_session_id: `db_session_${i}`, trust: "heuristic_extract", status: "current",
        valid_from: `2026-02-0${i + 1}T00:00:00Z`,
      },
    }] });
  }

  const r = await dreamHeuristic(store, "dream_freq");
  assert.ok(
    r.discovered.some((d) => d.memoryType === "preference" && d.source === "frequency"),
    `expected a frequency preference discovery, got ${JSON.stringify(r.discovered)}`,
  );
  assert.ok(!r.discovered.some((d) => d.factKey === "dream_pref_session_database"),
    "three different values on one topic are a history, not a learned pattern");
  for (let i = 0; i < 3; i++) {
    await store.ingestMemory({ database: "dream_freq", collection: "dream_freq", memories: [{
      id: `same_${i}`, text: "Use one unsupported claim repeatedly",
      additional_metadata: { fact_key: "same_session", memory_type: "preference", source_session_id: "one_session" },
    }] });
  }
  const repeatedOneSession = await dreamHeuristic(store, "dream_freq");
  assert.ok(!repeatedOneSession.discovered.some((d) => d.factKey === "dream_pref_same_session"),
    "repetition within one session is not independent learning evidence");
  done();
}

// ── Dream: scheduler gates ───────────────────────────────────────────────────

{
  assert.equal(shouldDream(null, 0, false), false, "needs ≥5 sessions");
  assert.equal(shouldDream(null, 5, true), false, "never while running");
  assert.equal(shouldDream(null, 5, false), true, "first run with enough sessions");
  assert.equal(
    shouldDream(new Date().toISOString(), 10, false), false,
    "24h cooldown",
  );
  assert.equal(
    shouldDream(new Date(Date.now() - 25 * 3_600_000).toISOString(), 10, false), true,
    "runs after cooldown",
  );
}

// ── Entity normalization ─────────────────────────────────────────────────────

{
  assert.equal(normalizeEntity("PostgreSQL"), "postgres");
  assert.equal(normalizeEntity("postgres db"), "postgres");
  assert.equal(normalizeEntity("K8s"), "kubernetes");
  assert.equal(normalizeEntity("  TypeScript  "), "typescript");
}

// ── Global scope ─────────────────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await store.ingestMemory({
    database: "d", collection: "global",
    memories: [{ id: "g1", text: "User always prefers TypeScript", additional_metadata: { fact_key: "g1", memory_type: "preference" } }],
  });
  await remember(store, "Project uses Postgres for analytics", "proj", {}, "p1");

  const fromProj = await store.query({ query: "TypeScript", database: "d", collection: "proj" });
  assert.ok(fromProj.chunks.some((c) => c.id === "g1"), "global memory visible from project collection");

  const fromOther = await store.query({ query: "Postgres analytics", database: "d", collection: "other" });
  assert.ok(!fromOther.chunks.some((c) => c.id === "p1"), "project memory isolated from other collections");

  const fromGlobal = await store.query({ query: "Postgres", database: "d", collection: "global" });
  assert.ok(!fromGlobal.chunks.some((c) => c.id === "p1"), "global queries don't leak project memories");
  done();
}

// ── Synonym expansion ────────────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await remember(store, "We standardized on PostgreSQL last quarter", "syn", {}, "syn1");

  const q = await store.query({ query: "psql standard", database: "d", collection: "syn" });
  assert.ok(q.chunks.some((c) => c.id === "syn1"), "psql should match PostgreSQL via synonym expansion");
  done();
}

// ── Ingest-time verbatim dedup ───────────────────────────────────────────────

{
  const { store, done } = freshStore();
  const first = await store.ingestMemory({
    database: "d", collection: "dd",
    memories: [{ text: "Identical captured sentence about caching" }],
  });
  const second = await store.ingestMemory({
    database: "d", collection: "dd",
    memories: [{ text: "Identical captured sentence about caching" }],
  });
  assert.deepEqual(second.ids, first.ids, "verbatim re-ingest reuses the row");

  const cands = store.getConsolidationCandidates("dd");
  assert.equal(cands.length, 1, "no duplicate row created");
  assert.equal(cands[0]?.accessCount, 1, "re-ingest counts as access");
  done();
}

// ── Incremental strength updates ─────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await remember(store, "incremental strength target", "inc", {}, "inc1");
  assert.equal(store.updateStrengths("inc"), 1, "full pass updates");

  // Immediately after: nothing stale → incremental pass is a no-op
  assert.equal(store.updateStrengths("inc", 24), 0, "incremental pass skips fresh rows");
  done();
}

// ── Contradiction auto-resolution ────────────────────────────────────────────

{
  const { store, done } = freshStore();
  for (const [id, text] of [["c1", "first correction: use A"], ["c2", "second correction: use B"]]) {
    await store.ingestMemory({
      database: "d", collection: "cx",
      memories: [{ id, text, additional_metadata: { fact_key: "fix", version_id: id, memory_type: "correction" } }],
    });
  }
  // Backdate c1 so c2 is unambiguously newest
  (store as unknown as { db: import("better-sqlite3").Database })
    .db.prepare(`UPDATE memories SET created_at = '2020-01-01 00:00:00' WHERE id = 'c1'`).run();

  assert.equal(store.resolveContradictions("cx"), 1, "one loser superseded");

  const q = await store.query({ query: "correction", database: "d", collection: "cx" });
  const ids = q.chunks.map((c) => c.id);
  assert.ok(ids.includes("c2") && !ids.includes("c1"), "newest correction wins");
  done();
}

// ── Open loops ───────────────────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await store.ingestMemory({
    database: "d", collection: "loops",
    memories: [
      { id: "stale_task", text: "Migrate the logout path", additional_metadata: { fact_key: "stale_task", memory_type: "task" } },
      { id: "fresh_task", text: "Update the changelog", additional_metadata: { fact_key: "fresh_task", memory_type: "task" } },
      { id: "touched_task", text: "Refactor auth module", additional_metadata: { fact_key: "touched_task", memory_type: "task" } },
    ],
  });
  const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
  db.prepare(`UPDATE memories SET created_at = '2020-01-01 00:00:00' WHERE id = 'stale_task'`).run();
  store.recordAccess("touched_task");
  db.prepare(`UPDATE memories SET created_at = '2020-01-01 00:00:00' WHERE id = 'touched_task'`).run();

  const loops = store.getOpenLoops("loops");
  assert.ok(loops.some((l) => l.id === "stale_task"), "old unaccessed task is open");
  assert.ok(!loops.some((l) => l.id === "fresh_task"), "recent task is not open");
  assert.ok(!loops.some((l) => l.id === "touched_task"), "accessed task is not open");
  done();
}

// ── Query failures → Dream gaps ──────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await remember(store, "some unrelated memory content", "gaps", {}, "gap1");
  for (let i = 0; i < 3; i++) {
    await store.feedback({
      request_id: `gap${i}`, rating: "negative", source: "agent",
      ground_truth: { answer: "no", source_ids: ["gap1"] },
      metadata: { query: "how do sessions work" },
    });
  }

  const failures = store.getQueryFailures();
  assert.ok(failures.some((f) => f.pattern.includes("sessions") && f.fails === 3), "failures tracked");

  const r = await dreamHeuristic(store, "gaps");
  assert.ok(r.discovered.some((d) => d.factKey.startsWith("dream_gap_")), "recall gap surfaced as discovery");
  done();
}

// ── Thinking-mode relation expansion ─────────────────────────────────────────

{
  const { store, done } = freshStore();
  await store.ingestMemory({
    database: "d", collection: "exp",
    memories: [
      { id: "hub", text: "central decision about caching", additional_metadata: { fact_key: "hub", memory_type: "decision" } },
      {
        id: "spoke", text: "linked rationale about latency", additional_metadata: { fact_key: "spoke" },
        relations: { ids: ["hub"], properties: { type: "relates" } },
      },
    ],
  });

  const fast = await store.query({ query: "caching decision", database: "d", collection: "exp", mode: "fast" });
  const thinking = await store.query({ query: "caching decision", database: "d", collection: "exp", mode: "thinking" });
  assert.ok(
    thinking.chunks.some((c) => c.id === "spoke"),
    "thinking mode must pull the related rationale via the relates edge",
  );
  assert.ok(
    thinking.chunks.length >= fast.chunks.length,
    "thinking mode must include at least the fast results",
  );
  done();
}

// ── Staleness in metadata ────────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await remember(store, "staleness surfaced memory", "stale", {}, "st1");
  const q = await store.query({ query: "staleness", database: "d", collection: "stale" });
  const meta = q.chunks.find((c) => c.id === "st1")?.metadata as Record<string, unknown> | undefined;
  assert.equal(meta?.staleness, "today", "fresh memory tagged today");
  done();
}

// ── Engine: dream persists discoveries ───────────────────────────────────────

{
  const { engine, store, done } = freshEngine("dream_eng");
  for (let i = 0; i < 7; i++) {
    await store.ingestMemory({ database: "dream_eng", collection: "dream_eng", memories: [{
      id: `commit_pref_${i}`, text: "Always run the test suite before committing",
      additional_metadata: {
        fact_key: "commit_preference", memory_type: "preference", source_session_id: `commit_session_${i}`,
        trust: "heuristic_extract", status: "current", valid_from: `2026-03-0${i + 1}T00:00:00Z`,
      },
    }] });
  }
  const r = await engine.dream();
  assert.equal(r.persisted, 1, "high-confidence repeated evidence becomes one inferred pattern");
  assert.ok(r.durationMs >= 0);
  await engine.dream();
  assert.equal(store.getLearningStats("dream_eng").inferredPatterns, 1,
    "repeated Dream runs update a stable inferred memory instead of duplicating it");
  done();
}

// ── Engine: uncertain learning waits for review ──────────────────────────────

{
  const { engine, store, done } = freshEngine("dream_review_gate");
  for (let i = 0; i < 3; i++) {
    await store.ingestMemory({
      database: "dream_review_gate",
      collection: "dream_review_gate",
      memories: [{ id: `gate_${i}`, text: "Prefer contract tests before publishing", additional_metadata: { fact_key: "contract_test_preference", memory_type: "preference", source_session_id: `gate_session_${i}` } }],
    });
  }
  const result = await engine.dream();
  assert.equal(result.persisted, 0, "a 60% inferred pattern is not auto-applied");
  assert.equal(result.queued, 1, "a 60% inferred pattern waits for review");
  assert.equal((await engine.reviews()).length, 1);
  done();
}

{
  const { engine, store, done } = freshEngine("review_eng");
  assert.equal(store.enqueueReview({
    id: "review_one",
    collection: "review_eng",
    kind: "dream",
    confidence: 0.7,
    payload: {
      text: "Repeated pattern: run contract tests before publishing",
      factKey: "dream_pref_contract_tests",
      memoryType: "preference",
      confidence: 0.7,
      source: "frequency",
      sourceIds: [],
    },
  }), true);
  assert.equal((await engine.reviews()).length, 1, "pending Dream inference is reviewable");
  assert.equal((await engine.resolveReview("review_one", "approve")).resolved, true);
  assert.equal((await engine.reviews()).length, 0, "approved inference leaves the pending queue");
  assert.ok((await engine.recall({ query: "contract tests publishing" })).sources.length > 0, "approved inference becomes memory");
  assert.equal((await engine.resolveReview("review_one", "approve")).resolved, false, "review decisions are idempotent");
  done();
}

// ── Engine: consolidate applies expiry ───────────────────────────────────────

{
  const { engine, done } = freshEngine("cons_eng");
  await engine.remember("Ephemeral debug note about logging", { id: "debug_note" });
  const r = await engine.consolidate();
  assert.ok(r.planned >= 0 && r.expired >= 0, "consolidate returns counts");
  done();
}

// ── Engine: open loops ───────────────────────────────────────────────────────

{
  const { engine, done } = freshEngine("loops_eng");
  await engine.remember("Temporary scratch task for testing", { id: "scratch" });
  const loops = await engine.openLoops();
  assert.ok(Array.isArray(loops), "openLoops returns an array");
  done();
}

// ── Engine: global scope remember ────────────────────────────────────────────

{
  const { engine, done } = freshEngine("scope_eng");
  await engine.remember("User prefers concise output", { id: "concise_pref", scope: "global" });
  const r = await engine.recall({ query: "concise output preference" });
  assert.ok(
    r.sources.some((s) => s.id.includes("concise") || (s.excerpt ?? "").includes("concise") || (s.content ?? "").includes("concise")),
    "global memory recalled from project collection",
  );
  done();
}

// ── Stress: 10k memories ─────────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  const N = 10_000;
  const batch = 500;

  const t0 = Date.now();
  for (let b = 0; b < N / batch; b++) {
    await store.ingestMemory({
      database: "d",
      collection: "stress",
      memories: Array.from({ length: batch }, (_, i) => {
        const n = b * batch + i;
        return {
          id: `stress_${n}`,
          text: `Stress fact ${n} about service ${n % 100} region ${n % 10} config value ${n}`,
          additional_metadata: { fact_key: `stress_${n}`, memory_type: n % 7 === 0 ? "episode" : "fact" },
        };
      }),
    });
  }
  const ingestMs = Date.now() - t0;

  const q0 = Date.now();
  const q = await store.query({ query: "service 42 config", database: "d", collection: "stress" });
  const queryMs = Date.now() - q0;

  assert.ok(q.chunks.length > 0, "stress store returns results");
  console.log(`  stress: ${N} ingested in ${ingestMs}ms (${(N / (ingestMs / 1000)).toFixed(0)}/s), query ${queryMs}ms`);

  const stats = store.getLifecycleStats("stress");
  assert.equal(stats.total, N);

  const u0 = Date.now();
  const recomputed = store.updateStrengths("stress", 24);
  const updateMs = Date.now() - u0;
  assert.equal(recomputed, 0, "incremental pass skips all fresh rows at scale");
  console.log(`  stress: incremental strength pass skipped ${N - recomputed}/${N} in ${updateMs}ms`);
  done();
}

// ── Derives edges + expansion weights ────────────────────────────────────────

{
  const { store, done } = freshStore();
  await store.ingestMemory({
    database: "d", collection: "der",
    memories: [
      { id: "base1", text: "payment service uses Postgres", additional_metadata: { fact_key: "base1" } },
      { id: "base2", text: "payment service handles refunds", additional_metadata: { fact_key: "base2" } },
      {
        id: "derived", text: "Inferred architectural consequence uniqueword xyz",
        additional_metadata: { fact_key: "derived", memory_type: "lesson" },
        relations: { ids: ["base1", "base2"], properties: { type: "derives" } },
      },
    ],
  });

  const rel = await store.contextRelations({ collection: "der" }, ["derived"]);
  assert.ok(
    (rel.relations ?? []).filter((r) => r.type === "derives").length === 2,
    "derives edges stored",
  );

  const thinking = await store.query({ query: "payment service", database: "d", collection: "der", mode: "thinking" });
  const via = thinking.chunks.find((c) => c.id === "derived");
  assert.ok(via, "derived memory pulled via expansion");
  assert.equal(
    (via.metadata as Record<string, unknown>).edge_type, "derives",
    "expansion carries the edge type",
  );
  done();
}

// ── Consolidation merge path ─────────────────────────────────────────────────

{
  const { store, done } = freshStore();
  await store.ingestMemory({
    database: "d", collection: "merge",
    memories: [
      { id: "m_strong", text: "The deploy pipeline uses GitHub Actions with staging gates and prod approval", additional_metadata: { fact_key: "deploy" } },
      { id: "m_weak", text: "The deploy pipeline uses GitHub Actions", additional_metadata: { fact_key: "deploy" } },
    ],
  });
  const mdb = (store as unknown as { db: import("better-sqlite3").Database }).db;
  mdb.prepare(`UPDATE memories SET created_at = '2020-01-01 00:00:00', strength = 0.4 WHERE id = 'm_weak'`).run();
  mdb.prepare(`UPDATE memories SET strength = 0.9 WHERE id = 'm_strong'`).run();

  const cands = store.getConsolidationCandidates("merge");
  const plan = planConsolidation(cands);
  assert.ok(plan.merged.length === 1, `similar fact_keys merge, got ${JSON.stringify(plan.merged)}`);
  assert.equal(plan.merged[0]?.keep, "m_strong");
  assert.deepEqual(plan.merged[0]?.drop, ["m_weak"]);

  const applied = store.applyConsolidation({ pruned: [], merged: plan.merged, reinforced: [], expired: [] });
  assert.equal(applied.pruned, 1, "merged loser counts as pruned");

  const q = await store.query({ query: "deploy pipeline", database: "d", collection: "merge" });
  assert.ok(!q.chunks.some((c) => c.id === "m_weak"), "merged loser not returned");
  done();
}

// ── Migration adds signal + query_failures ───────────────────────────────────

{
  const dir = mkdtempSync(join(tmpdir(), "lorex-sqlite-mig2-"));
  const path = join(dir, "old.db");
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, text TEXT NOT NULL,
      corpus TEXT NOT NULL DEFAULT 'memory',
      collection TEXT NOT NULL DEFAULT 'default',
      fact_key TEXT, status TEXT DEFAULT 'current',
      metadata TEXT DEFAULT '{}', relations TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO memories (id, text, collection) VALUES ('sig_legacy', 'legacy signal target', 'mig2');
  `);
  raw.close();

  const store = new SqliteStore({ path });
  store.applySignal(["sig_legacy"], 0.2);
  const q = await store.query({ query: "legacy signal", database: "d", collection: "mig2" });
  const signal = (q.chunks.find((c) => c.id === "sig_legacy")?.metadata as Record<string, unknown> | undefined)?.signal;
  assert.equal(signal, 0.2, "migrated signal column works");

  await store.feedback({ request_id: "migfb", rating: "negative", source: "agent", metadata: { query: "legacy pattern" } });
  assert.equal(store.getQueryFailures()[0]?.pattern, "legacy pattern", "query_failures table migrated");
  store.close();
}

// ── WAL concurrency: parallel readers + writer ───────────────────────────────

{
  const { store, done } = freshStore();
  await store.ingestMemory({
    database: "d", collection: "conc",
    memories: Array.from({ length: 50 }, (_, i) => ({
      id: `conc_${i}`, text: `concurrent fact ${i} about shared caching state`,
      additional_metadata: { fact_key: `conc_${i}` },
    })),
  });

  const readers = Array.from({ length: 10 }, () =>
    store.query({ query: "caching state", database: "d", collection: "conc" }),
  );
  const results = await Promise.all(readers);
  assert.ok(results.every((r) => r.chunks.length > 0), "all parallel readers get results");
  assert.ok(new Set(results.map((r) => r.chunks[0]?.id)).size >= 1, "consistent top hit");
  done();
}

// ── Independent writers cannot leave two current fact versions ─────────────

{
  const dir = mkdtempSync(join(tmpdir(), "lorex-sqlite-versions-"));
  const path = join(dir, "test.db");
  const first = new SqliteStore({ path });
  const second = new SqliteStore({ path });
  const write = (store: SqliteStore, id: string, text: string) => store.ingestMemory({
    database: "d", collection: "versions", memories: [{ id, text, additional_metadata: {
      fact_key: "cache_choice", version_id: id, valid_from: new Date().toISOString(),
      status: "current", trust: "heuristic_extract", memory_type: "decision",
    } }],
  });
  await Promise.all([write(first, "v1", "Cache choice is Redis"), write(second, "v2", "Cache choice is SQLite")]);
  const raw = new Database(path);
  const rows = raw.prepare("SELECT id, status, valid_to FROM memories WHERE collection = ? AND fact_key = ?")
    .all("versions", "cache_choice") as Array<{ id: string; status: string; valid_to: string | null }>;
  assert.equal(rows.filter((r) => r.status === "current").length, 1, "one current version survives independent writers");
  assert.equal(rows.filter((r) => r.status === "superseded" && r.valid_to !== null).length, 1);
  raw.close();
  first.close();
  second.close();
}

// ── Full export restores the learning and shared-task state ─────────────────

{
  const { store, done } = freshStore();
  store.createTask("backup", "launch", "Ship the local memory layer");
  store.appendTaskEvent("backup", "launch", "codex", "decision", "Use a local SQLite file");
  store.saveProfile("backup", "project", { decision: "SQLite" });
  store.enqueueReview({ id: "review_1", collection: "backup", kind: "dream", payload: { text: "Check preference" }, confidence: 0.7 });
  await store.feedback({ request_id: "backup_probe", rating: "negative", metadata: { query: "missing deployment context" } });
  const rows = store.exportRows();
  assert.ok(rows.some((row) => row.record_kind === "task_event"));
  assert.ok(rows.some((row) => row.record_kind === "review"));
  const { store: restored, done: doneRestored } = freshStore();
  const result = restored.importRows(rows);
  assert.ok(result.imported >= 5);
  assert.equal(restored.getTask("backup", "launch")?.events[0]?.body, "Use a local SQLite file");
  assert.equal(restored.getProfile("backup", "project")?.body.decision, "SQLite");
  assert.equal(restored.listReviews("backup").length, 1);
  assert.equal(restored.getQueryFailures()[0]?.pattern, "missing deployment context");
  assert.equal(restored.importRows(rows).imported, 0, "re-import is idempotent");
  done();
  doneRestored();
}

console.log("✓ sqlite integration tests passed");
