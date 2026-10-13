import { spawn, execFileSync } from "node:child_process";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WS = "verify_" + Date.now().toString(36);

// Everything runs against a throwaway LOREX_HOME so the suite can never read or
// delete the operator's real ~/.lorex store.
const VERIFY_HOME = mkdtempSync(join(tmpdir(), "lorex-verify-"));
const VERIFY_ENV = { ...process.env, LOREX_NO_LIMITS: "1", LOREX_HOME: VERIFY_HOME };

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
    env: VERIFY_ENV,
  });
}
const json = (args) => JSON.parse(lorex([...args, "--json"]));

/** Wait for a spawned server to print its URL.
 *
 * A cold node start plus SQLite init plus a socket bind can comfortably exceed
 * 8s on a loaded machine, so the deadline is generous. stderr is captured (it
 * used to be discarded) and a timeout reports what the process actually said,
 * rather than letting a later `new URL("")` fail with "Failed to parse URL from".
 */
async function waitForUrl(proc, label, deadlineMs = 30000) {
  let out = "";
  let err = "";
  let timer;
  return await new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      proc.stdout.removeListener("data", onData);
      const m = out.match(/http:\/\/\S+/);
      resolve({ url: m ? m[0] : "", out, err });
    };
    const onData = (d) => { out += d.toString(); if (/http:\/\/\S+/.test(out)) done(); };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (d) => { err += d.toString(); });
    proc.on("exit", (code) => {
      if (code !== 0) err += `\n[${label}] exited with code ${code}`;
      done();
    });
    timer = setTimeout(done, deadlineMs);
  });
}

// ── 1. MCP protocol ────────────────────────────────────────────────────────
head("1. MCP server — real JSON-RPC handshake over stdio");

const mcpResult = await new Promise((resolve) => {
  const child = spawn("node", ["dist/index.js", "start", "--mock", "--workspace", WS], {
    stdio: ["pipe", "pipe", "pipe"],
    env: VERIFY_ENV,
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
        if (msg.id === 5) seen.over = msg;
        if (msg.id === 6) seen.atBound = msg;
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
    // One past the advertised maximum: the validator must reject it, which is
    // only fair if the maximum is actually advertised (checked below).
    if (seen.recall && !seen.sentOver) {
      seen.sentOver = true;
      send({
        jsonrpc: "2.0", id: 5, method: "tools/call",
        params: { name: "recall", arguments: { query: "session storage", maxResults: 51 } },
      });
    }
    // Exactly at the advertised maximum: must be accepted.
    if (seen.over && !seen.sentAtBound) {
      seen.sentAtBound = true;
      send({
        jsonrpc: "2.0", id: 6, method: "tools/call",
        params: { name: "recall", arguments: { query: "session storage", maxResults: 50 } },
      });
    }
    if (seen.atBound) {
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
ok("tools/list returns 18 tools", s.tools?.result?.tools?.length === 18, `got ${s.tools?.result?.tools?.length}`);
ok("tools/call remember succeeds", s.remember?.result && !s.remember.result.isError);
ok("tools/call recall succeeds", s.recall?.result && !s.recall.result.isError);
const recallText = s.recall?.result?.content?.[1]?.text ?? "";
ok("recall receipt is valid JSON", (() => { try { JSON.parse(recallText); return true; } catch { return false; } })());
ok("recall found the fact written over MCP", recallText.includes("Redis"));
ok("stdout carried no non-JSON noise", !mcpResult.raw.split("\n").some((l) => l.trim() && !l.trim().startsWith("{")));

// An advertised schema looser than the validator is a trap: a client follows the
// docs and gets rejected. Bounds live in one place now (BOUNDS), so assert both
// that they are published and that the validator matches them at the boundary.
{
  const byName = new Map((s.tools?.result?.tools ?? []).map((t) => [t.name, t]));
  const props = (name) => byName.get(name)?.inputSchema?.properties ?? {};

  ok("recall advertises maxResults 1..50", props("recall").maxResults?.minimum === 1 && props("recall").maxResults?.maximum === 50, JSON.stringify(props("recall").maxResults));
  ok("recall advertises maxTokens 256..2500", props("recall").maxTokens?.minimum === 256 && props("recall").maxTokens?.maximum === 2500, JSON.stringify(props("recall").maxTokens));
  ok("remember advertises the fact length cap", props("remember").fact?.maxLength === 8000);
  ok("remember advertises the ttlSeconds bound", props("remember").ttlSeconds?.maximum === 31536000);
  ok("context_pack advertises its maxTokens bound", props("context_pack").maxTokens?.maximum === 2500);
  ok("learn advertises the content length cap", props("learn").content?.maxLength === 200000);

  ok("a value one past the advertised maximum is rejected", s.over?.result?.isError === true, JSON.stringify(s.over?.result ?? null).slice(0, 120));
  ok("a value exactly at the advertised maximum is accepted", s.atBound?.result?.isError === false);
}

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

// ── 2b. Context pack ────────────────────────────────────────────────────────
head("2b. Context pack — typed session-start injection");

const ctxPack = json(["context", "--query", "session storage"]);
ok("context returns a Receipt with op context", ctxPack.op === "context");
ok("context packs a typed section", /## (Decisions|Facts|Constraints)/.test(ctxPack.context ?? ""));
ok("context carries the stored fact", (ctxPack.context ?? "").includes("Redis"));
ok("context reports a token budget", typeof ctxPack.token_cost === "number" && ctxPack.token_cost > 0);

const ctxPlain = execFileSync("node", ["dist/index.js", "context", "--plain", "--mock", "--workspace", WS], {
  encoding: "utf8",
  env: VERIFY_ENV,
});
ok("context --plain prints the pack, not JSON", ctxPlain.trimStart().startsWith("# Project memory"));

const ctxEmpty = json(["context", "--query", "quarterly travel reimbursement policy zebra"]);
ok("context abstains when nothing matches", ctxEmpty.abstained === true || (ctxEmpty.context ?? "").length === 0);

// ── 2c. Discoverability and memory quality ──────────────────────────────────
head("2c. help --json and reflect");

const helpJson = json(["help"]);
ok("help --json lists the command surface", Array.isArray(helpJson.commands) && helpJson.commands.length > 20, `got ${helpJson.commands?.length}`);
ok("help --json includes reflect", (helpJson.commands ?? []).some((c) => c.name === "reflect"));
ok("help --json entries carry usage", (helpJson.commands ?? []).every((c) => c.name && c.usage));

const reflected = json(["reflect"]);
ok("reflect returns a report", reflected.op === "reflect" && typeof reflected.healthy === "boolean");
// verify drives the CLI with --mock, which has no lifecycle columns; reflect must
// say it cannot measure rather than crash (the real-store path is covered by
// test:engine, which runs against SQLite).
ok("reflect reports the backend it can measure on", reflected.available === false, `available=${reflected.available}`);
ok("reflect reports findings as a list", Array.isArray(reflected.findings));
ok("reflect carries a summary", typeof reflected.summary === "string" && reflected.summary.length > 0);

// ── 3. Temporal ────────────────────────────────────────────────────────────
head("3. Temporal — asOf returns what was true then");

const past = json(["recall", "--query", "session storage", "--asOf", "2023-01-15T00:00:00Z"]);
ok("asOf query returns a receipt", past.op === "recall");
ok("asOf is echoed back", past.as_of?.startsWith("2023-01-15"));
ok("asOf returns the value that was true then", !past.abstained && (past.sources ?? []).some((x) => (x.content ?? "").includes("MongoDB")), `sources=${(past.sources ?? []).map((x) => x.content).join("|")}`);

// History exists, but nothing was valid that early: refuse, do not answer from
// a different era.
const prehistory = json(["recall", "--query", "session storage", "--asOf", "2020-01-01T00:00:00Z"]);
ok("asOf before any fact abstains", prehistory.abstained === true, `reason=${prehistory.abstention_reason}`);
ok("asOf before any fact says outside_time_window", prehistory.abstention_reason === "outside_time_window");
ok("asOf before any fact offers no answer", prehistory.answer === undefined);

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
  { stdio: "ignore", env: VERIFY_ENV });
const resumed = JSON.parse(execFileSync("node", ["dist/index.js", "resume", "--json", "--mock", "--workspace", WS, "--agent", "codex"], { encoding: "utf8", env: VERIFY_ENV }));
ok("resume does not abstain on a populated workspace", resumed.abstained === false);
ok("resume names the other agent", resumed.summary.includes("claude-code"));
ok("resume surfaces the latest handoff", resumed.summary.includes("Migrate the logout path"));
ok("resume lists contributing agents", (resumed.result?.contributing_agents ?? []).length >= 1);

// ── 6. Forget ──────────────────────────────────────────────────────────────
head("6. Forget — soft delete");

// Its own workspace: `forget` is scoped to one topic key by design, and other
// sections write unrelated topics that also mention Redis.
const FWS = WS + "_forget";
const inF = (args) => execFileSync("node", ["dist/index.js", ...args, "--mock", "--workspace", FWS], { encoding: "utf8", env: VERIFY_ENV });
inF(["remember", "--fact", "We use MongoDB for session storage", "--id", "db", "--validFrom", "2023-01-10T12:00:00Z"]);
inF(["remember", "--fact", "We switched to Redis for session storage", "--id", "db", "--validFrom", "2023-02-02T12:00:00Z"]);

const forgot = JSON.parse(inF(["forget", "--factId", "db", "--json"]));
ok("forget closes the topic", forgot.op === "forget" && forgot.sources.length >= 1);

const afterForget = JSON.parse(inF(["recall", "--query", "what do we use for session storage", "--json"]));
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

// ── 9. Doctor + safety ─────────────────────────────────────────────────────
head("9. Doctor and input safety");

const doctor = execFileSync("node", ["dist/index.js", "doctor", "--mock", "--workspace", WS], { encoding: "utf8", env: VERIFY_ENV });
ok("doctor completes a smoke test", doctor.includes("smoke complete"));
ok("doctor reports identity provenance", doctor.includes("resolved from"));
ok("doctor is quiet about warnings when a workspace is named", !doctor.includes("[warn] identity"));

let rejected = false;
try {
  execFileSync("node", ["dist/index.js", "remember", "--fact", "x".repeat(20000), "--mock", "--workspace", WS], { stdio: "pipe", env: VERIFY_ENV });
} catch { rejected = true; }
ok("oversized payload is rejected", rejected);

const noArgs = execFileSync("node", ["dist/index.js", "remember", "--mock", "--workspace", WS], { encoding: "utf8", env: VERIFY_ENV });
ok("missing required flag returns a clear error", noArgs.includes("required"));

// ── 10. Daemon + console ───────────────────────────────────────────────────
head("10. Daemon and console");

const DAEMON_PORT = 6300 + (process.pid % 700);
const daemonProc = spawn(
  "node",
  ["dist/index.js", "daemon", "run", "--port", String(DAEMON_PORT)],
  { stdio: ["ignore", "pipe", "pipe"], env: VERIFY_ENV },
);
const daemonBoot = await waitForUrl(daemonProc, "daemon");
try {
  const base = `http://127.0.0.1:${DAEMON_PORT}`;
  ok("daemon prints its listening URL", daemonBoot.url.includes(String(DAEMON_PORT)), daemonBoot.url || daemonBoot.err.slice(-300));

  const health = await (await fetch(`${base}/health`)).json();
  ok("daemon answers /health", health.ok === true, JSON.stringify(health).slice(0, 200));

  const consolePage = await fetch(`${base}/`);
  const consoleHtml = await consolePage.text();
  ok("console page is served", consolePage.status === 200 && consoleHtml.includes("Lorex — Local console"));
  ok("console assets are served", (await fetch(`${base}/app.js`)).status === 200);

  const learned = await (await fetch(`${base}/v1/knowledge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "The local API console keeps reference notes in the knowledge corpus.", sourceRef: "console-guide" }),
  })).json();
  ok("console stores source text", learned.ok === true);

  const add = await (await fetch(`${base}/v1/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Daemon verify probe uses SQLite WAL because concurrent hooks" }),
  })).json();
  ok("daemon stores a memory via the API", add.ok === true, JSON.stringify(add).slice(0, 200));

  const search = await (await fetch(`${base}/v4/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "what does the daemon verify probe use?" }),
  })).json();
  ok(
    "daemon recalls the probe",
    (search.answer ?? "").includes("SQLite") || (search.sources ?? []).some((s) => (s.excerpt ?? "").includes("SQLite")),
    JSON.stringify(search).slice(0, 200),
  );

  const pack = await (await fetch(`${base}/v1/context/plain`)).text();
  ok("snapshot context pack includes the probe", pack.includes("SQLite"));

  const hook = await (await fetch(`${base}/v1/hooks/session-start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: process.cwd() }),
  })).json();
  ok("session-start hook returns the injectable pack", (hook.text ?? "").includes("SQLite"), JSON.stringify(hook).slice(0, 200));

  const status = await (await fetch(`${base}/v1/status`)).json();
  ok("status reports a current space", status.ok === true && Boolean(status.spaces?.current?.id));

  const reviews = await (await fetch(`${base}/v1/reviews`)).json();
  ok("review queue endpoint is stable", Array.isArray(reviews.items));
} catch (e) {
  ok("daemon reachable", false, e.message);
} finally {
  daemonProc.kill();
  await new Promise((resolve) => setTimeout(resolve, 400));
}

const daemonStatus = execFileSync("node", ["dist/index.js", "daemon", "status"], { encoding: "utf8", env: VERIFY_ENV });
ok("daemon status says not running after exit (stale lock ignored)", daemonStatus.includes("not running"), daemonStatus.trim());

// ── summary ────────────────────────────────────────────────────────────────
if (existsSync("verify-graph.html")) rmSync("verify-graph.html");
// The throwaway LOREX_HOME from this run; the operator's real store is untouched.
if (existsSync(VERIFY_HOME)) rmSync(VERIFY_HOME, { recursive: true, force: true });

console.log(`\n${"═".repeat(58)}`);
console.log(`  ${pass} passed · ${fail} failed`);
if (failures.length) {
  console.log("\n  Failures:");
  for (const f of failures) console.log(`    · ${f}`);
}
console.log("═".repeat(58));
process.exit(fail ? 1 : 0);
