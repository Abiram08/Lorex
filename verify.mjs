import { spawn, execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WS = "verify_" + Date.now().toString(36);
let pass = 0;
let fail = 0;
const failures = [];

function ok(name, condition, detail) {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function head(t) {
  console.log(`\n${t}\n${"─".repeat(t.length)}`);
}

function lorex(args) {
  return execFileSync("node", ["dist/index.js", ...args, "--mock", "--workspace", WS], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LOREX_NO_LIMITS: "1" },
  });
}
const json = (args) => JSON.parse(lorex(args));

const mockStore = join(homedir(), ".lorex", "mock-store.json");
if (existsSync(mockStore)) rmSync(mockStore);

// ── 1. MCP protocol ────────────────────────────────────────────────────────
head("1. MCP server — real JSON-RPC handshake over stdio");

const mcpResult = await new Promise((resolve) => {
  const child = spawn("node", ["dist/index.js", "start", "--mock", "--workspace", WS], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LOREX_NO_LIMITS: "1" },
  });
  let buf = "";
  const seen = {};
  const timer = setTimeout(() => {
    child.kill();
    resolve({ seen, raw: buf });
  }, 9000);

  child.stdout.on("data", (d) => {
    buf += d.toString();
    for (const line of buf.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id === 1) seen.init = msg;
        if (msg.id === 2) seen.tools = msg;
        if (msg.id === 3) seen.remember = msg;
        if (msg.id === 4) seen.recall = msg;
      } catch {}
    }
    if (seen.init && !seen.sentList) {
      seen.sentList = true;
      send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    }
    if (seen.tools && !seen.sentCall) {
      seen.sentCall = true;
      send({
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "remember", arguments: { fact: "Session storage moved to Redis", id: "session_store", because: "Atlas kept timing out" } },
      });
    }
    if (seen.remember && !seen.sentRecall) {
      seen.sentRecall = true;
      send({
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "recall", arguments: { query: "what do we use for session storage" } },
      });
    }
    if (seen.recall) {
      clearTimeout(timer);
      child.kill();
      resolve({ seen, raw: buf });
    }
  });

  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  send({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify", version: "1" } },
  });
});

const s = mcpResult.seen;
ok("initialize returns a result", !!s.init?.result, s.init ? undefined : "no response");
ok("server identifies itself as lorex", s.init?.result?.serverInfo?.name === "lorex");
ok("tools/list returns 12 tools", s.tools?.result?.tools?.length === 12, `got ${s.tools?.result?.tools?.length}`);
ok("tools/call remember succeeds", s.remember?.result && !s.remember.result.isError);
ok("tools/call recall succeeds", s.recall?.result && !s.recall.result.isError);
const recallText = s.recall?.result?.content?.[1]?.text ?? "";
ok("recall receipt is valid JSON", (() => { try { JSON.parse(recallText); return true; } catch { return false; } })());
ok("recall found the fact written over MCP", recallText.includes("Redis"));
ok("stdout carried no non-JSON noise", !mcpResult.raw.split("\n").some((l) => l.trim() && !l.trim().startsWith("{")));

// ── 2. Memory layer ────────────────────────────────────────────────────────
head("2. Memory layer — versioning, supersession, causality");

lorex(["remember", "--fact", "We use MongoDB for session storage", "--id", "db", "--validFrom", "2023-01-10T12:00:00Z"]);
lorex(["remember", "--fact", "We switched to Redis for session storage", "--id", "db", "--validFrom", "2023-02-02T12:00:00Z", "--because", "Atlas kept timing out"]);

const hist = json(["history", "--factId", "db"]);
ok("history returns both versions", hist.sources.length === 2, `got ${hist.sources.length}`);
ok("older version is marked superseded", hist.sources.some((x) => x.status === "superseded"));
ok("newer version is current", hist.sources.some((x) => x.status === "current"));
ok("superseded version has a closed interval", hist.sources.some((x) => x.status === "superseded" && x.valid_to));

const why = json(["why", "--factId", "db"]);
ok("why returns a causal chain", !why.abstained);
ok("why records the stated reason", (why.answer ?? "").includes("Atlas kept timing out"));

const recalled = json(["recall", "--query", "what do we use for session storage"]);
ok("recall ranks the current value first", (recalled.sources[0]?.content ?? "").includes("Redis"));
ok("recall exposes status on sources", recalled.sources.some((x) => x.status === "current"));
ok("recall reports compression stats", !!recalled.compression);
ok("recall reports a relevance score", typeof recalled.relevance === "number");

// ── 3. Temporal ────────────────────────────────────────────────────────────
head("3. Temporal — asOf returns what was true then");

const past = json(["recall", "--query", "session storage", "--asOf", "2023-01-15T00:00:00Z"]);
ok("asOf query returns a receipt", past.op === "recall");
ok("asOf is echoed back", past.as_of?.startsWith("2023-01-15"));

// ── 4. Abstention ──────────────────────────────────────────────────────────
head("4. Abstention — declines without inventing");

const abstained = json(["recall", "--query", "what is our quarterly travel reimbursement policy"]);
ok("declines an unsupported question", abstained.abstained === true, `reason=${abstained.abstention_reason}`);
ok("gives a machine-readable reason", !!abstained.abstention_reason);
ok("withholds the claim", abstained.answer === undefined);

// ── 5. Cross-agent ─────────────────────────────────────────────────────────
head("5. Shared memory — handoff and resume across agents");

execFileSync("node", ["dist/index.js", "handoff", "--decision", "Login path migrated to Redis",
  "--next", "Migrate the logout path", "--mock", "--workspace", WS, "--agent", "claude-code"],
  { stdio: "ignore", env: { ...process.env, LOREX_NO_LIMITS: "1" } });
const resumed = JSON.parse(execFileSync("node", ["dist/index.js", "resume", "--mock", "--workspace", WS, "--agent", "codex"], { encoding: "utf8", env: { ...process.env, LOREX_NO_LIMITS: "1" } }));
ok("resume does not abstain on a populated workspace", resumed.abstained === false);
ok("resume names the other agent", resumed.summary.includes("claude-code"));
ok("resume surfaces the latest handoff", resumed.summary.includes("Migrate the logout path"));
ok("resume lists contributing agents", (resumed.result?.contributing_agents ?? []).length >= 1);

// ── 6. Forget ──────────────────────────────────────────────────────────────
head("6. Forget — soft delete");

// Its own workspace: `forget` is scoped to one topic key by design, and other
// sections write unrelated topics that also mention Redis.
const FWS = WS + "_forget";
const inF = (args) => execFileSync("node", ["dist/index.js", ...args, "--mock", "--workspace", FWS], { encoding: "utf8", env: { ...process.env, LOREX_NO_LIMITS: "1" } });
inF(["remember", "--fact", "We use MongoDB for session storage", "--id", "db", "--validFrom", "2023-01-10T12:00:00Z"]);
inF(["remember", "--fact", "We switched to Redis for session storage", "--id", "db", "--validFrom", "2023-02-02T12:00:00Z"]);

const forgot = JSON.parse(inF(["forget", "--factId", "db"]));
ok("forget closes the topic", forgot.op === "forget" && forgot.sources.length >= 1);

const afterForget = JSON.parse(inF(["recall", "--query", "what do we use for session storage"]));
const stillCurrent = (afterForget.sources ?? []).filter((x) => x.status === "current");
ok("no current value survives a forget", stillCurrent.length === 0, `${stillCurrent.length} still current`);
ok("history is retained, not deleted", (afterForget.sources ?? []).length >= 1);

// ── 7. Knowledge + capture ─────────────────────────────────────────────────
head("7. Knowledge corpus and session capture");

lorex(["learn", "--content", "The deploy pipeline runs on GitHub Actions every Friday afternoon.", "--sourceRef", "runbook"]);
const learned = json(["recall", "--query", "deploy pipeline GitHub Actions"]);
ok("learned content is retrievable", JSON.stringify(learned.sources).includes("GitHub Actions"));

// ── 8. Context graph ───────────────────────────────────────────────────────
head("8. Context graph");

const graphOut = json(["graph", "--query", "session storage", "--out", "verify-graph.html"]);
ok("graph command renders", graphOut.op === "graph" && graphOut.nodes > 0);
ok("graph includes HydraDB entities", (graphOut.stats?.entities ?? 0) > 0, `entities=${graphOut.stats?.entities}`);
ok("graph file written", existsSync("verify-graph.html"));

// ── 9. Live graph server ───────────────────────────────────────────────────
head("9. Live graph server");

const liveProc = spawn("node", ["dist/index.js", "graph", "--live", "--mock", "--workspace", WS, "--port", "4321"], { stdio: ["ignore", "pipe", "ignore"] });
let liveUrl = "";
await new Promise((resolve) => {
  liveProc.stdout.on("data", (d) => {
    const m = d.toString().match(/http:\/\/\S+/);
    if (m) { liveUrl = m[0]; resolve(); }
  });
  setTimeout(resolve, 8000);
});
try {
  ok("live server prints a URL with its token", liveUrl.includes("token="));
  const unauth = await fetch("http://127.0.0.1:4321/graph.json");
  ok("live server rejects a request without the token", unauth.status === 403, `status=${unauth.status}`);

  const page = await fetch(liveUrl);
  const html = await page.text();
  ok("live server serves the page", page.status === 200);
  ok("page is pure black", html.includes("--bg:#000000"));
  ok("page polls for updates", html.includes("/graph.json"));

  const graphUrl = liveUrl.replace(/\?token=.*/, "") + "/graph.json" + liveUrl.slice(liveUrl.indexOf("?"));
  const before = (await (await fetch(graphUrl)).json()).nodes.length;
  lorex(["remember", "--fact", "We use Vitest as our test runner", "--id", "tests"]);
  await new Promise((r) => setTimeout(r, 600));
  const after = (await (await fetch(graphUrl)).json()).nodes.length;
  ok("graph grows when an agent writes", after > before, `${before} → ${after}`);
} catch (e) {
  ok("live graph server reachable", false, e.message);
} finally {
  liveProc.kill();
}

// ── 10. Dashboard ──────────────────────────────────────────────────────────
head("10. Dashboard");

const dashProc = spawn("node", ["dist/index.js", "dashboard", "--mock", "--workspace", WS], { stdio: ["ignore", "pipe", "ignore"] });
let dashUrl = "";
await new Promise((resolve) => {
  dashProc.stdout.on("data", (d) => {
    const m = d.toString().match(/http:\/\/\S+/);
    if (m) { dashUrl = m[0]; resolve(); }
  });
  setTimeout(resolve, 8000);
});
try {
  ok("dashboard prints a URL with its token", dashUrl.includes("token="));
  const page = await fetch(dashUrl);
  ok("dashboard serves the page", page.status === 200);
  const unauth = await fetch("http://127.0.0.1:3000/api/overview");
  ok("dashboard rejects an unauthenticated API call", unauth.status === 401 || unauth.status === 403, `status=${unauth.status}`);
} catch (e) {
  ok("dashboard reachable", false, e.message);
} finally {
  dashProc.kill();
}

// ── 11. Doctor + safety ────────────────────────────────────────────────────
head("11. Doctor and input safety");

const doctor = execFileSync("node", ["dist/index.js", "doctor", "--mock", "--workspace", WS], { encoding: "utf8", env: { ...process.env, LOREX_NO_LIMITS: "1" } });
ok("doctor completes a smoke test", doctor.includes("smoke complete"));
ok("doctor reports identity provenance", doctor.includes("resolved from"));
ok("doctor is quiet about warnings when a workspace is named", !doctor.includes("[warn] identity"));

let rejected = false;
try {
  execFileSync("node", ["dist/index.js", "remember", "--fact", "x".repeat(20000), "--mock", "--workspace", WS], { stdio: "pipe" });
} catch { rejected = true; }
ok("oversized payload is rejected", rejected);

const noArgs = execFileSync("node", ["dist/index.js", "remember", "--mock", "--workspace", WS], { encoding: "utf8" });
ok("missing required flag returns a clear error", noArgs.includes("required"));

// ── summary ────────────────────────────────────────────────────────────────
if (existsSync("verify-graph.html")) rmSync("verify-graph.html");
if (existsSync(mockStore)) rmSync(mockStore);

console.log(`\n${"═".repeat(58)}`);
console.log(`  ${pass} passed · ${fail} failed`);
if (failures.length) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    · ${f}`);
}
console.log("═".repeat(58));
process.exit(fail ? 1 : 0);
