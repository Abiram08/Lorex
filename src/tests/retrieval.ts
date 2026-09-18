/** Retrieval unit tests: planner intents, evidence budgets, timeline/answer synthesis. */

import assert from "node:assert/strict";
import { classifyAndPlan } from "../retrieval/planner.js";
import { assembleEvidence, synthesizeTimeline, synthesizeAnswer } from "../retrieval/evidence-assembler.js";
import type { QueryChunk } from "../infrastructure/hydradb-client.js";

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

console.log("✓ retrieval tests passed");
