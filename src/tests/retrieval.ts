/** Retrieval unit tests: planner intents, evidence budgets, timeline/answer synthesis. */

import assert from "node:assert/strict";
import { classifyAndPlan } from "../retrieval/planner.js";
import { assembleEvidence, synthesizeTimeline, synthesizeAnswer } from "../retrieval/evidence-assembler.js";
import { buildContextPack } from "../retrieval/context-pack.js";
import { determineAbstention } from "../synthesis/abstention.js";
import type { QueryChunk } from "../infrastructure/store.js";
import type { ReceiptSource } from "../domain/receipts.js";

function chunk(id: string, text: string, corpus: "memory" | "knowledge" = "memory", score = 0.8, meta: Record<string, unknown> = {}): QueryChunk {
  return { id, text, content: text, corpus, score, metadata: { valid_from: "2024-01-01T00:00:00Z", ...meta } };
}

// ── Planner ──────────────────────────────────────────────────────────────────

{
  assert.equal(classifyAndPlan("what database do we use").intent, "current_fact");
  assert.equal(classifyAndPlan("what did we use back in March 2024").intent, "temporal");
  assert.equal(classifyAndPlan("how did our stack evolve across sessions").intent, "multi_session");
  assert.equal(classifyAndPlan("does the user prefer tabs or spaces").intent, "preference");

  const temporal = classifyAndPlan("what was true on January 15, 2024");
  assert.equal(temporal.intent, "temporal");
  assert.ok(temporal.asOf?.startsWith("2024-01-15"), `date extracted, got ${temporal.asOf}`);
  assert.equal(temporal.requireChronology, true);

  const override = classifyAndPlan("simple fact lookup", { mode: "thinking", type: "knowledge" });
  assert.equal(override.mode, "thinking");
  assert.equal(override.type, "knowledge");

  const asOf = classifyAndPlan("anything", { asOf: "2023-01-01T00:00:00Z" });
  assert.equal(asOf.requireChronology, true);
  assert.equal(asOf.asOf, "2023-01-01T00:00:00Z");
}

// ── Evidence budget ──────────────────────────────────────────────────────────

{
  const chunks = Array.from({ length: 20 }, (_, i) =>
    chunk(`c${i}`, `fact number ${i} about caching layers and configuration details with additional context describing the deployment topology and operational runbook procedures for the platform team`),
  );
  const packed = assembleEvidence(chunks, { maxTokens: 500 });
  assert.ok(packed.totalTokens <= 500, `budget respected, got ${packed.totalTokens}`);
  assert.equal(packed.truncated, true, "overflow must flag truncation");
  assert.ok(packed.evidence.length < 20, "overflow must drop sources");

  const roomy = assembleEvidence(chunks.slice(0, 3), { maxTokens: 5000 });
  assert.equal(roomy.truncated, false);
  assert.equal(roomy.evidence.length, 3);
}

// ── Diversity: memory + knowledge ────────────────────────────────────────────

{
  const chunks = [
    ...Array.from({ length: 5 }, (_, i) => chunk(`m${i}`, `memory fact ${i}`, "memory", 0.9 - i * 0.01)),
    chunk("k0", "knowledge doc about the same topic with relevant details", "knowledge", 0.95),
  ];
  const packed = assembleEvidence(chunks, { maxTokens: 2000, ensureDiversity: true });
  assert.ok(packed.memoryCount >= 1 && packed.knowledgeCount >= 1, "both corpora represented");
}

// ── Chronological ordering ───────────────────────────────────────────────────

{
  const chunks = [
    chunk("new", "newer fact", "memory", 0.9, { valid_from: "2024-06-01T00:00:00Z" }),
    chunk("old", "older fact", "memory", 0.5, { valid_from: "2023-01-01T00:00:00Z" }),
  ];
  const chrono = assembleEvidence(chunks, { chronological: true, preferCurrent: false });
  assert.equal(chrono.evidence[0]?.id, "old", "chronological packs oldest first");

  const current = assembleEvidence(chunks, { preferCurrent: true });
  assert.equal(current.evidence[0]?.id, "new", "default prefers current");
}

// ── Timeline + answer synthesis ──────────────────────────────────────────────

{
  const packed = assembleEvidence([
    chunk("a", "We use Redis for sessions", "memory", 0.9, { valid_from: "2024-01-01T00:00:00Z" }),
    chunk("b", "We use Postgres for analytics", "memory", 0.8, { valid_from: "2024-02-01T00:00:00Z" }),
  ]);
  const timeline = synthesizeTimeline(packed.evidence);
  assert.ok(timeline.includes("Redis") && timeline.includes("Postgres"), "timeline covers all evidence");

  const answer = synthesizeAnswer(packed.evidence, "what do we use?");
  assert.ok(answer.includes("Redis"), "answer cites top evidence");

  assert.equal(synthesizeTimeline([]), "No evidence found.", "empty timeline says so");
}

// ── Dedup preference: typed memory beats the chunk that contains it ─────────

{
  const packed = assembleEvidence([
    chunk("k0", "We switched the session store from Postgres to Redis because Atlas kept timing out.", "knowledge", 0.99),
    chunk("m0", "We switched the session store from Postgres to Redis because Atlas kept timing out.", "memory", 0.8, { memory_type: "decision" }),
  ], { maxTokens: 2000 });

  assert.equal(packed.evidence.length, 1, "containment dedups to one source");
  assert.equal(packed.evidence[0]?.id, "m0", "typed memory wins over the chunk that contains it");
}

// ── Context pack: typed sections, budget, dedup, empty ──────────────────────

function source(id: string, content: string, memoryType: string, corpus: "memory" | "knowledge" = "memory"): ReceiptSource {
  return { id, corpus, excerpt: content, content, memory_type: memoryType };
}

{
  const sources: ReceiptSource[] = [
    source("d1", "Use Redis for sessions", "decision"),
    source("c1", "Never expose the gateway directly", "constraint"),
    source("p1", "Prefer tabs over spaces", "preference"),
    source("k1", "runbook doc about deploy", "fact", "knowledge"),
  ];

  const built = buildContextPack({ label: "demo", sources, maxTokens: 1000 });
  assert.ok(built.text.includes("## Decisions"), "decisions section present");
  assert.ok(built.text.includes("Use Redis for sessions"), "decision content present");
  assert.ok(built.text.includes("## Constraints"), "constraints section present");
  assert.ok(built.text.includes("## Reference"), "knowledge reference section present");
  assert.equal(built.memoryCount, 3, "three typed memories");
  assert.equal(built.knowledgeCount, 1, "one reference source");
  assert.ok(built.tokens <= 1000, "budget respected");

  const tight = buildContextPack({ label: "demo", sources, maxTokens: 30 });
  assert.ok(tight.tokens <= 40, `tight budget respected (${tight.tokens})`);
  assert.ok(tight.memoryCount + tight.knowledgeCount < 4, "tight budget drops some sources");

  const empty = buildContextPack({ label: "demo", sources: [], maxTokens: 1000 });
  assert.equal(empty.text, "");
  assert.equal(empty.memoryCount, 0);
  assert.equal(empty.knowledgeCount, 0);
}

// ── Abstention relevance: absent query words must not force a refusal ───────

{
  const mk = (id: string, text: string, score = 0.8): QueryChunk => ({
    id, text, content: text, corpus: "memory", score,
    metadata: { valid_from: "2024-01-01T00:00:00Z" },
  });

  // Four content words; the corpus answers one and simply has no opinion on the
  // rest. That is a thin match, not a non-match — the missing words must not
  // dominate the relevance score (they used to get the *highest* weight).
  const thin = determineAbstention(
    [mk("a", "Redis holds the session cache for the platform")],
    { query: "what caching invalidation strategy should redis use" },
  );
  assert.equal(thin.abstained, false, `thin match abstained: ${thin.reason}`);
  assert.ok((thin.relevanceScore ?? 0) > 0.25, `relevance ${thin.relevanceScore}`);

  // Genuinely no overlap at all → still refuse.
  const none = determineAbstention(
    [mk("b", "Lunch is served at noon in the cafeteria")],
    { query: "caching invalidation strategy redis" },
  );
  assert.equal(none.abstained, true, "zero overlap must abstain");
  assert.equal(none.reason, "evidence_not_relevant");
}

console.log("✓ retrieval tests passed");
