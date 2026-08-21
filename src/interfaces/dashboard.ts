/** Local read-only dashboard server and its rendered page. */

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { LorexEngine } from "../engine.js";

const PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";

interface DashboardState {
  engine: LorexEngine;
  requestLog: Array<{
    timestamp: string;
    operation: string;
    query?: string;
    mode?: string;
    asOf?: string;
    sources?: number;
    abstained?: boolean;
    abstentionReason?: string;
    tokenCost?: number;
    duration?: number;
    error?: string;
  }>;
  server?: Server;
}

let state: DashboardState;
let dashboardToken: string;

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function redactSecrets(text: string): string {
  return text
    .replace(/(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*["']?([a-zA-Z0-9_\-]{8,})["']?/gi, "[REDACTED]")
    .replace(/bearer\s+([a-zA-Z0-9_\-\.]{8,})/gi, "Bearer [REDACTED]")
    .replace(/(?:password|passwd|pwd)\s*[:=]\s*["']?([^\s"']{4,})["']?/gi, "[REDACTED]")
    .replace(/(?:secret|token|auth)\s*[:=]\s*["']?([a-zA-Z0-9_\-\.]{8,})["']?/gi, "[REDACTED]");
}

function buildHtml(activeView: string = "overview"): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lorex Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0a0a0f; color: #e0e0e0; min-height: 100vh; }
    .header { background: linear-gradient(135deg, #1a1a2e, #16213e); padding: 1.5rem 2rem; border-bottom: 1px solid #2a2a4a; }
    .header h1 { font-size: 1.5rem; color: #fff; }
    .header .subtitle { color: #888; font-size: 0.875rem; margin-top: 0.25rem; }
    .token-badge { background: #1a1a2a; padding: 0.5rem 1rem; border-radius: 4px; font-family: monospace; font-size: 0.75rem; color: #888; margin-top: 0.5rem; display: inline-block; }
    .nav { background: #12121a; padding: 0.5rem 2rem; display: flex; gap: 0.5rem; border-bottom: 1px solid #1a1a2a; }
    .nav button { background: transparent; border: none; color: #888; padding: 0.75rem 1.5rem; cursor: pointer; font-size: 0.875rem; border-bottom: 2px solid transparent; }
    .nav button:hover { color: #fff; }
    .nav button.active { color: #fff; border-bottom-color: #6366f1; }
    .main { padding: 2rem; max-width: 1200px; margin: 0 auto; }
    .card { background: #12121a; border: 1px solid #2a2a4a; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .card h2 { font-size: 1rem; font-weight: 600; color: #fff; margin-bottom: 1rem; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
    .stat { background: #1a1a2a; padding: 1rem; border-radius: 6px; }
    .stat .label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat .value { font-size: 1.5rem; font-weight: 600; color: #fff; margin-top: 0.25rem; }
    .query-form { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
    .query-form input { flex: 1; min-width: 200px; background: #1a1a2a; border: 1px solid #2a2a4a; border-radius: 6px; padding: 0.75rem 1rem; color: #fff; font-size: 0.875rem; }
    .query-form input:focus { outline: none; border-color: #6366f1; }
    .query-form select { background: #1a1a2a; border: 1px solid #2a2a4a; border-radius: 6px; padding: 0.75rem 1rem; color: #fff; font-size: 0.875rem; }
    .query-form button { background: #6366f1; border: none; border-radius: 6px; padding: 0.75rem 1.5rem; color: #fff; font-size: 0.875rem; cursor: pointer; }
    .query-form button:hover { background: #5558e3; }
    .source-list { display: flex; flex-direction: column; gap: 0.75rem; }
    .source-item { background: #1a1a2a; border: 1px solid #2a2a4a; border-radius: 6px; padding: 1rem; }
    .source-item .meta { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; flex-wrap: wrap; }
    .source-item .tag { font-size: 0.625rem; padding: 0.125rem 0.5rem; border-radius: 4px; font-weight: 500; }
    .source-item .tag.memory { background: #6366f133; color: #a5b4fc; }
    .source-item .tag.knowledge { background: #22c55e33; color: #86efac; }
    .source-item .tag.current { background: #22c55e33; color: #86efac; }
    .source-item .tag.superseded { background: #f59e0b33; color: #fcd34d; }
    .source-item .score { color: #888; font-size: 0.75rem; margin-left: auto; }
    .source-item .content { font-size: 0.875rem; color: #ccc; line-height: 1.5; word-break: break-word; }
    .source-item .validity { font-size: 0.75rem; color: #666; margin-top: 0.5rem; }
    .abstention { background: #2a1a1a; border: 1px solid #4a2a2a; border-radius: 6px; padding: 1rem; color: #f87171; }
    .abstention .reason { font-weight: 600; margin-bottom: 0.25rem; }
    .abstention .message { font-size: 0.875rem; color: #fca5a5; }
    .timeline { position: relative; padding-left: 2rem; }
    .timeline::before { content: ""; position: absolute; left: 7px; top: 0; bottom: 0; width: 2px; background: #2a2a4a; }
    .timeline-item { position: relative; margin-bottom: 1.5rem; }
    .timeline-item::before { content: ""; position: absolute; left: -2rem; top: 0.5rem; width: 12px; height: 12px; border-radius: 50%; background: #6366f1; border: 2px solid #0a0a0f; }
    .timeline-item.superseded::before { background: #f59e0b; }
    .timeline-item .date { font-size: 0.75rem; color: #888; margin-bottom: 0.25rem; }
    .timeline-item .content { font-size: 0.875rem; color: #ccc; }
    .log { max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 0.75rem; background: #0a0a0f; border-radius: 4px; padding: 1rem; }
    .log-entry { padding: 0.25rem 0; border-bottom: 1px solid #1a1a2a; }
    .log-entry:last-child { border-bottom: none; }
    .log-entry .time { color: #666; margin-right: 0.5rem; }
    .log-entry .op { color: #6366f1; }
    .log-entry .success { color: #22c55e; }
    .log-entry .fail { color: #f87171; }
    .error { background: #2a1a1a; border: 1px solid #4a2a2a; border-radius: 6px; padding: 1rem; color: #f87171; margin-bottom: 1rem; }
    .view { display: none; }
    .view.active { display: block; }
    .benchmark-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
    .benchmark-item { background: #1a1a2a; padding: 1rem; border-radius: 6px; text-align: center; }
    .benchmark-item .category { font-size: 0.75rem; color: #888; margin-bottom: 0.5rem; }
    .benchmark-item .score { font-size: 2rem; font-weight: 600; color: #fff; }
    .benchmark-item .count { font-size: 0.75rem; color: #666; margin-top: 0.25rem; }
    .benchmark-item .score.good { color: #22c55e; }
    .benchmark-item .score.bad { color: #f87171; }
    .loading { color: #888; text-align: center; padding: 2rem; }
    code { background: #1a1a2a; padding: 0.125rem 0.375rem; border-radius: 4px; font-size: 0.875em; }
    .security-note { background: #1a2a1a; border: 1px solid #2a4a2a; border-radius: 6px; padding: 1rem; margin-bottom: 1.5rem; font-size: 0.875rem; color: #86efac; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Lorex Dashboard</h1>
    <div class="subtitle">HydraDB-powered temporal context layer</div>
    <div class="token-badge">Dashboard token: <span id="token-display">${escapeHtml(dashboardToken?.slice(0, 8) ?? "...")}</span>...</div>
  </div>

  <div class="security-note">
    <strong>🔒 Security:</strong> This dashboard is read-only, binds to 127.0.0.1 only, requires a token, and redacts secrets from displayed content.
  </div>

  <div class="nav">
    <button class="${activeView === "overview" ? "active" : ""}" onclick="switchView('overview')">Overview</button>
    <button class="${activeView === "timeline" ? "active" : ""}" onclick="switchView('timeline')">Timeline</button>
    <button class="${activeView === "inspector" ? "active" : ""}" onclick="switchView('inspector')">Retrieval Inspector</button>
    <button class="${activeView === "benchmark" ? "active" : ""}" onclick="switchView('benchmark')">Benchmark</button>
  </div>

  <div class="main">
    <!-- OVERVIEW VIEW -->
    <div class="view ${activeView === "overview" ? "active" : ""}" id="view-overview">
      <div class="card">
        <h2>📊 Project Overview</h2>
        <div class="stat-grid">
          <div class="stat"><div class="label">Memories (recent)</div><div class="value" id="memory-count">—</div></div>
          <div class="stat"><div class="label">Knowledge (recent)</div><div class="value" id="knowledge-count">—</div></div>
          <div class="stat"><div class="label">Queue State</div><div class="value" id="queue-state">—</div></div>
          <div class="stat"><div class="label">Requests Today</div><div class="value" id="requests-today">—</div></div>
        </div>
      </div>
      <div class="card">
        <h2>📝 Recent Activity</h2>
        <div class="log" id="recent-log"><div class="loading">Loading...</div></div>
      </div>
    </div>

    <!-- TIMELINE VIEW -->
    <div class="view ${activeView === "timeline" ? "active" : ""}" id="view-timeline">
      <div class="card">
        <h2>⏱️ Fact Timeline</h2>
        <div class="timeline" id="timeline"><div class="loading">Loading...</div></div>
      </div>
    </div>

    <!-- RETRIEVAL INSPECTOR VIEW -->
    <div class="view ${activeView === "inspector" ? "active" : ""}" id="view-inspector">
      <div class="card">
        <h2>🔍 Query Inspector</h2>
        <div class="query-form">
          <input type="text" id="query-input" placeholder="Enter your question..." />
          <select id="mode-select">
            <option value="fast">Fast</option>
            <option value="thinking">Thinking</option>
          </select>
          <input type="text" id="asof-input" placeholder="asOf date (optional)" />
          <button onclick="runQuery()">Run</button>
        </div>
        <div id="query-result"><div class="loading">Run a query to see results</div></div>
      </div>
    </div>

    <!-- BENCHMARK VIEW -->
    <div class="view ${activeView === "benchmark" ? "active" : ""}" id="view-benchmark">
      <div class="card">
        <h2>📈 Benchmark Results</h2>
        <div class="benchmark-grid">
          <div class="benchmark-item">
            <div class="category">Overall Recall@15</div>
            <div class="score" id="bench-overall">—</div>
            <div class="count" id="bench-overall-count"></div>
          </div>
          <div class="benchmark-item">
            <div class="category">Temporal</div>
            <div class="score" id="bench-temporal">—</div>
            <div class="count" id="bench-temporal-count"></div>
          </div>
          <div class="benchmark-item">
            <div class="category">Multi-Session</div>
            <div class="score" id="bench-multisession">—</div>
            <div class="count" id="bench-multisession-count"></div>
          </div>
          <div class="benchmark-item">
            <div class="category">Abstention Rate</div>
            <div class="score" id="bench-abstention">—</div>
            <div class="count" id="bench-abstention-count"></div>
          </div>
          <div class="benchmark-item">
            <div class="category">Avg Latency</div>
            <div class="score" id="bench-latency">—</div>
            <div class="count">ms</div>
          </div>
          <div class="benchmark-item">
            <div class="category">Mode</div>
            <div class="score" id="bench-mode" style="font-size: 1rem;">—</div>
            <div class="count">mock vs live</div>
          </div>
        </div>
        <p style="color: #666; font-size: 0.75rem; margin-top: 1rem; text-align: center;">
          Run <code>npm run bench:mock</code> to update benchmark data
        </p>
      </div>
    </div>
  </div>

  <script>
    const token = "${escapeHtml(dashboardToken ?? "")}";

    function switchView(view) {
      history.pushState({}, "", "?view=" + view + "&token=" + token);
      document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
      document.getElementById("view-" + view).classList.add("active");
      document.querySelectorAll(".nav button").forEach((b, i) => {
        b.classList.toggle("active", ["overview", "timeline", "inspector", "benchmark"][i] === view);
      });
      if (view === "overview") loadOverview();
      if (view === "timeline") loadTimeline();
    }

    async function api(endpoint, params = {}) {
      const url = new URL("/api/" + endpoint + "?token=" + encodeURIComponent(token));
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    async function loadOverview() {
      try {
        const data = await api("overview");
        document.getElementById("memory-count").textContent = data.memoryCount ?? "?";
        document.getElementById("knowledge-count").textContent = data.knowledgeCount ?? "?";
        document.getElementById("queue-state").textContent = data.queueState ?? "unknown";
        document.getElementById("requests-today").textContent = data.requestCount ?? 0;

        const log = document.getElementById("recent-log");
        if (data.recentRequests && data.recentRequests.length > 0) {
          log.innerHTML = data.recentRequests.map(r => {
            const cls = r.abstained ? "op" : "success";
            return '<div class="log-entry"><span class="time">' + escapeHtml(r.timestamp) + '</span><span class="' + cls + '">' + escapeHtml(r.operation) + '</span> ' + escapeHtml(r.query?.slice(0, 50) ?? r.summary ?? "") + (r.abstained ? ' <span style="color:#f59e0b">[abstained]</span>' : '') + (r.error ? ' <span class="fail">error</span>' : '') + '</div>';
          }).join("");
        } else {
          log.innerHTML = '<div class="log-entry"><span class="time">—</span>No recent activity</div>';
        }
      } catch (e) {
        document.getElementById("recent-log").innerHTML = '<div class="error">Failed to load: ' + escapeHtml(e.message) + '</div>';
      }
    }

    async function loadTimeline() {
      try {
        const data = await api("timeline");
        const el = document.getElementById("timeline");
        if (data.versions && data.versions.length > 0) {
          el.innerHTML = data.versions.map(v => {
            const cls = v.valid_to ? "superseded" : "";
            return '<div class="timeline-item ' + cls + '"><div class="date">' + escapeHtml(v.valid_from ?? "") + ' → ' + escapeHtml(v.valid_to ?? "now") + '</div><div class="content">' + escapeHtml(v.excerpt?.slice(0, 120)) + '</div></div>';
          }).join("");
        } else {
          el.innerHTML = '<div class="timeline-item"><div class="date">—</div><div class="content">No facts stored yet. Run a query to populate.</div></div>';
        }
      } catch (e) {
        document.getElementById("timeline").innerHTML = '<div class="error">Failed to load: ' + escapeHtml(e.message) + '</div>';
      }
    }

    async function runQuery() {
      const query = document.getElementById("query-input").value;
      const mode = document.getElementById("mode-select").value;
      const asOf = document.getElementById("asof-input").value;
      const resultEl = document.getElementById("query-result");

      if (!query) {
        resultEl.innerHTML = '<div class="error">Please enter a query</div>';
        return;
      }

      resultEl.innerHTML = '<div class="loading">Running query...</div>';

      try {
        const data = await api("query", { query, mode, asOf: asOf || undefined });

        if (data.abstained) {
          resultEl.innerHTML = '<div class="abstention"><div class="reason">Abstained: ' + escapeHtml(data.reason ?? "unknown") + '</div><div class="message">Lorex does not have sufficient evidence to answer this question.</div></div>';
        } else {
          resultEl.innerHTML = '<div class="source-list">' +
            (data.sources || []).map(s => {
              const tag = s.corpus === "memory" ? "memory" : "knowledge";
              const status = s.valid_to ? "superseded" : "current";
              return '<div class="source-item"><div class="meta"><span class="tag ' + tag + '">' + escapeHtml(s.corpus) + '</span><span class="tag ' + status + '">' + escapeHtml(status) + '</span><span class="score">' + (s.score?.toFixed(2) ?? "—") + '</span></div><div class="content">' + escapeHtml(s.content?.slice(0, 300)) + '</div><div class="validity">' + escapeHtml(s.valid_from ?? "") + ' → ' + escapeHtml(s.valid_to ?? "now") + '</div></div>';
            }).join("") +
            '<div style="color: #888; font-size: 0.75rem; margin-top: 1rem;">Mode: ' + escapeHtml(data.mode_used) + ' | Sources: ' + (data.sources?.length ?? 0) + ' | Token cost: ' + Math.round(data.token_cost ?? 0) + '</div></div>';
        }

        loadOverview();
      } catch (e) {
        resultEl.innerHTML = '<div class="error">Query failed: ' + escapeHtml(e.message) + '</div>';
      }
    }

    function escapeHtml(str) {
      if (str === null || str === undefined) return "";
      return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    const params = new URLSearchParams(window.location.search);
    const view = params.get("view") || "overview";
    const urlToken = params.get("token");

    if (urlToken === token) {
      switchView(view);
    } else if (urlToken) {
      document.querySelector(".token-badge").innerHTML = "⚠ Token mismatch - refresh with correct token";
    }

    loadOverview();
  </script>
</body>
</html>`;
}

async function handleApi(state: DashboardState, path: string, params: URLSearchParams): Promise<Response> {
  const token = params.get("token");
  if (token !== dashboardToken) {
    return new Response(JSON.stringify({ error: "Invalid dashboard token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    if (path === "overview") {
      let memoryCount = 0;
      let knowledgeCount = 0;
      try {
        const snapshot = await state.engine.list({ type: "all", maxResults: 50 });
        for (const s of snapshot.sources) {
          if (s.corpus === "knowledge") knowledgeCount++;
          else memoryCount++;
        }
      } catch {
        // Store unreachable — leave counts at zero rather than failing the view.
      }
      const pending = state.engine.queueLength;
      return new Response(JSON.stringify({
        memoryCount,
        knowledgeCount,
        queueState: pending > 0 ? `${pending} pending` : "idle",
        requestCount: state.requestLog.length,
        recentRequests: state.requestLog.slice(-20).reverse(),
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (path === "timeline") {
      try {
        const receipt = await state.engine.history({ maxResults: 50 });
        return new Response(JSON.stringify({
          versions: receipt.sources.map(s => ({
            id: s.id,
            excerpt: s.excerpt,
            valid_from: s.valid_from,
            valid_to: s.valid_to,
            source_ref: s.source_ref,
            score: s.score,
          })),
        }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (path === "query") {
      const query = params.get("query");
      const mode = params.get("mode") as "fast" | "thinking" | undefined;
      const asOf = params.get("asOf") ?? undefined;

      if (!query) {
        return new Response(JSON.stringify({ error: "query parameter required" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const startTime = Date.now();
      try {
        const receipt = await state.engine.recall({ query, mode, asOf });
        const duration = Date.now() - startTime;

        state.requestLog.push({
          timestamp: new Date().toISOString(),
          operation: "recall",
          query,
          mode,
          asOf,
          sources: receipt.sources.length,
          abstained: receipt.abstained,
          abstentionReason: receipt.abstention_reason,
          tokenCost: receipt.token_cost,
          duration,
        });

        return new Response(JSON.stringify({
          sources: receipt.sources.map(s => ({
            id: s.id,
            corpus: s.corpus,
            excerpt: redactSecrets(s.excerpt ?? ""),
            content: redactSecrets(s.content ?? ""),
            score: s.score,
            valid_from: s.valid_from,
            valid_to: s.valid_to,
            source_ref: s.source_ref,
          })),
          mode_used: receipt.mode_used,
          token_cost: receipt.token_cost,
          abstained: receipt.abstained,
          reason: receipt.abstention_reason,
          confidence: receipt.confidence,
          request_id: receipt.request_id,
        }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "Unknown endpoint" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function startDashboard(
  engine: LorexEngine,
  host: string = DEFAULT_HOST,
  port: number = PORT,
): Promise<{ url: string; token: string; stop: () => void }> {
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("Dashboard must bind to localhost");
  }
  state = { engine, requestLog: [] };
  dashboardToken = generateToken();

  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");

    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}:${port}` && origin !== `http://localhost:${port}`) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      const path = url.pathname.slice(1);

      if (path === "" || path === "index.html" || path === "/") {
        const params = new URLSearchParams(url.search);
        const view = params.get("view") || "overview";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(buildHtml(view));
        return;
      }

      if (path.startsWith("api/")) {
        const endpoint = path.slice(4);
        const response = await handleApi(state, endpoint, url.searchParams);
        res.writeHead(response.status, { "Content-Type": "application/json" });
        res.end(await response.text());
        return;
      }

      res.writeHead(404);
      res.end("Not Found");
    } catch (e) {
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  });

  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryPort = (p: number): void => {
      server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && attempts < 10) {
          attempts++;
          tryPort(p + 1);
        } else {
          reject(e);
        }
      });
      server.listen(p, host, () => {
        resolve({
          url: `http://${host}:${p}?token=${encodeURIComponent(dashboardToken)}`,
          token: dashboardToken,
          stop: () => server.close(),
        });
      });
    };
    tryPort(port);
  });
}
