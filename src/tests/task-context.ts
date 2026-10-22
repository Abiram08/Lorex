import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import { safeTaskText, taskContext, validateTaskId } from "../interfaces/task-context.js";
import { LorexEngine } from "../engine.js";
import { resolveIdentity } from "../infrastructure/identity.js";
import { runHarnessEvent } from "../interfaces/harness.js";
import { runCli } from "../interfaces/cli.js";
import { countTokens } from "../ingestion/token-counter.js";

const dir = mkdtempSync(join(tmpdir(), "lorex-task-"));
const db = join(dir, "shared.db");
const claude = new SqliteStore({ path: db });
const codex = new SqliteStore({ path: db });
try {
  claude.createTask("project", "ISSUE-42", "Fix local memory handoff");
  const first = claude.appendTaskEvent("project", "ISSUE-42", "claude-code", "decision", "Use SQLite WAL", "c1");
  const second = codex.appendTaskEvent("project", "ISSUE-42", "codex", "progress", "Added task journal", "x1");
  assert.ok(second > first);
  assert.deepEqual(claude.getTask("project", "ISSUE-42", first)?.events.map((e) => e.seq), [second]);
  assert.match(taskContext(codex, "project", "ISSUE-42"), /claude-code\/decision.*Use SQLite WAL/);
  assert.match(taskContext(claude, "project", "ISSUE-42"), /codex\/progress.*Added task journal/);
  assert.equal(codex.getTask("other-project", "ISSUE-42"), null, "tasks stay project-scoped");
  assert.throws(() => codex.createTask("project", "ISSUE-42", "different brief"));
  assert.throws(() => validateTaskId("../escape"));
  assert.throws(() => safeTaskText("x".repeat(4001), 4000));
  process.env.LOREX_TASK = "ISSUE-42";
  process.env.LOREX_NO_LIMITS = "1";
  const engine = new LorexEngine(codex, resolveIdentity(dir, { collection: "project", agent: "codex" }));
  const injected = await runHarnessEvent(engine, { hook_event_name: "SessionStart", session_id: "s1" }, "codex");
  assert.match(injected, /Shared task ISSUE-42/);
  assert.match(injected, /claude-code\/decision/);
  assert.ok(countTokens(injected) <= 900, "task and memory share one bounded hook budget");
} finally {
  delete process.env.LOREX_TASK;
  claude.close();
  codex.close();
}
console.log("task context: cross-process visibility and isolation passed");

const oldCwd = process.cwd();
const oldHome = process.env.LOREX_HOME;
const oldLimits = process.env.LOREX_NO_LIMITS;
process.env.LOREX_HOME = dir;
process.env.LOREX_NO_LIMITS = "1";
process.chdir(dir);
try {
  await runCli(["task", "create", "CLI-1", "--brief", "Two agents test CLI parsing"]);
  await runCli(["task", "note", "--text", "Claude finished planning", "--agent", "claude-code"]);
  await runCli(["task", "note", "--text", "Codex started tests", "--agent", "codex"]);
  const identity = resolveIdentity(dir, { workspace: undefined });
  const cliStore = new SqliteStore({ path: join(dir, "local-store.db") });
  assert.equal(cliStore.getTask(identity.collection, "CLI-1")?.events.length, 2);
  cliStore.close();
  await runCli(["task", "leave"]);
} finally {
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.LOREX_HOME;
  else process.env.LOREX_HOME = oldHome;
  if (oldLimits === undefined) delete process.env.LOREX_NO_LIMITS;
  else process.env.LOREX_NO_LIMITS = oldLimits;
}
