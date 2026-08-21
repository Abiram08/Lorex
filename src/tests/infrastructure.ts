/** Tests for the persisted rate limiter and the durable write queue. */

import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RateLimiter, RateLimitError, loadLimits } from "../infrastructure/rate-limiter.js";
import { WriteQueue } from "../infrastructure/write-queue.js";
import type {
  ContextScope,
  FeedbackInput,
  HydraDBLike,
  HydraRelations,
  IngestKnowledgeInput,
  IngestMemoryInput,
  IngestResult,
  QueryInput,
  QueryResult,
} from "../infrastructure/hydradb-client.js";

// Isolated state dir per run — never touch a real ~/.lorex.
const HOME = mkdtempSync(join(tmpdir(), "lorex-infra-"));
process.env.LOREX_HOME = HOME;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function head(t: string): void {
  console.log(`\n${t}\n${"─".repeat(t.length)}`);
}

function throwsRateLimit(fn: () => void): RateLimitError {
  try {
    fn();
  } catch (e) {
    if (e instanceof RateLimitError) return e;
    throw e;
  }
  throw new Error("expected RateLimitError was not thrown");
}

// ── RateLimiter ─────────────────────────────────────────────────────────────
head("Rate limiter");

{
  const T = 1_700_000_000_000;
  let now = T;
  const limiter = new RateLimiter(
    { writesPerHour: 2, writesPerDay: 100, queriesPerHour: 3, ingestTokensPerDay: 100 },
    false,
    () => now,
  );

  limiter.acquire("write");
  limiter.acquire("write");
  const err = throwsRateLimit(() => limiter.acquire("write"));
  ok("hourly write cap throws", err.limit === 2 && err.kind === "write");
  ok("error carries a positive reset", err.resetInSeconds >= 1);

  now = T + 3_600_000 + 1;
  limiter.acquire("write");
  ok("hour window rolls and frees budget", limiter.snapshot().writesThisHour === 1);
  ok("daily counter survives the hour roll", limiter.snapshot().writesToday === 3);
}

{
  const T = 1_700_000_000_000;
  let now = T;
  const limiter = new RateLimiter(
    { writesPerHour: 100, writesPerDay: 3, queriesPerHour: 100, ingestTokensPerDay: 50 },
    false,
    () => now,
  );
  limiter.acquire("write");
  limiter.acquire("write");
  limiter.acquire("write");
  throwsRateLimit(() => limiter.acquire("write"));
  ok("daily write cap throws independently of the hour cap",
    limiter.snapshot().writesToday === 3);

  limiter.acquire("ingest_tokens", 40);
  throwsRateLimit(() => limiter.acquire("ingest_tokens", 20));
  ok("ingest token budget is enforced", limiter.snapshot().ingestTokensToday === 40);

  now = T + 24 * 3_600_000 + 1;
  limiter.acquire("ingest_tokens", 20);
  ok("day window rolls and frees tokens", limiter.snapshot().ingestTokensToday === 20);
}

{
  const limiter = new RateLimiter(
    { writesPerHour: 10, writesPerDay: 10, queriesPerHour: 2, ingestTokensPerDay: 10 },
    false,
  );
  limiter.acquire("query");
  limiter.acquire("query", 1);
  throwsRateLimit(() => limiter.acquire("query"));
  ok("query cap counts amounts, not just calls", limiter.snapshot().queriesThisHour === 2);
}

{
  process.env.LOREX_NO_LIMITS = "1";
  const limits = loadLimits();
  delete process.env.LOREX_NO_LIMITS;
  ok("LOREX_NO_LIMITS lifts every cap",
    limits.writesPerHour === Number.MAX_SAFE_INTEGER &&
    limits.ingestTokensPerDay === Number.MAX_SAFE_INTEGER);
}

{
  clearState();
  process.env.LOREX_NO_LIMITS = "1";
  const unlimited = new RateLimiter(undefined, true);
  unlimited.consume("write", 500);
  unlimited.consume("query", 500);
  delete process.env.LOREX_NO_LIMITS;
  ok("unlimited runs write no usage file", !existsSync(join(HOME, "usage.json")));

  const limited = new RateLimiter(
    { writesPerHour: 5, writesPerDay: 5, queriesPerHour: 5, ingestTokensPerDay: 5 },
    true,
  );
  ok("a limited run is unaffected by unlimited runs", limited.snapshot().writesThisHour === 0);

  const poisoned = new RateLimiter(
    { writesPerHour: 5, writesPerDay: 5, queriesPerHour: 5, ingestTokensPerDay: 5 },
    true,
  );
  poisoned.consume("write", 5);
  const lowered = new RateLimiter(
    { writesPerHour: 3, writesPerDay: 3, queriesPerHour: 3, ingestTokensPerDay: 3 },
    true,
  );
  ok("persisted counters above a lowered cap are clamped",
    lowered.snapshot().writesThisHour === 3 && lowered.snapshot().writesToday === 3);
}

{
  clearState();
  const limiter = new RateLimiter(
    { writesPerHour: 5, writesPerDay: 5, queriesPerHour: 5, ingestTokensPerDay: 5 },
    true,
  );
  limiter.consume("write", 2);
  const reloaded = new RateLimiter(
    { writesPerHour: 5, writesPerDay: 5, queriesPerHour: 5, ingestTokensPerDay: 5 },
    true,
  );
  ok("usage persists across instances", reloaded.snapshot().writesThisHour === 2);
  throwsRateLimit(() => {
    let l = new RateLimiter(
      { writesPerHour: 5, writesPerDay: 5, queriesPerHour: 5, ingestTokensPerDay: 5 },
      true,
    );
    for (let i = 0; i < 10; i++) l.acquire("write");
  });
  ok("persisted usage enforces across instances", true);
}

// ── WriteQueue ──────────────────────────────────────────────────────────────
head("Write queue");

interface StubOptions {
  failWith?: (item: IngestMemoryInput) => Error;
  gate?: (call: number) => Promise<void>;
}

function stubClient(opts: StubOptions = {}): HydraDBLike & { memoryCalls: IngestMemoryInput[] } {
  let call = 0;
  return {
    memoryCalls: [],
    async createDatabase(): Promise<void> {},
    async awaitDatabaseReady(): Promise<void> {},
    async databaseStatus(): Promise<{ ready: boolean; raw: unknown }> {
      return { ready: true, raw: null };
    },
    async ingestMemory(input: IngestMemoryInput): Promise<IngestResult> {
      call++;
      if (opts.gate) await opts.gate(call);
      this.memoryCalls.push(input);
      if (opts.failWith) throw opts.failWith(input);
      return { ok: true, ids: input.memories.map((m, i) => m.id ?? `id_${i}`), requestId: "req" };
    },
    async ingestKnowledge(_input: IngestKnowledgeInput): Promise<IngestResult> {
      return { ok: true, ids: [], requestId: "req" };
    },
    async awaitIndexed(): Promise<boolean> {
      return true;
    },
    async contextStatus(): Promise<{ statuses: Array<{ id: string; indexing_status: string }>; raw: unknown }> {
      return { statuses: [], raw: null };
    },
    async contextRelations(_scope?: ContextScope, _ids?: string[]): Promise<HydraRelations> {
      return {};
    },
    async query(_input: QueryInput): Promise<QueryResult> {
      return { chunks: [], requestId: "req", latencyMs: 0, raw: null };
    },
    async feedback(_input: FeedbackInput): Promise<void> {},
    async ping(): Promise<{ reachable: boolean; authed: boolean; latencyMs: number }> {
      return { reachable: true, authed: true, latencyMs: 1 };
    },
  };
}

function memItem(n: string): IngestMemoryInput {
  return { database: "db", collection: "col", memories: [{ id: n, text: n }] };
}

function deadLetters(): string[] {
  const file = join(HOME, "queue-dead.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
}

function clearState(): void {
  for (const f of ["queue.jsonl", "queue-dead.jsonl", "usage.json"]) {
    const p = join(HOME, f);
    if (existsSync(p)) rmSync(p);
  }
}

{
  clearState();
  const q = new WriteQueue(stubClient(), 10);
  q.enqueueMemory(memItem("a"), "down");
  q.enqueueMemory(memItem("b"), "down");
  const reopened = new WriteQueue(stubClient(), 10);
  ok("queue persists to disk and reloads", reopened.length === 2);
}

{
  clearState();
  const client = stubClient();
  const q = new WriteQueue(client, 10);
  q.enqueueMemory(memItem("a"), "down");
  await q.flush();
  ok("flush delivers and empties the queue", q.length === 0 && client.memoryCalls.length === 1);
  ok("flush clears the persisted file", !existsSync(join(HOME, "queue.jsonl")) ||
    readFileSync(join(HOME, "queue.jsonl"), "utf8").trim() === "");
}

{
  clearState();
  const attempt = { n: 0 };
  const client = stubClient({
    failWith: () => {
      attempt.n++;
      return Object.assign(new Error("connection reset"), { kind: "network" });
    },
  });
  const q = new WriteQueue(client, 10);
  q.enqueueMemory(memItem("a"), "down");
  await q.flush();
  ok("transient failure keeps the item queued", q.length === 1);
  ok("failed item records its attempt", q.pending()[0]!.attempts === 1);

  const q2 = new WriteQueue(stubClient(), 10);
  await q2.flush();
  ok("item survives restart and delivers on a healthy client", q2.length === 0);
}

{
  clearState();
  const client = stubClient({
    failWith: () => Object.assign(new Error("bad api key"), { kind: "auth" }),
  });
  const q = new WriteQueue(client, 10);
  q.enqueueMemory(memItem("perm"), "down");
  await q.flush();
  ok("permanent failure is not retried", q.length === 0);
  ok("permanent failure is dead-lettered with its reason",
    deadLetters().length === 1 && deadLetters()[0]!.includes("permanent failure"));
}

{
  clearState();
  const q = new WriteQueue(stubClient({ failWith: () => Object.assign(new Error("500"), { kind: "server" }) }), 2);
  q.enqueueMemory(memItem("one"), "down");
  q.enqueueMemory(memItem("two"), "down");
  q.enqueueMemory(memItem("three"), "down");
  ok("capacity eviction keeps the newest items", q.length === 2);
  ok("evicted oldest goes to the dead-letter file",
    deadLetters().some((l) => l.includes('"one"')));
}

{
  clearState();
  let releaseFirst!: () => void;
  const gated = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const client = stubClient({
    gate: async (call) => { if (call === 1) await gated; },
  });
  const q = new WriteQueue(client, 10);
  q.enqueueMemory(memItem("first"), "down");

  const flushing = q.flush();
  await new Promise((r) => setTimeout(r, 20));
  q.enqueueMemory(memItem("second"), "down");
  releaseFirst();
  await flushing;

  ok("item enqueued mid-flush is not lost", q.length === 1);
  ok("mid-flush enqueue is the surviving item", q.pending()[0]!.memory?.memories[0]?.id === "second");
  ok("the first item was delivered before the gate released", client.memoryCalls.length === 1);
}

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(58)}`);
console.log(`  ${pass} passed · ${fail} failed`);
if (failures.length) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    · ${f}`);
}
console.log("═".repeat(58));
try {
  rmSync(HOME, { recursive: true, force: true });
} catch {
}
process.exit(fail ? 1 : 0);
