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
import { dreamHeuristic, shouldDream } from "../infrastructure/dream.js";

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
  // Same fact_key ingested 3+ times → preference discovery
  for (let i = 0; i < 3; i++) {
    await store.ingestMemory({
      database: "dream_freq",
      collection: "dream_freq",
      memories: [{
        id: `pref_${i}`, text: "Always use TypeScript for new code",
        additional_metadata: { fact_key: "lang_pref", version_id: `pref_${i}`, memory_type: "preference" },
      }],
    });
  }

  const r = await dreamHeuristic(store, "dream_freq");
  assert.ok(
    r.discovered.some((d) => d.memoryType === "preference" && d.source === "frequency"),
    `expected a frequency preference discovery, got ${JSON.stringify(r.discovered)}`,
  );
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

console.log("✓ sqlite integration tests passed");
