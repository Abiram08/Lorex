/** Engine end-to-end flows on real SQLite: remember/recall/supersede/why/history/forget/learn/list/handoff/resume/report. */

process.env.LOREX_NO_LIMITS = "1";

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { LorexEngine } from "../engine.js";
import { resolveIdentity } from "../infrastructure/identity.js";

function freshEngine(collection = "eng"): { engine: LorexEngine; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lorex-eng-test-"));
  const store = new SqliteStore({ path: join(dir, "test.db") });
  const engine = new LorexEngine(store, resolveIdentity(dir, { collection }), 1000);
  return { engine, done: () => store.close() };
}

// ── remember → recall ────────────────────────────────────────────────────────

{
  const { engine, done } = freshEngine();
  const r = await engine.remember("Session storage moved to Redis because Atlas kept timing out", { id: "session_store" });
  assert.equal(r.abstained, false);
  assert.ok(r.request_id);

  const q = await engine.recall({ query: "what do we use for sessions?" });
  assert.ok(q.sources.length > 0, "recall must return sources");
  assert.ok(
    q.sources.some((s) => (s.content ?? s.excerpt ?? "").includes("Redis")),
    "recalled pack must contain the stored fact",
  );
  done();
}

// ── supersession: new value wins, old kept in history ────────────────────────

{
  const { engine, done } = freshEngine();
  await engine.remember("We use MongoDB for session storage", { id: "store" });
  await engine.remember("We use Redis for session storage because Mongo timed out", { id: "store" });

  const q = await engine.recall({ query: "session storage database" });
  const texts = q.sources.map((s) => s.content ?? s.excerpt ?? "").join(" ");
  assert.ok(texts.includes("Redis"), "current value recalled");

  const h = await engine.history({ factId: "store" });
  assert.ok(h.sources.length >= 2, `history must show both versions, got ${h.sources.length}`);
  done();
}

// ── why renders the causal chain ─────────────────────────────────────────────

{
  const { engine, done } = freshEngine();
  await engine.remember("Cache is Redis", { id: "cache" });
  await engine.remember("Cache is Memcached because Redis evicted hot keys", { id: "cache" });

  const w = await engine.why({ factId: "cache" });
  const text = JSON.stringify(w.result ?? w.summary);
  assert.ok(text.toLowerCase().includes("evict") || text.toLowerCase().includes("because") || text.includes("Memcached"), `why must surface the reason, got: ${text.slice(0, 200)}`);
  done();
}

// ── forget closes the topic ──────────────────────────────────────────────────

{
  const { engine, done } = freshEngine();
  await engine.remember("Temporary staging password is abc123", { id: "staging_pw" });
  const f = await engine.forget({ factId: "staging_pw" });
  assert.equal(f.abstained, false);

  const q = await engine.recall({ query: "staging password" });
  assert.ok(
    !q.sources.some((s) => (s.content ?? s.excerpt ?? "").includes("abc123") && s.status === "current"),
    "forgotten fact must not come back as current",
  );
  done();
}

// ── learn stores verbatim knowledge ──────────────────────────────────────────

{
  const { engine, done } = freshEngine();
  await engine.learn("Runbook: restart the worker with `systemctl restart lorex-worker` then check /healthz.", "runbook.md");

  const q = await engine.recall({ query: "how to restart the worker", type: "knowledge" });
  assert.ok(
    q.sources.some((s) => (s.content ?? s.excerpt ?? "").includes("systemctl")),
    "learned content must be retrievable as knowledge",
  );
  done();
}

// ── list snapshot ────────────────────────────────────────────────────────────

{
  const { engine, done } = freshEngine();
  await engine.remember("List probe fact alpha", { id: "probe_a" });
  await engine.remember("List probe fact beta", { id: "probe_b" });

  const l = await engine.list({ type: "memory" });
  assert.ok(l.sources.length >= 2, `list must show stored memories, got ${l.sources.length}`);
  done();
}

// ── handoff → resume ─────────────────────────────────────────────────────────

{
  const { engine, done } = freshEngine();
  await engine.remember("Auth uses PKCE flow", { id: "auth" });
  await engine.handoff({ decision: "Auth migrated to PKCE", nextStep: "Migrate the logout path" });

  const r = await engine.resume();
  const text = `${r.summary} ${JSON.stringify(r.result ?? "")}`;
  assert.ok(text.includes("PKCE"), `resume must include the handoff, got: ${text.slice(0, 300)}`);
  done();
}

// ── asOf temporal recall ─────────────────────────────────────────────────────

{
  const { engine, done } = freshEngine();
  await engine.remember("Primary region is us-east-1", { id: "region", validFrom: "2023-01-01T00:00:00Z" });
  await engine.remember("Primary region is eu-west-1", { id: "region", validFrom: "2024-06-01T00:00:00Z" });

  const past = await engine.recall({ query: "primary region", asOf: "2023-06-01T00:00:00Z" });
  const texts = past.sources.map((s) => s.content ?? s.excerpt ?? "").join(" ");
  assert.ok(texts.includes("us-east-1"), `asOf must return the historical value, got: ${texts.slice(0, 200)}`);
  done();
}

// ── abstention on unknown ────────────────────────────────────────────────────

{
  const { engine, done } = freshEngine();
  const q = await engine.recall({ query: "what is the capital of Mars" });
  assert.equal(q.abstained, true, "unknown question must abstain");
  assert.ok(q.abstention_reason, "abstention needs a reason");
  done();
}

// ── report → signal affects ranking ──────────────────────────────────────────

{
  const { engine, done } = freshEngine();
  await engine.remember("Alpha cache option details here", { id: "opt_a" });
  await engine.remember("Beta cache option details here", { id: "opt_b" });

  const before = await engine.recall({ query: "cache option details" });
  const last = before.sources[before.sources.length - 1];
  assert.ok(last, "need at least one source");
  assert.ok(before.request_id, "recall returns a request id");

  await engine.report({
    requestId: before.request_id,
    query: "cache option details",
    rating: "positive",
    answer: last.content,
    sourceIds: [last.id],
  });

  const after = await engine.recall({ query: "cache option details" });
  assert.equal(after.sources[0]?.id, last.id, "positively-rated source must rank first");
  done();
}

// ── validation errors ────────────────────────────────────────────────────────

{
  const { engine, done } = freshEngine();
  await assert.rejects(() => engine.remember("   "), /fact is required/);
  await assert.rejects(() => engine.remember("x", { validFrom: "not-a-date" }), /validFrom/);
  await assert.rejects(() => engine.handoff({ decision: "  " }), /decision is required/);
  await assert.rejects(() => engine.report({ requestId: "  " }), /requestId is required/);
  done();
}

// ── oversized fact rejected ──────────────────────────────────────────────────

{
  const { engine, done } = freshEngine();
  await assert.rejects(() => engine.remember("x".repeat(100_000)), /too long|exceed|max/i);
  done();
}

// ── export/import round-trip ─────────────────────────────────────────────────

{
  const { engine, done } = freshEngine("sync_a");
  await engine.remember("Sync probe decision about caching", { id: "sync_probe" });
  await engine.handoff({ decision: "Sync probe done", nextStep: "Verify on machine B" });

  const rows = await engine.exportData();
  assert.ok(rows && rows.length >= 2, `export dumps rows, got ${rows?.length}`);

  const { engine: engineB, done: doneB } = freshEngine("sync_a");
  const r = await engineB.importData(rows ?? [], false);
  assert.ok(r && r.imported >= 2, `import merges rows, got ${JSON.stringify(r)}`);

  const q = await engineB.recall({ query: "sync probe caching" });
  assert.ok(
    q.sources.some((s) => (s.content ?? s.excerpt ?? "").includes("Sync probe")),
    "imported memory is recallable on the other engine",
  );

  const again = await engineB.importData(rows ?? [], false);
  assert.equal(again?.imported, 0, "re-import skips existing rows (local wins)");
  done();
  doneB();
}

// ── dream/consolidate/openLoops via engine ────────────────────────────────────

{
  const { engine, done } = freshEngine("maint");
  for (let i = 0; i < 3; i++) {
    await engine.remember(`Maintenance note repetition ${i} about log rotation`, { id: `maint_${i}` });
  }
  const d = await engine.dream();
  assert.ok(d.persisted >= 0 && d.durationMs >= 0, "dream runs end to end");

  const c = await engine.consolidate();
  assert.ok(c.planned >= 0 && c.expired >= 0, "consolidate returns counts");

  const loops = await engine.openLoops();
  assert.ok(Array.isArray(loops), "openLoops returns an array");
  done();
}

console.log("✓ engine sqlite flows passed");
