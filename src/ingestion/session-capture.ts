/**
 * Session capture: reads agent transcript JSONL files, extracts turns,
 * and ingests them into Lorex memory.
 *
 * Supports Claude Code transcripts. Other agents can add parsers here.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { LorexEngine } from "../engine.js";
import { normalizeSession } from "./normalizer.js";

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Transcript parsing ───────────────────────────────────────────────────────

/** Extract text from a Claude Code message entry (string or content array). */
function extractText(entry: Record<string, unknown>): string {
  const msg = entry.message;
  if (typeof msg === "string") return msg;
  if (Array.isArray(msg)) return msg.map((m: Record<string, unknown>) => m.text ?? "").join("");
  if (typeof entry.content === "string") return entry.content;
  return "";
}

/** Role mapping: Claude Code uses "human"/"assistant", some use "user"/"ai". */
const ROLE_MAP: Record<string, Turn["role"]> = {
  human: "user", user: "user",
  assistant: "assistant", ai: "assistant",
};

function parseTranscript(raw: string): Turn[] {
  return raw.split("\n").filter((l) => l.trim()).flatMap((line): Turn[] => {
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const role = ROLE_MAP[String(entry.type)];
      if (!role) return [];
      const text = extractText(entry).trim();
      if (!text) return [];
      return [{ role, content: text, timestamp: typeof entry.timestamp === "string" ? entry.timestamp : undefined }];
    } catch {
      return [];
    }
  });
}

// ── Capture ──────────────────────────────────────────────────────────────────

/** Ingest a transcript file into Lorex memory. */
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

/** Find the most recent Claude Code transcript in ~/.claude/projects/. */
export async function autoCaptureClaudeSession(engine: LorexEngine): Promise<CaptureResult | null> {
  const claudeDir = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeDir)) return null;

  let newest: string | null = null;
  let newestTime = 0;

  try {
    for (const project of readdirSync(claudeDir)) {
      const dir = join(claudeDir, project);
      if (!statSync(dir).isDirectory()) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".jsonl")) continue;
        const mtime = statSync(join(dir, file)).mtimeMs;
        if (mtime > newestTime) { newestTime = mtime; newest = join(dir, file); }
      }
    }
  } catch { return null; }

  return newest ? captureTranscript(engine, { transcriptPath: newest, agent: "claude-code" }) : null;
}
