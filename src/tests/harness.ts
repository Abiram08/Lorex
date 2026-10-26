/** End-to-end local harness regressions: scope, capture, long sessions, retries. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LorexEngine } from "../engine.js";
import { defaultWorkspace, loadConfig, projectRoot, saveConfig, saveProjectWorkspace } from "../infrastructure/config.js";
import { resolveIdentity } from "../infrastructure/identity.js";
import { MockHydraDB } from "../infrastructure/mock-hydradb.js";
import { SqliteStore } from "../infrastructure/sqlite-store.js";
import type { IngestMemoryInput, IngestResult } from "../infrastructure/store.js";
import { captureTranscript } from "../ingestion/session-capture.js";
import { runHarnessEvent } from "../interfaces/harness.js";

const root = mkdtempSync(join(tmpdir(), "lorex-harness-test-"));
const home = join(root, "home");
const projectA = mkdtempSync(join(root, "project-a-"));
const projectB = mkdtempSync(join(root, "project-b-"));
const oldCwd = process.cwd();
const oldHome = process.env.LOREX_HOME;
const oldWorkspace = process.env.LOREX_WORKSPACE;
process.env.LOREX_HOME = home;
delete process.env.LOREX_WORKSPACE;

try {
  // A legacy global workspace must not leak into a different project.
  saveConfig({ workspace: "legacy-global" });
  saveProjectWorkspace("project-a", projectA);
  saveProjectWorkspace("project-b", projectB);
  assert.equal(loadConfig(projectA).workspace, "project-a");
  assert.equal(loadConfig(projectB).workspace, "project-b");
  mkdirSync(join(projectA, "nested"));
  assert.equal(loadConfig(join(projectA, "nested")).workspace, "project-a", "nested agent cwd shares its project memory");
  assert.equal(projectRoot(join(projectA, "nested")), projectA, "setup targets the configured project root from a nested cwd");
  assert.notEqual(defaultWorkspace(projectA), defaultWorkspace(projectB), "same-named directories get distinct defaults");

  const storePath = join(home, "local-store.db");
  const engineA = new LorexEngine(new SqliteStore({ path: storePath }), resolveIdentity(projectA, { workspace: loadConfig(projectA).workspace, agent: "codex" }));
  const engineB = new LorexEngine(new SqliteStore({ path: storePath }), resolveIdentity(projectB, { workspace: loadConfig(projectB).workspace, agent: "codex" }));
  process.chdir(projectA);
  const prompt = { hook_event_name: "UserPromptSubmit", session_id: "codex-session-a", turn_id: "turn-1", prompt: "What store did we choose for sessions?" };
  assert.equal(await runHarnessEvent(engineA, prompt, "codex"), "");
  assert.equal(await runHarnessEvent(engineA, { hook_event_name: "Stop", session_id: "codex-session-a", turn_id: "turn-1", last_assistant_message: "We decided to use Redis for session storage because it is local and fast." }, "codex"), "{}");
  const recalled = await engineA.recall({ query: "Redis session storage" });
  assert.ok(recalled.sources.some((source) => source.content.includes("Redis")), "Codex hook learned the completed turn as verbatim evidence");
  const assistantFacts = await engineA.recall({ query: "Redis session storage", type: "memory" });
  assert.equal(assistantFacts.sources.length, 0, "assistant prose is not promoted into a verified fact");
  const agentBStore = new SqliteStore({ path: storePath });
  const agentB = new LorexEngine(agentBStore, resolveIdentity(projectA, { workspace: "project-a", agent: "opencode" }));
  const crossAgent = await agentB.recall({ query: "Redis session storage" });
  assert.ok(crossAgent.sources.some((source) => source.agent === "codex" && source.trust === "verbatim_source" &&
    source.source_session_id && source.content.includes("Redis")),
  "Agent B recalls Agent A's exact, attributed verbatim source");
  agentBStore.close();
  const other = await engineB.recall({ query: "Redis session storage" });
  assert.equal(other.sources.length, 0, "different project remains isolated");
  const relevant = await runHarnessEvent(engineA, { ...prompt, turn_id: "turn-2", prompt: "Why Redis for sessions?" }, "codex");
  assert.ok(relevant.includes("Redis"), "later prompt receives relevant learned context");
  assert.equal(await runHarnessEvent(engineA, { hook_event_name: "Stop", session_id: "codex-session-a", turn_id: "turn-1", last_assistant_message: "We decided to use Redis for session storage because it is local and fast." }, "codex"), "{}", "repeated stop is a no-op");
  await runHarnessEvent(engineA, {
    hook_event_name: "UserPromptSubmit", session_id: "codex-compaction", turn_id: "turn-compact",
    prompt: "Should build artifacts stay local?", timestamp: "2026-02-01T12:00:00Z",
  }, "codex");
  assert.equal(await runHarnessEvent(engineA, {
    hook_event_name: "PreCompact", session_id: "codex-compaction", turn_id: "turn-compact",
    response: "We decided to keep build artifacts local because deployments upload from the workspace.",
    timestamp: "2026-02-01T12:01:00Z",
  }, "codex"), "{}", "a completed turn is captured before context compaction");
  assert.ok((await engineA.recall({ query: "build artifacts local" })).sources.some((source) => source.content.includes("artifacts local")));
  await runHarnessEvent(engineA, { hook_event_name: "UserPromptSubmit", session_id: "codex-secret", turn_id: "secret-turn", prompt: "Use api_key=very-secret-value-12345 only for this request" }, "codex");
  const pendingDir = join(home, "harness-pending");
  const staged = readdirSync(pendingDir).map((name) => readFileSync(join(pendingDir, name), "utf8")).join("\n");
  assert.ok(!staged.includes("very-secret-value-12345") && staged.includes("[REDACTED secret]"), "pending hook prompts redact credentials");
  await runHarnessEvent(engineA, { hook_event_name: "Stop", session_id: "codex-secret", turn_id: "secret-turn", last_assistant_message: "The one-time request is complete." }, "codex");

  // Cursor's native hook names and conversation/generation identifiers.
  const cursorEngine = new LorexEngine(new MockHydraDB(), resolveIdentity(projectA, { workspace: "cursor-fixture", agent: "cursor" }));
  const cursorStart = JSON.parse(await runHarnessEvent(cursorEngine, { hook_event_name: "sessionStart", conversation_id: "cursor-session" }, "cursor")) as { additional_context?: string };
  assert.equal(typeof cursorStart.additional_context, "string");
  const cursorPrompt = { hook_event_name: "beforeSubmitPrompt", conversation_id: "cursor-session", generation_id: "generation-1", prompt: "Where should we store durable sessions?" };
  assert.deepEqual(JSON.parse(await runHarnessEvent(cursorEngine, cursorPrompt, "cursor")), { continue: true });
  assert.equal(await runHarnessEvent(cursorEngine, { hook_event_name: "afterAgentResponse", conversation_id: "cursor-session", generation_id: "generation-1", text: "We decided to keep durable sessions in local SQLite." }, "cursor"), "{}");
  assert.ok((await cursorEngine.recall({ query: "SQLite durable sessions" })).sources.length > 0, "Cursor response learned through native hook fields");

  // Claude's actual nested message.content layout, not the old synthetic shape.
  const claude = join(root, "claude-session.jsonl");
  writeFileSync(claude, [
    JSON.stringify({ type: "user", message: { role: "user", content: "We must keep all memory local to this machine." }, timestamp: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The project uses local SQLite for memory." }, { type: "tool_use", name: "Bash" }] }, timestamp: "2026-01-01T00:00:01Z" }),
  ].join("\n"));
  const claudeEngine = new LorexEngine(new MockHydraDB(), resolveIdentity(projectA, { workspace: "claude-fixture", agent: "claude-code" }));
  const first = await captureTranscript(claudeEngine, { transcriptPath: claude, incremental: true, agent: "claude-code" });
  assert.equal(first.errors.length, 0);
  assert.ok(first.factCount >= 1, "Claude nested content extracted");
  assert.equal((await captureTranscript(claudeEngine, { transcriptPath: claude, incremental: true })).chunkCount, 0, "exact transcript cursor is idempotent");

  // Codex/OpenAI Responses transcripts label content blocks input_text and
  // output_text rather than Claude's text. Both sides must remain evidence.
  const codexTranscript = join(root, "codex-session.jsonl");
  writeFileSync(codexTranscript, [
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "We must retain receipts for every fact." }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "I will retain the evidence receipts." }] } }),
  ].join("\n"));
  const codexTranscriptResult = await captureTranscript(claudeEngine, { transcriptPath: codexTranscript, incremental: true, agent: "codex" });
  assert.equal(codexTranscriptResult.errors.length, 0);
  assert.ok(codexTranscriptResult.chunkCount > 0 && codexTranscriptResult.factCount > 0, "Responses content blocks are learned");

  // One old session can exceed the engine's per-ingest turn cap: capture batches it.
  const long = join(root, "long-session.jsonl");
  const lines = Array.from({ length: 2100 }, (_, i) => JSON.stringify({ role: "user", content: i === 2099 ? "We decided to use SQLite for durable local history." : `Turn ${i}: continuing the task.` }));
  writeFileSync(long, lines.join("\n"));
  const longResult = await captureTranscript(claudeEngine, { transcriptPath: long, incremental: true });
  assert.equal(longResult.errors.length, 0, `long capture: ${longResult.errors.join("; ")}`);
  assert.ok(longResult.chunkCount > 20 && longResult.factCount > 0, "over 2,000 turns captured in bounded batches");

  // A replaced transcript starts over instead of being skipped by a stale cursor.
  writeFileSync(claude, JSON.stringify({ type: "user", message: { content: "We decided to replace the old local store." } }));
  const replaced = await captureTranscript(claudeEngine, { transcriptPath: claude, incremental: true });
  assert.ok(replaced.chunkCount > 0, "replacement resets the cursor");

  // Keeping the first line is common when an app rewrites a JSONL transcript.
  // The boundary hash must catch a changed second line at the same file size.
  const rewritten = join(root, "rewritten-session.jsonl");
  const stableFirst = JSON.stringify({ role: "user", content: "We decided to use local receipts." });
  writeFileSync(rewritten, [stableFirst, JSON.stringify({ role: "assistant", content: "The first design was retained." })].join("\n"));
  assert.ok((await captureTranscript(claudeEngine, { transcriptPath: rewritten, incremental: true })).chunkCount > 0);
  writeFileSync(rewritten, [stableFirst, JSON.stringify({ role: "assistant", content: "The second design was retained." })].join("\n"));
  assert.ok((await captureTranscript(claudeEngine, { transcriptPath: rewritten, incremental: true })).chunkCount > 0, "in-place transcript rewrite is replayed");

  // Chunk success plus fact failure must not commit the cursor past missing facts.
  class PartialStore extends MockHydraDB {
    failOnce = true;
    override async ingestMemory(input: IngestMemoryInput): Promise<IngestResult> {
      if (this.failOnce) { this.failOnce = false; throw new Error("injected fact-write failure"); }
      return super.ingestMemory(input);
    }
  }
  const partialFile = join(root, "partial-session.jsonl");
  writeFileSync(partialFile, JSON.stringify({ role: "user", content: "We decided to use Postgres for analytics." }));
  const partialEngine = new LorexEngine(new PartialStore(), resolveIdentity(projectA, { workspace: "partial-fixture" }));
  const partial = await captureTranscript(partialEngine, { transcriptPath: partialFile, incremental: true });
  assert.equal(partial.partial, true);
  assert.ok(partial.errors.some((error) => error.includes("injected")));
  const retry = await captureTranscript(partialEngine, { transcriptPath: partialFile, incremental: true });
  assert.equal(retry.errors.length, 0);
  assert.ok(retry.factCount > 0, "failed fact batch retried instead of skipped");
  assert.ok(readFileSync(join(projectA, ".lorex.json"), "utf8").includes("project-a"));
} finally {
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.LOREX_HOME; else process.env.LOREX_HOME = oldHome;
  if (oldWorkspace === undefined) delete process.env.LOREX_WORKSPACE; else process.env.LOREX_WORKSPACE = oldWorkspace;
}

console.log("✓ harness end-to-end tests passed");
