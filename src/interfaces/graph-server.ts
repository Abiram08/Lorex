/** Live context graph server: re-renders the graph as agents write to memory. */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { LorexEngine } from "../engine.js";
import { renderGraphHtml } from "./graph-render.js";

export interface LiveGraphOptions {
  query?: string;
  maxResults?: number;
  host?: string;
  port?: number;
  pollMs?: number;
}

export async function serveGraph(
  engine: LorexEngine,
  opts: LiveGraphOptions = {},
): Promise<{ url: string; token: string; stop: () => void }> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 4100;
  const identity = engine.getIdentity();
  const token = randomBytes(24).toString("base64url");

  const authorized = (url: URL): boolean => url.searchParams.get("token") === token;

  const build = () => engine.graph({ query: opts.query, maxResults: opts.maxResults });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    const path = url.pathname;

    if (!authorized(url)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden — open the tokenized URL printed by `lorex graph --live`.");
      return;
    }

    if (path === "/graph.json") {
      build()
        .then(({ graph }) => {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify(graph));
        })
        .catch((error: unknown) => {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (error as Error).message }));
        });
      return;
    }

    if (path === "/") {
      build()
        .then(({ graph }) => {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            renderGraphHtml(graph, {
              workspace: identity.workspace,
              database: identity.database,
              collection: identity.collection,
              query: opts.query,
              liveUrl: `/graph.json?token=${encodeURIComponent(token)}`,
              pollMs: opts.pollMs ?? 2000,
            }),
          );
        })
        .catch((error: unknown) => {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.end(`Graph unavailable: ${(error as Error).message}`);
        });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  return {
    url: `http://${host}:${port}?token=${encodeURIComponent(token)}`,
    token,
    stop: () => server.close(),
  };
}
