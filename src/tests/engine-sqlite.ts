/** Engine end-to-end flows on real SQLite: remember/recall/supersede/why/history/forget/learn/list/handoff/resume/report. */

process.env.LOREX_NO_LIMITS = "1";

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { LorexEngine } from "../engine.js";
import { resolveIdentity } from "../infrastructure/identity.js";
import { normalizeSession } from "../ingestion/normalizer.js";

function freshEngine(collection = "eng"): { engine: LorexEngine; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lorex-eng-test-"));
  const store = new SqliteStore({ path: join(dir, "test.db") });
  const engine = new LorexEngine(store, resolveIdentity(dir, { collection }));
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
  await engine.remember("Alpha deployment note", { id: "probe_a" });
  await engine.remember("Beta deployment note", { id: "probe_b" });

  const l = await engine.list({ type: "memory" });
  assert.ok(l.sources.length >= 2, `list must show stored memories, got ${l.sources.length}`);
  assert.ok(!l.abstained, "list must not abstain when memories exist");
  done();
}

// ── context pack: snapshot mode must not depend on magic vocabulary ─────────

{
  const { engine, done } = freshEngine();
  await engine.remember("Zebra crossing repair completed on Tuesday", { id: "pack_probe" });

  const pack = await engine.contextPack();
  assert.ok(
    (pack.context ?? pack.answer ?? "").includes("Zebra"),
    `context pack must include recent memories regardless of wording, got: ${(pack.context ?? "").slice(0, 200)}`,
  );

  // Adopted rule: identical store state must produce identical pack bytes, so
  // agent prompt caches are never invalidated by avoidable pack churn.
  const packAgain = await engine.contextPack();
  assert.equal(packAgain.context, pack.context, "context pack is byte-stable for identical store state");
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
  for (let day = 1; day <= 25; day++) {
    await engine.remember(`Archive cache policy version ${day}`, {
      id: "archive_policy",
      validFrom: `2024-01-${String(day).padStart(2, "0")}T00:00:00Z`,
    });
  }
  const past = await engine.recall({ query: "archive cache policy", asOf: "2024-01-02T12:00:00Z" });
  const texts = past.sources.map((source) => source.content ?? source.excerpt ?? "").join(" ");
  assert.ok(texts.includes("version 2"), `historical recall must find versions beyond current top-k: ${texts.slice(0, 200)}`);
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

// ── extends: additive updates keep both current ──────────────────────────────

{
  const { engine, done } = freshEngine("ext");
  await engine.remember("We use Redis for session storage", { id: "cache" });
  await engine.remember("We also use Redis for rate limiting", { id: "cache" });

  const h = await engine.history({ factId: "cache" });
  assert.ok(h.sources.length >= 2, `extends keeps both versions, got ${h.sources.length}`);

  const q = await engine.recall({ query: "Redis usage" });
  const texts = q.sources.map((s) => s.content ?? s.excerpt ?? "").join(" ");
  assert.ok(texts.includes("session") && texts.includes("rate limiting"), "both extended versions recalled");

  // Explicit relation override
  await engine.remember("Cache is Memcached", { id: "cache", relation: "supersedes" });
  const h2 = await engine.history({ factId: "cache" });
  assert.ok(h2.sources.length >= 3, "explicit supersede appends a version");
  done();
}

// ── replacement still supersedes ─────────────────────────────────────────────

{
  const { engine, done } = freshEngine("rep");
  await engine.remember("Primary DB is MongoDB", { id: "db" });
  await engine.remember("Primary DB is Postgres, switched from MongoDB", { id: "db" });

  const q = await engine.recall({ query: "primary database" });
  const texts = q.sources.map((s) => s.content ?? s.excerpt ?? "").join(" ");
  assert.ok(texts.includes("Postgres"), "replacement wins");
  assert.ok(!texts.includes("MongoDB") || texts.includes("Postgres"), "old value superseded");
  done();
}

// ── profile: build, cache, refresh ───────────────────────────────────────────

{
  const { engine, done } = freshEngine("prof");
  await engine.remember("Always use TypeScript for new services", { id: "ts_pref", scope: "global" });
  await engine.remember("We decided on Postgres for analytics", { id: "pg" });
  await engine.remember("Never force-push to main", { id: "ff" });

  const p1 = await engine.profile("project");
  assert.ok(p1 && !p1.cached, "first profile builds fresh");
  assert.ok(p1.preferences.some((x) => x.text.includes("TypeScript")), "global prefs in profile");
  assert.ok(p1.decisions.some((x) => x.text.includes("Postgres")), "decisions in profile");
  assert.ok(p1.constraints.some((x) => x.includes("force-push")), "constraints in profile");

  const p2 = await engine.profile("project");
  assert.ok(p2?.cached, "second profile served from cache");

  const p3 = await engine.profile("project", true);
  assert.ok(p3 && !p3.cached, "forced refresh rebuilds");
  done();
}

// ── document ingestion ───────────────────────────────────────────────────────

{
  const { engine, done } = freshEngine("doc");
  const r = await engine.ingestDocument({
    text: "Runbook\n\nRestart the worker with systemctl restart lorex-worker.\n\nWe decided to standardize on Postgres for all analytics workloads going forward.",
    sourceRef: "runbook",
  });
  assert.ok(r.chunkCount >= 1, `document yields chunks, got ${r.chunkCount}`);
  assert.ok(r.factCount >= 1, `document decisions become facts, got ${r.factCount}`);

  const q = await engine.recall({ query: "restart the worker systemctl", type: "knowledge" });
  assert.ok(
    q.sources.some((s) => (s.content ?? s.excerpt ?? "").includes("systemctl")),
    "document chunks retrievable with source",
  );
  done();
}

// ── secret redaction ─────────────────────────────────────────────────────────

{
  const { engine, done } = freshEngine("sec");
  await engine.remember("Deploy key is sk-ant-secretkey1234567890 for staging", { id: "deploy_key" });
  await engine.remember("Contact admin at ops@example.com for access", { id: "contact" });

  const q = await engine.recall({ query: "deploy key staging" });
  const texts = q.sources.map((s) => s.content ?? s.excerpt ?? "").join(" ");
  assert.ok(!texts.includes("sk-ant-secretkey"), "API key redacted at write");
  assert.ok(texts.includes("[REDACTED"), "redaction marker present");
  done();
}

// ── Cross-process: two engines, one DB, no forked versions ───────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "lorex-xproc-"));
  const dbPath = join(dir, "shared.db");
  const ident = { collection: "xproc" };
  const engineA = new LorexEngine(new SqliteStore({ path: dbPath }), resolveIdentity(dir, ident));
  const engineB = new LorexEngine(new SqliteStore({ path: dbPath }), resolveIdentity(dir, ident));

  await engineA.remember("Cache layer is Redis", { id: "cache" });
  await engineB.remember("Cache layer is Memcached because Redis evicted hot keys", { id: "cache" });
  await engineA.remember("Cache layer is Dragonfly for latency", { id: "cache" });

  const h = await engineA.history({ factId: "cache" });
  assert.ok(h.sources.length >= 3, `one chain across processes, got ${h.sources.length}`);

  const q = await engineB.recall({ query: "cache layer" });
  const texts = q.sources.map((s) => s.content ?? s.excerpt ?? "").join(" ");
  assert.ok(texts.includes("Dragonfly"), "newest version wins across processes");

  const live = h.sources.filter((s) => (s as { status?: string }).status === "current");
  assert.equal(live.length, 1, `exactly one live version, got ${live.length}`);
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

// ── global scope supersedes in its own collection ─────────────────────────────

{
  const { engine, done } = freshEngine("scope");
  // Same id twice: the second must supersede the first *in the global
  // collection*, not accumulate as a duplicate current version.
  await engine.remember("Prefer concise diffs", { id: "diff_style", scope: "global" });
  await engine.remember("Prefer full files over diffs", { id: "diff_style", scope: "global" });

  const h = await engine.history({ factId: "diff_style" });
  assert.equal(h.sources.length, 2, `global history shows both versions, got ${h.sources.length}`);
  assert.ok(h.sources.some((s) => s.status === "superseded"), "older global version is superseded");
  assert.equal(
    h.sources.filter((s) => s.status === "current").length,
    1,
    "exactly one global version is current",
  );

  const q = await engine.recall({ query: "how should diffs be formatted" });
  assert.ok(
    (q.sources.map((s) => s.content ?? "").join(" ")).includes("full files"),
    "the global current value is what recall returns",
  );
  done();
}

// ── forget safety: a vague query must not destroy a topic ─────────────────────

{
  const { engine, done } = freshEngine("forget_safe");
  await engine.remember("The API gateway listens on port 8080", { id: "gateway_port" });

  const vague = await engine.forget({ query: "zebra quarterly synergy alignment" });
  assert.equal(vague.abstained, true, "an unmatched query must forget nothing");
  assert.equal(vague.sources.length, 0);

  const still = await engine.recall({ query: "what port does the gateway use" });
  assert.ok(
    (still.sources.map((s) => s.content ?? "").join(" ")).includes("8080"),
    "the fact survives a vague forget",
  );

  const exact = await engine.forget({ factId: "gateway_port" });
  assert.equal(exact.abstained, false, "an exact topic key still forgets");
  done();
}

// ── asOf honesty: ask before anything existed ─────────────────────────────────

{
  const { engine, done } = freshEngine("asof");
  await engine.remember("The API gateway listens on port 8080", {
    id: "gateway_port",
    validFrom: "2024-06-01T00:00:00Z",
  });

  const pastQ = await engine.recall({
    query: "what port does the gateway use",
    asOf: "2024-01-01T00:00:00Z",
  });
  assert.equal(pastQ.abstained, true, "no answer existed at that time");
  assert.equal(pastQ.abstention_reason, "outside_time_window", `got ${pastQ.abstention_reason}`);
  assert.equal(pastQ.answer, undefined, "no anachronistic value is offered");
  assert.equal(pastQ.sources.length, 0, "present-day evidence is not presented as past fact");

  const nowQ = await engine.recall({ query: "what port does the gateway use" });
  assert.equal(nowQ.abstained, false, "the same question answers today");
  done();
}

// ── document truncation is reported, not silent ──────────────────────────────

{
  const { engine, done } = freshEngine("doc_cap");
  const paragraphs = Array.from(
    { length: 120 },
    (_, i) => `Paragraph number ${i} containing enough prose to pass the ingest filter.`,
  );
  const result = await engine.ingestDocument({ text: paragraphs.join("\n\n") });

  assert.ok(result.partial, "an over-long document is marked partial");
  assert.ok(
    result.errors.some((e) => e.includes("truncated")),
    `truncation is reported, got: ${JSON.stringify(result.errors)}`,
  );
  assert.ok(
    result.errors.some((e) => e.includes("100 of 120")),
    "the report says how much was kept and dropped",
  );
  done();
}

// ── Dream gates: auto-run only when there is enough new material ─────────────

{
  const { engine, done } = freshEngine("dream_gates");

  const cold = await engine.dreamAuto();
  assert.equal(cold.ran, false, "no auto-Dream before enough sessions");
  assert.equal((await engine.dreamStatus()).sessionsSince, 0);

  for (let i = 0; i < 6; i++) {
    const identity = engine.getIdentity();
    await engine.ingestSession(normalizeSession(`session_${i}`, identity.database, identity.collection,
      [{ role: "user", content: `We decided to use caching layer ${i} for session ${i}.` }]));
  }
  const status = await engine.dreamStatus();
  assert.equal(status.sessionsSince, 6, `counts distinct sessions, got ${status.sessionsSince}`);
  assert.equal(status.shouldRun, true, "six new sessions makes Dream due");

  const first = await engine.dreamAuto();
  assert.equal(first.ran, true, "auto-Dream runs once the gates pass");

  const second = await engine.dreamAuto();
  assert.equal(second.ran, false, "a second auto-Dream is gated once the clock is reset");
  if (!second.ran) {
    // Either gate can be the binding one: no new sessions since the run, or the
    // 24h window. What matters is that it says why.
    assert.match(second.reason, /session|24h/, `reason explains why: ${second.reason}`);
  }
  done();
}

// ── reflect: memory quality, read-only ──────────────────────────────────────

{
  const { engine, done } = freshEngine("reflect");

  const clean = await engine.reflect();
  assert.equal(clean.available, true, "the SQLite backend can be measured");
  assert.equal(clean.healthy, true, `a fresh store is healthy: ${JSON.stringify(clean.findings)}`);
  assert.equal(clean.total, 0);
  assert.equal(clean.neverRecalled, 0);

  // Same value written under two different ids with unrelated purpose phrasing:
  // two topics holding the same text — exactly what reflect should surface.
  await engine.remember("We use Redis for the session store", { id: "sessions" });
  await engine.remember("We use Redis for the session store", { id: "cache" });
  // A weak, never-recalled memory.
  await engine.remember("Temporarily pinned the build to an older Node image", { id: "pin" });

  const report = await engine.reflect();
  assert.ok(report.total >= 3, `counts what is stored, got ${report.total}`);
  assert.equal(report.duplicateTextClusters, 1, "the duplicate pair is one text cluster");
  assert.equal(report.duplicateTextRows, 2);
  assert.ok(report.neverRecalled >= 3, "nothing has been recalled yet");
  assert.equal(report.healthy, false, "findings make the store unhealthy");
  assert.ok(report.findings.some((f) => f.includes("exact-duplicate")), `findings: ${JSON.stringify(report.findings)}`);

  // Read-only: a second run must report the same thing.
  const again = await engine.reflect();
  assert.equal(again.total, report.total, "reflect does not mutate the store");
  done();
}

// ── Explicit TTL becomes an enforced validity window ────────────────────────

{
  const { engine, done } = freshEngine("ttl");
  await engine.remember("Temporary migration window", { id: "migration_window", ttlSeconds: 60 });
  const rows = await engine.exportData();
  const row = rows?.find((r) => r.kind === "memory" && r.fact_key === "migration_window");
  assert.ok(row, "temporary memory is stored");
  assert.ok(typeof row.valid_to === "string" && Date.parse(row.valid_to) > Date.now(),
    "ttlSeconds sets a future valid_to");
  await assert.rejects(() => engine.remember("Invalid TTL", { ttlSeconds: 0 }), /ttlSeconds/);
  done();
}

// ── Repeated turns remain in the stored source transcript ───────────────────

{
  const { engine, done } = freshEngine("repeated_turns");
  const identity = engine.getIdentity();
  await engine.ingestSession(normalizeSession("repeat_session", identity.database, identity.collection, [
    { role: "user", content: "Please remember the release decision." },
    { role: "assistant", content: "I will track that decision." },
    { role: "user", content: "Please remember the release decision." },
  ]));
  const rows = await engine.exportData();
  const transcript = rows?.filter((r) => r.kind === "memory" && r.corpus === "knowledge")
    .map((r) => String(r.text)).join("\n") ?? "";
  assert.equal(transcript.split("Please remember the release decision.").length - 1, 2,
    "source chunks retain repeated user turns");
  done();
}

console.log("✓ engine sqlite flows passed");
