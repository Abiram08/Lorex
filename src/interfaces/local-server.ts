/** Local HTTP API: Supermemory-local parity. One command, no setup.
 *
 *  `lorex local` boots this on 127.0.0.1:3777 (loopback only, no auth needed):
 *    POST /add     { text, id?, because? }  -> store a fact
 *    POST /search  { query, asOf? }         -> recall (answer + sources)
 *    GET  /resume                           -> session-start pack
 *    GET  /health                            -> { ok, workspace, store }
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { LorexEngine } from "../engine.js";
import { LIMITS } from "../infrastructure/limits.js";

export interface LocalServerOptions {
  host?: string;
  port?: number;
}

function readBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
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
    void (async () => {
      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          ok: true,
          workspace: identity.workspace ?? identity.collectionLabel,
          agent: identity.agent,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/resume") {
        const receipt = await engine.resume();
        json(res, 200, {
          summary: receipt.summary,
          answer: receipt.answer,
          sources: receipt.sources,
        });
        return;
      }
      if (req.method === "POST" && (url.pathname === "/add" || url.pathname === "/v4/memories")) {
        let body: { text?: string; content?: string; id?: string; because?: string };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const text = (body.text ?? body.content ?? "").trim();
        if (!text) {
          json(res, 400, { error: 'Usage: { "text": "fact because reason" }' });
          return;
        }
        if (text.length > LIMITS.maxFactChars) {
          json(res, 413, { error: `text too long (max ${LIMITS.maxFactChars} chars)` });
          return;
        }
        const receipt = await engine.remember(text, { id: body.id, because: body.because });
        json(res, 200, { ok: true, summary: receipt.summary, result: receipt.result });
        return;
      }
      if (req.method === "POST" && (url.pathname === "/search" || url.pathname === "/v4/search")) {
        let body: { query?: string; q?: string; asOf?: string };
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const query = (body.query ?? body.q ?? "").trim();
        if (!query) {
          json(res, 400, { error: 'Usage: { "query": "what do we use for sessions?" }' });
          return;
        }
        const receipt = await engine.recall({ query, asOf: body.asOf });
        json(res, 200, {
          answer: receipt.answer,
          summary: receipt.summary,
          abstained: receipt.abstained,
          sources: receipt.sources,
        });
        return;
      }
      json(res, 404, { error: "not found — try POST /add, POST /search, GET /resume, GET /health" });
    })().catch((error: unknown) => {
      json(res, 500, { error: (error as Error).message });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return { url: `http://${host}:${port}`, stop: () => server.close() };
}
