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
    ev("user", "We decided to use Redis for sessions.", 0),
    ev("user", "We decided to use Redis for sessions!  ", 1),
    ev("assistant", "We decided to use Redis for sessions.", 2),
    ev("user", "Something completely different here.", 3),
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
    ev("user", "We decided to migrate session storage from MongoDB to Redis because Atlas kept timing out under load.", 0),
    ev("user", "I always prefer TypeScript over JavaScript for new services.", 1),
    ev("user", "Never commit secrets to the repo, use the vault instead.", 2),
    ev("user", "Thanks!", 3),
    ev("user", "ok", 4),
    ev("assistant", "Maybe we could possibly consider trying something at some point?", 5),
  ]);
  const types = facts.map((f) => f.memoryType);
  assert.ok(types.includes("decision"), `decision extracted, got ${types}`);
  assert.ok(types.includes("preference"), `preference extracted, got ${types}`);
  assert.ok(types.includes("constraint"), `constraint extracted, got ${types}`);
  assert.ok(!facts.some((f) => f.value.includes("Thanks")), "greetings filtered");
  assert.ok(!facts.some((f) => f.value === "ok"), "short noise filtered");
  assert.ok(facts.every((f) => f.confidence >= 0 && f.confidence <= 1), "confidence bounded");

  const corrections = extractFacts([
    ev("user", "Actually that's wrong, we use Memcached now, changed from Redis last week.", 0),
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
  const engine = new LorexEngine(new MockHydraDB(), resolveIdentity(dir, { collection: "parse" }), 1000);

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
