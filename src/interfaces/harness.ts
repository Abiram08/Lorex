/** Agent lifecycle bridge: prompt-aware recall and evidence-backed turn capture. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LorexEngine } from "../engine.js";
import { captureTranscript } from "../ingestion/session-capture.js";
import { normalizeSession } from "../ingestion/normalizer.js";
import { loadConfig } from "../infrastructure/config.js";
import { storeDir } from "../infrastructure/paths.js";
import { redactSecrets } from "../infrastructure/secrets.js";
import { countTokens } from "../ingestion/token-counter.js";

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  turn_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  prompt?: string;
  last_assistant_message?: string | null;
  /** Common completion-field aliases used by agent hook protocols. */
  response?: string | null;
  assistant_message?: string | null;
  conversation_id?: string;
  generation_id?: string;
  workspace_roots?: string[];
  text?: string;
  timestamp?: string;
}

interface PendingTurn { prompt: string; turnId?: string; createdAt?: string }
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function pendingFile(engine: LorexEngine, input: HookInput): string {
  const identity = engine.getIdentity();
  const dir = storeDir(loadConfig().dataDir);
  return join(dir, "harness-pending", `${hash(`${identity.database}|${identity.collection}|${input.session_id}|${input.turn_id ?? "latest"}`)}.json`);
}

function stagePrompt(engine: LorexEngine, input: HookInput): void {
  if (!input.prompt?.trim() || !input.session_id) return;
  const file = pendingFile(engine, input);
  const dir = join(file, "..");
  mkdirSync(dir, { recursive: true });
  // Interrupted generations never emit Stop. Clear their small staging files
  // opportunistically so they cannot accumulate forever.
  for (const name of readdirSync(dir)) {
    const candidate = join(dir, name);
    try { if (name.endsWith(".json") && Date.now() - statSync(candidate).mtimeMs > PENDING_TTL_MS) unlinkSync(candidate); }
    catch { /* another hook may have removed it */ }
  }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({
    prompt: redactSecrets(input.prompt).text,
    turnId: input.turn_id,
    // Keep the time the user supplied when the hook protocol has one. It makes
    // temporal recall reflect the conversation rather than a later Stop event.
    createdAt: validTimestamp(input.timestamp) ?? new Date().toISOString(),
  } satisfies PendingTurn), { mode: 0o600 });
  renameSync(temp, file);
}

function validTimestamp(value: string | undefined): string | undefined {
  return value && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

/** Agents disagree on the completion field name. Treat the explicit response
 * aliases as equivalent and keep Cursor's native `text` as its final fallback. */
function assistantResponse(input: HookInput): string | undefined {
  const candidates = [
    input.last_assistant_message,
    input.assistant_message,
    input.response,
    input.text,
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function discardPending(engine: LorexEngine, input: HookInput): void {
  try { unlinkSync(pendingFile(engine, input)); } catch { /* no staged prompt */ }
}

function readPending(engine: LorexEngine, input: HookInput): PendingTurn | null {
  const file = pendingFile(engine, input);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as PendingTurn;
    return typeof parsed.prompt === "string" ? parsed : null;
  } catch { return null; }
}

async function captureHookTurn(engine: LorexEngine, input: HookInput, agent: string): Promise<boolean> {
  const pending = readPending(engine, input);
  const answer = assistantResponse(input);
  if (!pending?.prompt.trim() || !answer) return false;
  const identity = engine.getIdentity();
  const sessionId = `hook_${hash(`${agent}|${input.session_id}|${pending.turnId ?? pending.prompt}`)}`;
  const turns = [
    ...splitText(pending.prompt, "user", pending.createdAt),
    ...splitText(redactSecrets(answer).text, "assistant", validTimestamp(input.timestamp)),
  ];
  const session = normalizeSession(sessionId, identity.database, identity.collection, turns, { agent, source: "hook" });
  const result = await engine.ingestSession(session);
  if (result.partial || result.errors.length) throw new Error(result.errors.join("; ") || "partial hook ingestion");
  discardPending(engine, input);
  return result.chunkCount > 0 || result.factCount > 0;
}

function splitText(
  content: string,
  role: "user" | "assistant",
  occurredAt?: string,
): Array<{ role: "user" | "assistant"; content: string; occurredAt?: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string; occurredAt?: string }> = [];
  for (let i = 0; i < content.length; i += 40_000) out.push({ role, content: content.slice(i, i + 40_000), occurredAt });
  return out;
}

/** Output is hook-protocol text: only start/prompt events inject context. */
export async function runHarnessEvent(engine: LorexEngine, input: HookInput, agent: string): Promise<string> {
  const taskId = loadConfig().activeTask;
  const budget = taskId ? 500 : 900;
  const withinTokens = (text: string, limit: number): string => {
    if (countTokens(text) <= limit) return text;
    let low = 0, high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (countTokens(text.slice(0, mid)) <= limit) low = mid;
      else high = mid - 1;
    }
    return text.slice(0, low);
  };
  const withShared = (context: string): string => {
    const shared = withinTokens(engine.sharedTaskContext(taskId, 1800), 390);
    return shared ? `${shared}\n\n${withinTokens(context, 500)}` : context;
  };
  if (agent === "cursor") {
    input = {
      ...input,
      session_id: input.session_id ?? input.conversation_id,
      turn_id: input.turn_id ?? input.generation_id,
      cwd: input.cwd ?? input.workspace_roots?.[0],
    };
    if (input.hook_event_name === "sessionStart") {
      const pack = await engine.contextPack({ maxTokens: budget, maxResults: 12 });
      return JSON.stringify({ additional_context: withShared(pack.context ?? "") });
    }
    if (input.hook_event_name === "beforeSubmitPrompt") {
      stagePrompt(engine, input);
      return JSON.stringify({ continue: true });
    }
    if (input.hook_event_name === "afterAgentResponse") {
      const saved = await captureHookTurn(engine, { ...input, last_assistant_message: input.text }, agent);
      if (saved) await engine.dreamAuto();
      return "{}";
    }
    return "{}";
  }
  const event = input.hook_event_name;
  if (event === "SessionStart") {
    const pack = await engine.contextPack({ maxTokens: budget, maxResults: 12 });
    return withShared(pack.context ?? "");
  }
  if (event === "UserPromptSubmit") {
    stagePrompt(engine, input);
    const query = input.prompt?.trim().slice(0, 4_000);
    if (!query) return "";
    const pack = await engine.contextPack({ query, maxTokens: budget, maxResults: 10 });
    return withShared(pack.context ?? "");
  }
  if (event === "Stop" || event === "PreCompact") {
    let saved = false;
    // Claude's exact hook transcript is authoritative. Codex's transcript format
    // is not a stable hook API, so its prompt/response event pair is primary.
    if (agent === "claude-code" && input.transcript_path) {
      const result = await captureTranscript(engine, {
        transcriptPath: input.transcript_path,
        sessionId: input.session_id,
        agent,
        incremental: true,
      });
      if (result.errors.length) {
        // Hook payload fields are a safer fallback if a future transcript shape changes.
        saved = event === "Stop" ? await captureHookTurn(engine, input, agent) : false;
        if (!saved) throw new Error(result.errors.join("; "));
      } else {
        saved = result.chunkCount > 0 || result.factCount > 0;
        discardPending(engine, input);
      }
    // A compaction hook can include the completed response. Capture it now:
    // a later Stop hook may not have that response after compaction. If there
    // is no response, leave the staged prompt intact for Stop to finish.
    } else if (event === "Stop" || assistantResponse(input)) {
      saved = await captureHookTurn(engine, input, agent);
    }
    if (saved && event === "Stop") await engine.dreamAuto();
    return "{}";
  }
  return "{}";
}
