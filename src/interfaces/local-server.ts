/**
 * Local HTTP API: Supermemory-style, one command, zero setup.
 *
 * `lorex local` → http://127.0.0.1:3777
 *   POST /add        { text, id?, because? }   → store a fact
 *   POST /v4/memories { text, ... }             → alias for /add
 *   POST /search      { query, asOf? }          → recall (answer + sources)
 *   POST /v4/search   { query, ... }            → alias for /search
 *   GET  /resume                              → session-start pack
 *   GET  /health                              → { ok, workspace, agent }
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { LorexEngine } from "../engine.js";
import { LIMITS } from "../infrastructure/limits.js";

export interface LocalServerOptions {
  host?: string;
  port?: number;
}

function requestId(): string {
  return randomBytes(8).toString("hex");
}

function readBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function parseJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  try { return JSON.parse(await readBody(req)) as T; } catch { return null; }
}

export async function serveLocal(
  engine: LorexEngine,
  opts: LocalServerOptions = {},
): Promise<{ url: string; stop: () => void }> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 3777;
  await engine.ensureReady();
  const identity = engine.getIdentity();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const rid = requestId();

    void (async () => {
      const { method, pathname: path } = { method: req.method, pathname: url.pathname };

      // Health — no auth, no logging
      if (method === "GET" && path === "/health") {
        return json(res, 200, { ok: true, workspace: identity.workspace ?? identity.collectionLabel, agent: identity.agent });
      }

      // Resume — session-start pack
      if (method === "GET" && path === "/resume") {
        const receipt = await engine.resume();
        return json(res, 200, { summary: receipt.summary, answer: receipt.answer, sources: receipt.sources });
      }

      // Add memory
      if (method === "POST" && (path === "/add" || path === "/v4/memories")) {
        const body = await parseJsonBody<{ text?: string; content?: string; id?: string; because?: string }>(req);
        if (!body) return json(res, 400, { error: "invalid JSON body", request_id: rid });

        const text = (body.text ?? body.content ?? "").trim();
        if (!text) return json(res, 400, { error: 'Usage: { "text": "fact because reason" }', request_id: rid });
        if (text.length > LIMITS.maxFactChars) return json(res, 413, { error: `text too long (max ${LIMITS.maxFactChars})`, request_id: rid });

        const receipt = await engine.remember(text, { id: body.id, because: body.because });
        return json(res, 200, { ok: true, summary: receipt.summary, result: receipt.result, request_id: rid });
      }

      // Search / recall
      if (method === "POST" && (path === "/search" || path === "/v4/search")) {
        const body = await parseJsonBody<{ query?: string; q?: string; asOf?: string }>(req);
        if (!body) return json(res, 400, { error: "invalid JSON body", request_id: rid });

        const query = (body.query ?? body.q ?? "").trim();
        if (!query) return json(res, 400, { error: 'Usage: { "query": "question?" }', request_id: rid });

        const receipt = await engine.recall({ query, asOf: body.asOf });
        return json(res, 200, {
          answer: receipt.answer, summary: receipt.summary,
          abstained: receipt.abstained, sources: receipt.sources,
          request_id: rid,
        });
      }

      // 404
      json(res, 404, {
        error: "not found — POST /add, POST /search, GET /resume, GET /health",
        request_id: rid,
      });
    })().catch((error: unknown) => {
      json(res, 500, { error: (error as Error).message, request_id: rid });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const actualPort = (server.address() as { port?: number } | null)?.port ?? port;
  return { url: `http://${host}:${actualPort}`, stop: () => server.close() };
}
