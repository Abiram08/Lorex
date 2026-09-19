/** Ingestion unit tests: normalizer, chunker, deduplicator, extractor, session-capture. */

import assert from "node:assert/strict";
import { normalizeSession, sessionToEvents } from "../ingestion/normalizer.js";
import { chunkEvents } from "../ingestion/chunker.js";
import { deduplicateEvents } from "../ingestion/deduplicator.js";
import { extractFacts } from "../ingestion/extractor.js";
import { classifyMemoryType } from "../domain/fact.js";
import type { ConversationEvent } from "../domain/event.js";

function ev(role: "user" | "assistant", content: string, n = 0): ConversationEvent {
  return {
    eventId: `e${n}`, sessionId: "s", sequence: n, role, content,
    occurredAt: `2024-01-01T00:0${n}:00Z`,
    ingestedAt: "2024-01-01T00:00:00Z",
    tokenCount: 10,
  };
}

// ── Normalizer ───────────────────────────────────────────────────────────────

{
  const s = normalizeSession("s1", "db", "col", [
    { role: "user", content: "We decided to use Redis." },
    { role: "assistant", content: "Noted." },
  ]);
  assert.equal(s.sessionId, "s1");
  assert.equal(s.turns.length, 2);

  const events = sessionToEvents(s);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.role, "user");

  assert.throws(() => normalizeSession("", "db", "col", [{ role: "user", content: "x" }]), /session/i);
  assert.throws(
    () => normalizeSession("s", "db", "col", [
      { role: "user", content: "later", occurredAt: "2024-02-01T00:00:00Z" },
      { role: "user", content: "earlier", occurredAt: "2024-01-01T00:00:00Z" },
    ]),
    /order|timestamp/i,
  );
}

// ── Chunker ──────────────────────────────────────────────────────────────────

{
  const events = Array.from({ length: 10 }, (_, i) =>
    ev(i % 2 ? "assistant" : "user", `Message number ${i} with enough content to count tokens properly here`, i),
  );
  const chunks = chunkEvents("s1", events, { maxTokens: 50 });
  assert.ok(chunks.length > 1, "long sessions split into multiple chunks");

  for (let i = 0; i < chunks.length; i++) {
    assert.equal(chunks[i]?.chunkSequence, i);
    if (i > 0) assert.equal(chunks[i]?.previousChunkId, chunks[i - 1]?.chunkId, "prev links");
    if (i < chunks.length - 1) assert.equal(chunks[i]?.nextChunkId, chunks[i + 1]?.chunkId, "next links");
  }
  assert.ok(chunks.every((c) => c.totalChunks === chunks.length), "totalChunks populated");

  assert.deepEqual(chunkEvents("s", [], { maxTokens: 50 }), [], "empty events → no chunks");
}

// ── Deduplicator ─────────────────────────────────────────────────────────────

{
  const events = [
    ev("user", "We decided to use Redis for sessions."),
    ev("user", "We decided to use Redis for sessions!  "),
    ev("assistant", "We decided to use Redis for sessions."),
    ev("user", "Something completely different here."),
  ];
  const r = deduplicateEvents(events);
  assert.equal(r.events.length, 3, "exact dupe removed, cross-role kept");
  assert.equal(r.removedCount, 1);
  assert.ok(r.removedTokenCount > 0);

  assert.equal(deduplicateEvents([]).events.length, 0);
}

// ── Extractor ────────────────────────────────────────────────────────────────

{
  const facts = extractFacts([
    ev("user", "We decided to migrate session storage from MongoDB to Redis because Atlas kept timing out under load."),
    ev("user", "I always prefer TypeScript over JavaScript for new services."),
    ev("user", "Never commit secrets to the repo, use the vault instead."),
    ev("user", "Thanks!"),
    ev("user", "ok"),
    ev("assistant", "Maybe we could possibly consider trying something at some point?"),
  ]);
  const types = facts.map((f) => f.memoryType);
  assert.ok(types.includes("decision"), `decision extracted, got ${types}`);
  assert.ok(types.includes("preference"), `preference extracted, got ${types}`);
  assert.ok(types.includes("constraint"), `constraint extracted, got ${types}`);
  assert.ok(!facts.some((f) => f.value.includes("Thanks")), "greetings filtered");
  assert.ok(!facts.some((f) => f.value === "ok"), "short noise filtered");
  assert.ok(facts.every((f) => f.confidence >= 0 && f.confidence <= 1), "confidence bounded");

  const corrections = extractFacts([
    ev("user", "Actually that's wrong, we use Memcached now, changed from Redis last week."),
  ]);
  assert.ok(corrections.some((f) => f.isCorrection), "correction flagged");
}

// ── Memory type classification ───────────────────────────────────────────────

{
  assert.equal(classifyMemoryType("We decided to use Redis"), "decision");
  assert.equal(classifyMemoryType("I prefer tabs over spaces"), "preference");
  assert.equal(classifyMemoryType("You must never force-push to main"), "constraint");
  assert.equal(classifyMemoryType("That was wrong, the port is 8080 not 3000"), "correction");
}

console.log("✓ ingestion tests passed");

// ── Secret redaction ─────────────────────────────────────────────────────────

import { redactSecrets } from "../infrastructure/secrets.js";

{
  const key = redactSecrets("Deploy with sk-ant-abcdefghij1234567890 tonight");
  assert.ok(key.redacted && !key.text.includes("sk-ant-"), "Anthropic key redacted");

  const gh = redactSecrets("token ghp_abcdefghij1234567890 in config");
  assert.ok(gh.redacted && !gh.text.includes("ghp_"), "GitHub token redacted");

  const aws = redactSecrets("using AKIAIOSFODNN7EXAMPLE here");
  assert.ok(aws.redacted, "AWS key redacted");

  const pw = redactSecrets("password: s3cr3t-value here");
  assert.ok(pw.redacted && !pw.text.includes("s3cr3t"), "password assignment redacted");

  const pem = redactSecrets("key:\n-----BEGIN PRIVATE KEY-----\nMIIBvTBX\n-----END PRIVATE KEY-----");
  assert.ok(pem.redacted && !pem.text.includes("MIIB"), "private key block redacted");

  const mail = redactSecrets("contact ops@example.com for help");
  assert.ok(mail.redacted, "email redacted");

  const clean = redactSecrets("We decided to use Redis for sessions because it is fast.");
  assert.ok(!clean.redacted && clean.text.includes("Redis"), "normal text untouched");
}

console.log("✓ secrets tests passed");

// ── Multi-format transcript parsing ──────────────────────────────────────────

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockHydraDB } from "../infrastructure/mock-hydradb.js";
import { LorexEngine } from "../engine.js";
import { resolveIdentity } from "../infrastructure/identity.js";
import { captureTranscript } from "../ingestion/session-capture.js";

{
  const dir = mkdtempSync(join(tmpdir(), "lorex-parse-test-"));
  const engine = new LorexEngine(new MockHydraDB(), resolveIdentity(dir, { collection: "parse" }));

  const openai = join(dir, "openai.jsonl");
  writeFileSync(openai, [
    JSON.stringify({ role: "user", content: "We decided to use Redis for sessions." }),
    JSON.stringify({ role: "assistant", content: "Recorded." }),
  ].join("\n"));
  const r1 = await captureTranscript(engine, { transcriptPath: openai });
  assert.ok(r1.chunkCount >= 1, `openai format parsed, got ${r1.chunkCount} chunks`);

  const pairs = join(dir, "pairs.jsonl");
  writeFileSync(pairs, JSON.stringify({ prompt: "We migrated to Postgres for analytics.", response: "Noted." }));
  const r2 = await captureTranscript(engine, { transcriptPath: pairs });
  assert.ok(r2.chunkCount >= 1, "prompt/response format parsed");

  const junk = join(dir, "junk.jsonl");
  writeFileSync(junk, [JSON.stringify({ foo: "bar" }), "not json at all", JSON.stringify({ type: "unknown_event" })].join("\n"));
  const r3 = await captureTranscript(engine, { transcriptPath: junk });
  assert.ok(r3.errors.length > 0, "empty transcript reports an error, doesn't throw");

  const r4 = await captureTranscript(engine, { transcriptPath: join(dir, "nope.jsonl") });
  assert.ok(r4.errors.length > 0, "missing file reports an error");
}

console.log("✓ transcript parser tests passed");

// ── Incremental capture: cursor skips ingested turns ─────────────────────────

{
  const home = mkdtempSync(join(tmpdir(), "lorex-cur-home-"));
  const prevHome = process.env.LOREX_HOME;
  process.env.LOREX_HOME = home;
  try {
    const dir = mkdtempSync(join(tmpdir(), "lorex-cur-test-"));
    const engine = new LorexEngine(new MockHydraDB(), resolveIdentity(dir, { collection: "cur" }));
    const tpath = join(dir, "sess.jsonl");
    const line = (n: number, text: string) => JSON.stringify({ role: n % 2 ? "assistant" : "user", content: text });

    writeFileSync(tpath, [line(0, "We decided to use Redis for sessions."), line(1, "Noted.")].join("\n"));
    const first = await captureTranscript(engine, { transcriptPath: tpath, incremental: true });
    assert.ok(first.factCount >= 1, `first capture ingests, got ${first.factCount} facts`);

    const second = await captureTranscript(engine, { transcriptPath: tpath, incremental: true });
    assert.equal(second.chunkCount, 0, "second capture is a no-op (cursor)");

    writeFileSync(tpath, [line(0, "We decided to use Redis for sessions."), line(1, "Noted."), line(2, "We also decided on Postgres for analytics workloads.")].join("\n"));
    const third = await captureTranscript(engine, { transcriptPath: tpath, incremental: true });
    assert.ok(third.chunkCount >= 1, "appended turns get ingested");
    assert.ok(third.factCount >= 1, "new decision extracted from appended turns");

    const full = await captureTranscript(engine, { transcriptPath: tpath });
    assert.ok(full.chunkCount >= 1, "explicit capture re-ingests fully");
  } finally {
    if (prevHome === undefined) delete process.env.LOREX_HOME;
    else process.env.LOREX_HOME = prevHome;
  }
}

console.log("✓ incremental capture tests passed");
