/**
 * Local memory benchmark: measures write throughput, query latency,
 * and recall quality on the SQLite store.
 *
 * Usage: tsx src/benchmark/local-bench.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { LorexEngine } from "../engine.js";
import { resolveIdentity } from "../infrastructure/identity.js";

interface BenchResult {
  name: string;
  ops: number;
  totalMs: number;
  opsPerSec: number;
  avgMs: number;
}

async function benchAsync(name: string, fn: () => Promise<void>, ops: number): Promise<BenchResult> {
  const start = performance.now();
  for (let i = 0; i < ops; i++) await fn();
  const totalMs = performance.now() - start;
  return {
    name,
    ops,
    totalMs: Math.round(totalMs),
    opsPerSec: Math.round((ops / totalMs) * 1000),
    avgMs: Number((totalMs / ops).toFixed(3)),
  };
}

async function main() {
  console.log("Lorex Local Memory Benchmark");
  console.log("============================\n");

  // Setup
  const tmpDir = mkdtempSync(join(tmpdir(), "lorex-bench-"));
  const dbPath = join(tmpDir, "bench.db");
  const store = new SqliteStore({ path: dbPath });
  const identity = resolveIdentity(process.cwd(), { workspace: "bench" });
  const engine = new LorexEngine(store, identity, 500);

  await engine.ensureReady();

  // Facts to write
  const facts = [
    "Session storage moved to Redis because Atlas kept timing out under load",
    "Auth uses JWT tokens with 24h expiry, refresh tokens are rotated",
    "We deploy on Tuesdays and Thursdays, never on Fridays",
    "The API rate limit is 1000 requests per minute per user",
    "Database migrations run automatically on deploy via Flyway",
    "Error tracking uses Sentry, alerts go to #ops Slack channel",
    "We use feature flags via LaunchDarkly for gradual rollouts",
    "The main branch is protected, all PRs need 2 approvals",
    "Staging environment mirrors production but with 1/10th the data",
    "We switched from REST to GraphQL for the dashboard API",
    "Testing uses Vitest, coverage threshold is 80%",
    "The mobile app is built with React Native, shared code with web",
    "CI runs on GitHub Actions, deploys to Fly.io",
    "We use pnpm workspaces for the monorepo",
    "The design system uses Radix primitives with Tailwind CSS",
  ];

  // Benchmark 1: Write throughput
  console.log("1. Write Throughput");
  console.log("---");
  const writeResults: BenchResult[] = [];

  for (let i = 0; i < 50; i++) {
    const fact = facts[i % facts.length]!;
    const r = await benchAsync(
      `write-${i}`,
      async () => { await engine.remember(`${fact} (variant ${i})`, {
        id: `bench_${i}`,
        because: `benchmark iteration ${i}`,
      }); },
      1,
    );
    writeResults.push(r);
  }

  const totalWrites = writeResults.reduce((s, r) => s + r.ops, 0);
  const totalWriteMs = writeResults.reduce((s, r) => s + r.totalMs, 0);
  console.log(`  Total writes: ${totalWrites}`);
  console.log(`  Total time: ${totalWriteMs}ms`);
  console.log(`  Throughput: ${Math.round((totalWrites / totalWriteMs) * 1000)} ops/sec`);
  console.log(`  Avg latency: ${(totalWriteMs / totalWrites).toFixed(1)}ms`);
  console.log();

  // Benchmark 2: Query latency
  console.log("2. Query Latency (FTS5)");
  console.log("---");
  const queries = [
    "Redis session storage",
    "JWT auth tokens",
    "deploy schedule",
    "rate limit",
    "database migrations",
    "Sentry error tracking",
    "feature flags",
    "PR approvals",
    "staging environment",
    "GraphQL dashboard",
    "Vitest testing",
    "React Native mobile",
    "GitHub Actions CI",
    "pnpm workspaces",
    "Radix design system",
  ];

  const queryResults: BenchResult[] = [];
  for (const q of queries) {
    const r = await benchAsync(
      `query-${q.slice(0, 20)}`,
      async () => { await engine.recall({ query: q, maxResults: 5 }); },
      1,
    );
    queryResults.push(r);
  }

  const totalQueries = queryResults.reduce((s, r) => s + r.ops, 0);
  const totalQueryMs = queryResults.reduce((s, r) => s + r.totalMs, 0);
  console.log(`  Total queries: ${totalQueries}`);
  console.log(`  Total time: ${totalQueryMs}ms`);
  console.log(`  Throughput: ${Math.round((totalQueries / totalQueryMs) * 1000)} queries/sec`);
  console.log(`  Avg latency: ${(totalQueryMs / totalQueries).toFixed(1)}ms`);
  console.log();

  // Benchmark 3: Recall quality
  console.log("3. Recall Quality");
  console.log("---");
  let correct = 0;
  let total = 0;
  for (const q of queries) {
    const receipt = await engine.recall({ query: q, maxResults: 3 });
    const found = receipt.sources.some((s) =>
      s.content?.toLowerCase().includes(q.split(" ")[0]!.toLowerCase()) ||
      s.excerpt?.toLowerCase().includes(q.split(" ")[0]!.toLowerCase()),
    );
    if (found) correct++;
    total++;
    console.log(`  ${found ? "✓" : "✗"} "${q}" → ${receipt.sources.length} results, abstained: ${receipt.abstained}`);
  }
  console.log(`  Recall accuracy: ${correct}/${total} (${Math.round((correct / total) * 100)}%)`);
  console.log();

  // Benchmark 4: Concurrent reads
  console.log("4. Concurrent Read Performance");
  console.log("---");
  const concurrentStart = performance.now();
  const concurrentPromises = queries.map((q) => engine.recall({ query: q, maxResults: 3 }));
  await Promise.all(concurrentPromises);
  const concurrentMs = performance.now() - concurrentStart;
  console.log(`  ${queries.length} concurrent queries: ${Math.round(concurrentMs)}ms`);
  console.log(`  Avg per query: ${(concurrentMs / queries.length).toFixed(1)}ms`);
  console.log();

  // Cleanup
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });

  console.log("Benchmark complete.");
}

main().catch(console.error);
