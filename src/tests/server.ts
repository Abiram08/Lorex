/** Local HTTP server + client tests against a live server on an ephemeral port. */

process.env.LOREX_NO_LIMITS = "1";

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { LorexEngine } from "../engine.js";
import { resolveIdentity } from "../infrastructure/identity.js";
import { serveLocal } from "../interfaces/local-server.js";
import { Lorex, LorexError } from "../client.js";

const dir = mkdtempSync(join(tmpdir(), "lorex-srv-test-"));
const store = new SqliteStore({ path: join(dir, "test.db") });
const engine = new LorexEngine(store, resolveIdentity(dir, { collection: "srv" }));

const { url, stop } = await serveLocal(engine, { port: 0 });
const client = new Lorex(url);

try {
  // ── Health ───────────────────────────────────────────────────────────────
  {
    const h = await client.health();
    assert.equal(h.ok, true);
    assert.ok(typeof h.workspace === "string" || h.workspace === undefined);
  }

  // ── Add → search round-trip ──────────────────────────────────────────────
  {
    const added = await client.add("The API gateway runs on port 8080 because 3000 collided with the dev server");
    assert.equal(added.ok, true);

    const r = await client.search("which port does the API gateway use?");
    assert.ok(!r.abstained, "answerable question must not abstain");
    assert.ok(
      (r.answer ?? r.summary ?? "").includes("8080"),
      `answer must contain the port, got: ${r.answer ?? r.summary}`,
    );
    assert.ok((r.sources?.length ?? 0) > 0, "sources returned");
  }

  // ── v4 aliases ───────────────────────────────────────────────────────────
  {
    const res = await fetch(`${url}/v4/memories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "v4 alias stores content field" }),
    });
    assert.equal(res.status, 200);

    const s = await fetch(`${url}/v4/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "v4 alias" }),
    });
    assert.equal(s.status, 200);
    const body = (await s.json()) as { sources?: unknown[] };
    assert.ok((body.sources?.length ?? 0) > 0, "v4 search returns sources");
  }

  // ── Resume ───────────────────────────────────────────────────────────────
  {
    const r = await client.resume();
    assert.ok(typeof r.summary === "string" || typeof r.answer === "string", "resume returns a pack");
  }

  // ── Profile ──────────────────────────────────────────────────────────────
  {
    await client.add("Profile probe prefers TypeScript for new services");
    const p = await client.profile();
    assert.ok(p.preferences && p.preferences.length >= 0, "profile returns preferences array");
    assert.ok(typeof p.cached === "boolean", "profile reports cache state");
  }

  // ── Validation errors ────────────────────────────────────────────────────
  {
    const empty = await fetch(`${url}/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "  " }),
    });
    assert.equal(empty.status, 400);

    const badJson = await fetch(`${url}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);

    const missing = await fetch(`${url}/nope`);
    assert.equal(missing.status, 404);
    const missingBody = (await missing.json()) as { request_id?: string };
    assert.ok(missingBody.request_id, "errors carry request ids");
  }

  // ── Client error type ────────────────────────────────────────────────────
  {
    const bad = new Lorex("http://127.0.0.1:1");
    await assert.rejects(() => bad.health(), /fetch failed|ECONNREFUSED/i);
  }

  {
    await assert.rejects(client.search(""), LorexError, "empty query throws typed error");
  }
} finally {
  stop();
  store.close();
}

console.log("✓ server tests passed");
