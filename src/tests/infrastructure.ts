/** Tests for the persisted rate limiter. */

import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RateLimiter, RateLimitError, loadLimits } from "../infrastructure/rate-limiter.js";

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

function clearState(): void {
  const p = join(HOME, "usage.json");
  if (existsSync(p)) rmSync(p);
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
