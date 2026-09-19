/**
 * Session capture: read agent transcript JSONL files, extract turns,
 * ingest into Lorex memory. Claude Code supported; other agents add parsers here.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { LorexEngine } from "../engine.js";
import { normalizeSession } from "./normalizer.js";

export interface CaptureOpts {
  transcriptPath: string;
  sessionId?: string;
  agent?: string;
  startedAt?: string;
}

export interface CaptureResult {
  sessionId: string;
  chunkCount: number;
  factCount: number;
  tokenCount: number;
  duplicateCount: number;
  errors: string[];
  partial: boolean;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

function extractText(entry: Record<string, unknown>): string {
  const msg = entry.message;
  if (typeof msg === "string") return msg;
  if (Array.isArray(msg)) return msg.map((m: Record<string, unknown>) => m.text ?? "").join("");
  if (typeof entry.content === "string") return entry.content;
  return "";
}

const ROLE_MAP: Record<string, Turn["role"]> = {
  human: "user", user: "user",
  assistant: "assistant", ai: "assistant",
};

/** Tolerant turn extraction: Claude ({type,message}), OpenAI ({role,content}),
 *  Codex session items, and {prompt,response} pairs. Unknown shapes are skipped. */
function entryToTurns(entry: Record<string, unknown>): Turn[] {
  const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;

  const claudeRole = ROLE_MAP[String(entry.type)];
  if (claudeRole) {
    const text = extractText(entry).trim();
    return text ? [{ role: claudeRole, content: text, timestamp: ts }] : [];
  }

  const role = ROLE_MAP[String(entry.role)];
  if (role) {
    const content = entry.content;
    const text = typeof content === "string" ? content
      : Array.isArray(content) ? content.map((m: Record<string, unknown>) => m.text ?? "").join("") : "";
    return text.trim() ? [{ role, content: text.trim(), timestamp: ts }] : [];
  }

  if (entry.type === "response_item" && entry.payload && typeof entry.payload === "object") {
    return entryToTurns({ ...(entry.payload as Record<string, unknown>), timestamp: ts });
  }

  const out: Turn[] = [];
  if (typeof entry.prompt === "string" && entry.prompt.trim()) {
    out.push({ role: "user", content: entry.prompt.trim(), timestamp: ts });
  }
  if (typeof entry.response === "string" && entry.response.trim()) {
    out.push({ role: "assistant", content: entry.response.trim(), timestamp: ts });
  }
  return out;
}

function parseTranscript(raw: string): Turn[] {
  return raw.split("\n").filter((l) => l.trim()).flatMap((line): Turn[] => {
    try {
      return entryToTurns(JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  });
}

export async function captureTranscript(engine: LorexEngine, opts: CaptureOpts): Promise<CaptureResult> {
  const empty = (sessionId: string, error: string): CaptureResult => ({
    sessionId, chunkCount: 0, factCount: 0, tokenCount: 0, duplicateCount: 0, errors: [error], partial: false,
  });

  if (!existsSync(opts.transcriptPath)) return empty(opts.sessionId ?? basename(opts.transcriptPath), `Not found: ${opts.transcriptPath}`);

  const turns = parseTranscript(readFileSync(opts.transcriptPath, "utf8"));
  if (!turns.length) return empty(opts.sessionId ?? basename(opts.transcriptPath), "No turns in transcript");

  const identity = engine.getIdentity();
  const sessionId = opts.sessionId ?? basename(opts.transcriptPath, ".jsonl");

  const session = normalizeSession(sessionId, identity.database, identity.collection, turns, {
    startedAt: opts.startedAt ?? turns[0]?.timestamp,
    agent: opts.agent ?? identity.agent,
    source: "transcript",
  });

  const result = await engine.ingestSession(session);
  return {
    sessionId: result.sessionId,
    chunkCount: result.chunkCount,
    factCount: result.factCount,
    tokenCount: result.tokenCount,
    duplicateCount: result.duplicateCount,
    errors: result.errors,
    partial: result.partial,
  };
}

const SESSION_DIRS: Array<{ dir: string; agent: string }> = [
  { dir: join(homedir(), ".claude", "projects"), agent: "claude-code" },
  { dir: join(homedir(), ".codex", "sessions"), agent: "codex" },
];

function newestJsonl(dir: string): string | null {
  let newest: string | null = null;
  let newestTime = 0;
  const walk = (d: string, depth: number): void => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch { return; }
    for (const file of entries) {
      const full = join(d, file);
      let stat;
      try {
        stat = statSync(full);
      } catch { continue; }
      if (stat.isDirectory()) { walk(full, depth + 1); continue; }
      if (!file.endsWith(".jsonl")) continue;
      if (stat.mtimeMs > newestTime) { newestTime = stat.mtimeMs; newest = full; }
    }
  };
  walk(dir, 0);
  return newest;
}

export async function autoCaptureSession(engine: LorexEngine): Promise<CaptureResult | null> {
  let best: { path: string; agent: string; mtime: number } | null = null;
  for (const { dir, agent } of SESSION_DIRS) {
    if (!existsSync(dir)) continue;
    const found = newestJsonl(dir);
    if (!found) continue;
    let mtime = 0;
    try {
      mtime = statSync(found).mtimeMs;
    } catch { continue; }
    if (!best || mtime > best.mtime) best = { path: found, agent, mtime };
  }
  return best ? captureTranscript(engine, { transcriptPath: best.path, agent: best.agent }) : null;
}

export async function autoCaptureClaudeSession(engine: LorexEngine): Promise<CaptureResult | null> {
  return autoCaptureSession(engine);
}
