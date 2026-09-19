/** Embeddings: math, providers, hybrid rerank with a fake embedder, PDF ingest. */

process.env.LOREX_NO_LIMITS = "1";

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import {
  cosineSimilarity,
  toBlob,
  fromBlob,
  providerFromEnv,
  type EmbedProvider,
} from "../infrastructure/embeddings.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { LorexEngine } from "../engine.js";
import { resolveIdentity } from "../infrastructure/identity.js";

{
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.ok(cosineSimilarity([1, 1], [1, 0]) > 0.7);
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), cosineSimilarity([1, 2], [1, 2, 3]), "length mismatch truncates");

  const vec = [0.1, -0.5, 0.9, 0.00001];
  const back = fromBlob(toBlob(vec));
  assert.ok(back.every((v, i) => Math.abs(v - (vec[i] ?? 0)) < 1e-6), "blob round-trips float32");

  delete process.env.LOREX_EMBED_URL;
  assert.equal(providerFromEnv(), null, "no URL means disabled");
}

// Fake embedder: orthogonal signals per keyword so ranking is deterministic.
function fakeEmbedder(): EmbedProvider {
  const dims: Record<string, number[]> = {
    database: [1, 0, 0, 0],
    cache: [0, 1, 0, 0],
    auth: [0, 0, 1, 0],
  };
  return {
    model: "fake",
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const lower = t.toLowerCase();
        for (const [key, vec] of Object.entries(dims)) {
          if (lower.includes(key)) return vec;
        }
        return [0, 0, 0, 1];
      });
    },
  };
}

{
  const dir = mkdtempSync(join(tmpdir(), "lorex-emb-"));
  const store = new SqliteStore({ path: join(dir, "t.db") });
  store.setEmbedder(fakeEmbedder());

  await store.ingestMemory({
    database: "d", collection: "emb",
    memories: [
      { id: "db_fact", text: "The primary database is Postgres", additional_metadata: { fact_key: "db_fact" } },
      { id: "cache_fact", text: "The cache layer is Redis", additional_metadata: { fact_key: "cache_fact" } },
    ],
  });
  // Let the fire-and-forget embed cache land.
  await new Promise((r) => setTimeout(r));

  const q = await store.query({ query: "database postgres", database: "d", collection: "emb" });
  assert.ok(q.chunks.length >= 1, "hybrid query returns results");
  assert.equal((q.raw as Record<string, unknown>).semantic, true, "semantic active in raw");

  const cached = (store as unknown as { db: import("better-sqlite3").Database }).db
    .prepare(`SELECT COUNT(*) AS n FROM embeddings`).get() as { n: number };
  assert.ok(cached.n >= 2, `vectors cached, got ${cached.n}`);
  store.close();
}

{
  const dir = mkdtempSync(join(tmpdir(), "lorex-emb-off-"));
  const store = new SqliteStore({ path: join(dir, "t.db") });
  await store.ingestMemory({
    database: "d", collection: "off",
    memories: [{ id: "x", text: "Some fact about databases", additional_metadata: { fact_key: "x" } }],
  });
  const q = await store.query({ query: "databases", database: "d", collection: "off" });
  assert.ok(q.chunks.length >= 1, "FTS works with no embedder");
  assert.equal((q.raw as Record<string, unknown>).semantic, false, "semantic off in raw");
  store.close();
}

// Minimal valid PDF: single page, one text object.
const MINIMAL_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 60>>stream
BT /F1 12 Tf 10 100 Td (PostgresChosenForAnalytics) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
`;

{
  const dir = mkdtempSync(join(tmpdir(), "lorex-pdf-"));
  const pdfPath = join(dir, "doc.pdf");
  writeFileSync(pdfPath, MINIMAL_PDF);
  const engine = new LorexEngine(new SqliteStore({ path: join(dir, "t.db") }), resolveIdentity(dir, { collection: "pdf" }));

  const r = await engine.ingestDocument({ path: pdfPath, sourceRef: "doc.pdf" });
  assert.ok(r.chunkCount >= 1, `PDF yields chunks, got ${r.chunkCount}`);

  const q = await engine.recall({ query: "PostgresChosenForAnalytics", type: "knowledge" });
  assert.ok(
    q.sources.some((s) => (s.content ?? s.excerpt ?? "").includes("PostgresChosenForAnalytics")),
    "PDF text retrievable",
  );
}

console.log("✓ embeddings tests passed");
