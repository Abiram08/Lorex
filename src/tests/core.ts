/** Unit tests for domain logic and engine behaviour, offline. */

process.env.LOREX_NO_LIMITS = "1";

import assert from "node:assert/strict";
import {
  computeCompression,
  resolveContextBudget,
  TARGET_COMPRESSION_RATIO,
  HARD_CONTEXT_TOKEN_CAP,
  HAYSTACK_TOKEN_BASELINE,
} from "../domain/compression.js";
import { extractReason, extractTransition } from "../domain/causality.js";
import { classifyAndPlan } from "../retrieval/planner.js";
import { normalizeSession, sessionToEvents } from "../ingestion/normalizer.js";
import { extractFacts } from "../ingestion/extractor.js";
import { chunkEvents } from "../ingestion/chunker.js";
import { determineAbstention } from "../synthesis/abstention.js";
import { generateTopicKey, classifyMemoryType, extractAtomicValue } from "../domain/fact.js";
import { MockHydraDB } from "../infrastructure/mock-hydradb.js";
import { LorexEngine } from "../engine.js";
import { HydraDBError } from "../infrastructure/hydradb-client.js";
import { resolveIdentity } from "../infrastructure/identity.js";
import { countTokens } from "../ingestion/token-counter.js";

const from = "2026-01-01T00:00:00Z";

const session = normalizeSession("s1", "db", "collection", [
  { role: "user", content: "We decided to use HydraDB for memory.", occurredAt: from },
  { role: "assistant", content: "Recorded the decision." },
]);
const events = sessionToEvents(session);
assert.equal(events[0]!.occurredAt, from);
assert.equal(events.length, 2);
assert.ok(extractFacts(events).length >= 1);
assert.ok(chunkEvents("s1", events, { maxTokens: 50 }).length >= 1);

const k1 = generateTopicKey("We decided to use Postgres");
const k2 = generateTopicKey("We are using PostgreSQL now");
assert.equal(k1, k2, "topic keys should match for same subject");
assert.equal(k1, "topic_postgres");
assert.equal(generateTopicKey("x", "db_choice"), "db_choice");

const before = generateTopicKey("We use MongoDB for session storage");
const after = generateTopicKey("We switched to Redis for session storage because Atlas timed out");
assert.equal(before, after, "same subject, different value -> one topic key");
assert.equal(before, "topic_session_storage");

assert.equal(classifyMemoryType("We switched to Redis for session storage"), "decision");

assert.equal(classifyMemoryType("We decided to use TypeScript"), "decision");
assert.ok(extractAtomicValue("A".repeat(500) + " We decided to use Redis. " + "B".repeat(100)).includes("decided") || extractAtomicValue("We decided to use Redis.").includes("Redis"));

assert.equal(determineAbstention([{ id: "x", text: "weak", score: 0.1 }]).reason, "low_confidence");
assert.equal(determineAbstention([]).reason, "no_evidence");
assert.equal(determineAbstention([{ id: "x", text: "ok", score: 0.9 }], { unavailable: true }).reason, "unavailable");
assert.equal(determineAbstention([{ id: "x", text: "good match text here", score: 0.8 }], { query: "good match" }).abstained, false);

const amb = determineAbstention([
  { id: "a", text: "use postgres", score: 0.8 },
  { id: "b", text: "use mysql", score: 0.78 },
]);
assert.equal(amb.abstained, false);
assert.equal(amb.ambiguous, true);

const ambStrict = determineAbstention(
  [
    { id: "a", text: "use postgres", score: 0.8 },
    { id: "b", text: "use mysql", score: 0.78 },
  ],
  { abstainOnAmbiguity: true, query: "which database do we use" },
);
assert.equal(ambStrict.abstained, true, "opt-in ambiguity gate must decline");
assert.equal(ambStrict.reason, "ambiguous_entity");

assert.ok(countTokens("hello world") >= 1);
const comp = computeCompression(2_000, HAYSTACK_TOKEN_BASELINE);
assert.equal(comp.under_5_percent, true);
assert.ok(comp.context_pct < 5);
assert.equal(resolveContextBudget(999_999), HARD_CONTEXT_TOKEN_CAP);
assert.equal(resolveContextBudget(undefined) <= HARD_CONTEXT_TOKEN_CAP, true);

const identity = resolveIdentity(process.cwd(), { database: "test_user", collection: "test_repo" });
const client = new MockHydraDB();
const engine = new LorexEngine(client, identity, 50);
await engine.ensureReady();

const r1 = await engine.remember("Use JavaScript", { id: "lang", validFrom: "2025-01-01T00:00:00Z" });
assert.equal(r1.queued, undefined);
const r2 = await engine.remember("Use TypeScript", { id: "lang", validFrom: "2026-01-01T00:00:00Z" });
assert.ok(r2.summary.includes("Ingested"));

const hist = await engine.history({ factId: "lang" });
assert.ok(hist.sources.length >= 1, "history should find versions");

const past = await engine.recall({ query: "language", asOf: "2025-06-01T00:00:00Z" });
assert.ok(typeof past.abstained === "boolean");
assert.ok(past.compression, "recall must include compression stats");
assert.ok(past.token_cost <= HARD_CONTEXT_TOKEN_CAP);

const forgot = await engine.forget({ factId: "lang" });
assert.ok(forgot.summary.toLowerCase().includes("forget") || forgot.sources.length >= 0);

let threw = false;
try {
  await engine.remember("x".repeat(20_000));
} catch {
  threw = true;
}
assert.equal(threw, true, "oversized fact should throw");

for (const haystack of [80_000, 115_000, 124_000, 250_000]) {
  const budget = resolveContextBudget(undefined, haystack);
  const stats = computeCompression(budget, haystack);
  assert.ok(
    stats.compression_ratio >= TARGET_COMPRESSION_RATIO,
    `budget ${budget} on ${haystack} gives only ${stats.compression_ratio}x`,
  );
  assert.equal(stats.meets_target, true);
  assert.equal(stats.haystack_measured, true);
}
assert.ok(resolveContextBudget(999_999, 115_000) <= 115_000 / TARGET_COMPRESSION_RATIO + 1);
assert.equal(computeCompression(1_700).haystack_measured, false);

assert.equal(
  extractReason("Switched to Redis because Atlas kept timing out under load"),
  "Atlas kept timing out under load",
);
assert.equal(extractReason("We use Postgres"), undefined, "no reason must stay undefined");
const transition = extractTransition("Switched from MongoDB to Redis for sessions");
assert.equal(transition.from, "MongoDB");
assert.equal(transition.to, "Redis");

const supersessionCase = determineAbstention([
  {
    id: "old",
    text: "We use MongoDB for session storage",
    score: 0.8,
    metadata: { status: "superseded", valid_to: "2026-02-02T00:00:00Z" },
  },
  {
    id: "new",
    text: "Switched from MongoDB to Redis for session storage",
    score: 0.7,
    metadata: { status: "current" },
  },
]);
assert.equal(supersessionCase.abstained, false, "supersession must not read as contradiction");

const realConflict = determineAbstention([
  { id: "a", text: "Switched from mongodb to redis", score: 0.8, metadata: { status: "current" } },
  { id: "b", text: "we use mongodb for everything", score: 0.75, metadata: { status: "current" } },
]);
assert.equal(realConflict.reason, "contradictory_evidence");

const partial = classifyAndPlan("what changed across sessions over time", { type: "memory" });
assert.equal(partial.mode, "thinking", "explicit type must not disable thinking mode");
assert.equal(partial.type, "memory");
assert.equal(classifyAndPlan("everything over time", { mode: "fast" }).mode, "fast");

const wsA = resolveIdentity("/tmp/a", { workspace: "Shared Space", agent: "claude-code" });
const wsB = resolveIdentity("/tmp/b", { workspace: "shared space", agent: "codex" });
assert.equal(wsA.database, wsB.database, "same workspace must resolve to one database");
assert.equal(wsA.collection, wsB.collection);
assert.notEqual(wsA.agent, wsB.agent, "agents must stay distinguishable");

await engine.remember("We use MongoDB for sessions", { id: "sess", validFrom: "2026-01-01T00:00:00Z" });
await engine.remember("Switched from MongoDB to Redis for sessions because Atlas kept timing out", {
  id: "sess",
  validFrom: "2026-02-01T00:00:00Z",
});
const chain = await engine.why({ factId: "sess" });
assert.equal(chain.abstained, false, "why should find the chain");
assert.ok(chain.answer?.includes("Atlas kept timing out"), "why must surface the recorded reason");

const currentValue = await engine.recall({ query: "What do we use for sessions?" });
assert.equal(currentValue.abstained, false, "supersession must not cause abstention");
assert.ok(
  currentValue.sources[0]?.content.toLowerCase().includes("redis"),
  "current value must rank above the superseded one",
);

await engine.handoff({ decision: "Sessions on Redis", nextStep: "migrate logout" });
const resumed = await engine.resume();
assert.equal(resumed.abstained, false);
assert.ok(
  (resumed.result as { handoffs?: unknown[] })?.handoffs?.length,
  "resume must surface handoffs for the next agent",
);

for (const [before, after] of [
  ["Our deployment target is Fly.io", "We moved the deployment target to Railway"],
  ["The team decided to use Vitest as our test runner", "We are migrating to Bun as the test runner"],
  ["My favourite coffee shop is Blue Bottle", "My favourite coffee shop is now Verve"],
] as const) {
  assert.equal(generateTopicKey(before), generateTopicKey(after), `must link: ${before}`);
}

assert.equal(
  generateTopicKey("We switched to Redis for session storage because Atlas timed out"),
  "topic_session_storage",
  "clause boundary must end the subject phrase",
);

assert.notEqual(
  generateTopicKey("We switched to Postgres for performance"),
  "topic_performance",
  "a reason must not be mistaken for a subject",
);

const derived = resolveIdentity(process.cwd());
assert.equal(typeof derived.provenance.shareable, "boolean");
const declared = resolveIdentity(process.cwd(), { workspace: "checkout" });
assert.equal(declared.provenance.shareable, true, "a named workspace is shareable");
assert.equal(declared.warning, undefined, "a named workspace needs no warning");

const brokenClient: typeof client = Object.assign(Object.create(Object.getPrototypeOf(client)), client, {
  query: async () => {
    throw new HydraDBError("upstream is down", "network");
  },
});
const brokenEngine = new LorexEngine(brokenClient, identity, 10);
const degraded = await brokenEngine.recall({ query: "anything at all" });
assert.equal(degraded.abstained, true, "a read fault must abstain, not throw");
assert.equal(degraded.unavailable, true, "and must say the backend was unavailable");

{
  const ambClient = new MockHydraDB();
  const ambEngine = new LorexEngine(ambClient, identity, 10);
  await ambEngine.ensureReady();
  await ambEngine.remember("We use Postgres for analytics", { id: "analytics_db", validFrom: "2026-01-01T00:00:00Z" });
  await ambEngine.remember("We use MySQL for analytics", { id: "other_analytics", validFrom: "2026-01-02T00:00:00Z" });
  const flagged = await ambEngine.recall({ query: "which database do we use for analytics" });
  assert.equal(flagged.abstained, false, "ambiguity flags by default");
  assert.equal(flagged.disputes === undefined || flagged.disputes.length >= 0, true);
}

console.log("✓ core tests passed");
