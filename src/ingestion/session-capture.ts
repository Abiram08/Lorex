/** Bounded, resumable ingestion of the exact transcript supplied by an agent hook. */

import {
  createReadStream, existsSync, mkdirSync, openSync, closeSync, readFileSync,
  readSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { LorexEngine } from "../engine.js";
import { normalizeSession } from "./normalizer.js";
import { storeDir } from "../infrastructure/paths.js";
import { loadConfig } from "../infrastructure/config.js";

export interface CaptureOpts {
  transcriptPath: string;
  sessionId?: string;
  agent?: string;
  startedAt?: string;
  incremental?: boolean;
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

interface Cursor { offset: number; firstLineHash: string; boundaryHash?: string }
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const BATCH_TURNS = 100;
const BATCH_CHARS = 400_000;
const MAX_TURN_CHARS = 40_000;

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function cursorFile(engine: LorexEngine, transcriptPath: string): string {
  const config = loadConfig();
  const identity = engine.getIdentity();
  return join(storeDir(config.dataDir), "capture-cursors", `${hash(`${identity.database}|${identity.collection}|${resolve(transcriptPath)}`)}.json`);
}

function readCursor(file: string): Cursor | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Cursor>;
    if (Number.isSafeInteger(parsed.offset) && parsed.offset! >= 0 && typeof parsed.firstLineHash === "string" &&
        (parsed.boundaryHash === undefined || typeof parsed.boundaryHash === "string")) {
      return parsed as Cursor;
    }
  } catch { /* A broken cursor replays with deterministic IDs rather than skipping data. */ }
  return null;
}

function writeCursor(file: string, cursor: Cursor): void {
  mkdirSync(join(file, ".."), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(cursor), { mode: 0o600 });
  renameSync(temp, file);
}

async function lockCursor(file: string): Promise<() => void> {
  mkdirSync(join(file, ".."), { recursive: true });
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      return () => { closeSync(fd); try { unlinkSync(lock); } catch { /* lock already gone */ } };
    } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 60_000) unlinkSync(lock); }
      catch { /* another process may have released it */ }
      await new Promise((done) => setTimeout(done, 100));
    }
  }
  throw new Error("Transcript capture is busy; retry on the next hook event");
}

function firstLineHash(path: string): string {
  // Stable when an append adds more lines; changes when a transcript is replaced.
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(65_536);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const newline = bytes.subarray(0, count).indexOf(10);
    return hash(bytes.subarray(0, newline < 0 ? count : newline));
  } finally { closeSync(fd); }
}

/** Hash bytes immediately before a cursor. This distinguishes a true append
 * from a transcript rewritten in place while keeping the same first line. */
function boundaryHash(path: string, offset: number): string {
  if (offset <= 0) return hash("");
  const fd = openSync(path, "r");
  try {
    const start = Math.max(0, offset - 4096);
    const bytes = Buffer.alloc(offset - start);
    const count = readSync(fd, bytes, 0, bytes.length, start);
    return hash(bytes.subarray(0, count));
  } finally { closeSync(fd); }
}

function textBlocks(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((part): part is { type?: string; text: string } =>
      !!part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" &&
      // Claude uses `text`; Responses/Codex transcripts use input_text and
      // output_text. Keeping all three retains the exact conversational source.
      !((part as { type?: unknown }).type) || ["text", "input_text", "output_text"].includes(String((part as { type?: unknown }).type)),
    ).map((part) => part.text).join("\n");
  }
  return "";
}

function splitTurn(turn: Turn): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i < turn.content.length; i += MAX_TURN_CHARS) {
    out.push({ ...turn, content: turn.content.slice(i, i + MAX_TURN_CHARS) });
  }
  return out;
}

function entryToTurns(entry: Record<string, unknown>): Turn[] {
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
  if (entry.type === "response_item" && entry.payload && typeof entry.payload === "object") {
    return entryToTurns({ ...(entry.payload as Record<string, unknown>), timestamp });
  }
  const roleRaw = entry.role ?? entry.type;
  const role = roleRaw === "human" || roleRaw === "user" ? "user"
    : roleRaw === "assistant" || roleRaw === "ai" ? "assistant" : undefined;
  if (role) {
    const message = entry.message;
    const nested = message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>).content : message;
    const content = textBlocks(nested) || textBlocks(entry.content);
    return content.trim() ? splitTurn({ role, content: content.trim(), timestamp }) : [];
  }
  const out: Turn[] = [];
  if (typeof entry.prompt === "string" && entry.prompt.trim()) out.push(...splitTurn({ role: "user", content: entry.prompt.trim(), timestamp }));
  if (typeof entry.response === "string" && entry.response.trim()) out.push(...splitTurn({ role: "assistant", content: entry.response.trim(), timestamp }));
  return out;
}

function empty(sessionId: string, error: string): CaptureResult {
  return { sessionId, chunkCount: 0, factCount: 0, tokenCount: 0, duplicateCount: 0, errors: [error], partial: false };
}

export async function captureTranscript(engine: LorexEngine, opts: CaptureOpts): Promise<CaptureResult> {
  const path = resolve(opts.transcriptPath);
  const sessionId = opts.sessionId ?? basename(path, ".jsonl");
  if (!existsSync(path)) return empty(sessionId, `Not found: ${path}`);
  const file = cursorFile(engine, path);
  let unlock: (() => void) | undefined;
  try {
    if (opts.incremental) unlock = await lockCursor(file);
    const size = statSync(path).size;
    const signature = firstLineHash(path);
    const previous = opts.incremental ? readCursor(file) : null;
    const validPrevious = previous && previous.offset <= size && previous.firstLineHash === signature &&
      !!previous.boundaryHash && previous.boundaryHash === boundaryHash(path, previous.offset);
    let committed = validPrevious ? previous.offset : 0;
    const result: CaptureResult = { sessionId, chunkCount: 0, factCount: 0, tokenCount: 0, duplicateCount: 0, errors: [], partial: false };
    if (committed === size) return result;

    let batch: Turn[] = [];
    let batchChars = 0;
    let batchStart = committed;
    let batchEnd = committed;
    let pending: Buffer = Buffer.alloc(0);
    let position = committed;
    let sawTurn = false;

    const flush = async (): Promise<boolean> => {
      if (!batch.length) {
        if (opts.incremental && batchEnd > committed) {
          writeCursor(file, { offset: batchEnd, firstLineHash: signature, boundaryHash: boundaryHash(path, batchEnd) });
          committed = batchEnd;
        }
        batchStart = batchEnd;
        return true;
      }
      const segmentId = `${sessionId.slice(0, 145)}_${hash(`${path}|${batchStart}`)}`;
      const session = normalizeSession(segmentId, engine.getIdentity().database, engine.getIdentity().collection, batch, {
        startedAt: opts.startedAt ?? batch[0]?.timestamp,
        agent: opts.agent ?? engine.getIdentity().agent,
        source: "transcript",
        rootSessionId: sessionId,
      });
      try {
        const saved = await engine.ingestSession(session);
        result.chunkCount += saved.chunkCount;
        result.factCount += saved.factCount;
        result.tokenCount += saved.tokenCount;
        result.duplicateCount += saved.duplicateCount;
        result.errors.push(...saved.errors);
        if (saved.partial) { result.partial = true; return false; }
      } catch (e) {
        result.errors.push((e as Error).message);
        result.partial = result.chunkCount > 0 || result.factCount > 0;
        return false;
      }
      if (opts.incremental) {
        writeCursor(file, { offset: batchEnd, firstLineHash: signature, boundaryHash: boundaryHash(path, batchEnd) });
      }
      committed = batchEnd;
      batch = [];
      batchChars = 0;
      batchStart = batchEnd;
      return true;
    };

    const consumeLine = async (line: Buffer, end: number): Promise<boolean> => {
      if (line.length > MAX_LINE_BYTES) {
        result.errors.push(`JSONL line exceeds ${MAX_LINE_BYTES} bytes`);
        return false;
      }
      const raw = line.toString("utf8").trim();
      if (raw) {
        let entry: unknown;
        try { entry = JSON.parse(raw); }
        catch { result.errors.push(`Malformed JSONL at byte ${batchEnd}`); return false; }
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const turns = entryToTurns(entry as Record<string, unknown>);
          if (turns.length) {
            sawTurn = true;
            const chars = turns.reduce((sum, turn) => sum + turn.content.length, 0);
            if (batch.length && (batch.length + turns.length > BATCH_TURNS || batchChars + chars > BATCH_CHARS)) {
              if (!await flush()) return false;
            }
            batch.push(...turns);
            batchChars += chars;
          }
        }
      }
      batchEnd = end;
      return true;
    };

    for await (const chunk of createReadStream(path, { start: committed })) {
      const bytes = chunk as Buffer;
      pending = pending.length ? Buffer.concat([pending, bytes]) : bytes;
      position += bytes.length;
      if (pending.length > MAX_LINE_BYTES && !pending.includes(10)) {
        result.errors.push(`JSONL line exceeds ${MAX_LINE_BYTES} bytes`);
        return result;
      }
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, newline);
        const end = position - (pending.length - newline - 1);
        if (!await consumeLine(line, end)) return result;
        pending = pending.subarray(newline + 1);
      }
    }
    if (pending.length) {
      // A writer may have left an unfinished final JSON object. Retry it later.
      try { JSON.parse(pending.toString("utf8")); }
      catch { return result; }
      if (!await consumeLine(pending, position)) return result;
    }
    if (!await flush()) return result;
    if (!sawTurn && !previous) return empty(sessionId, "No turns in transcript");
    return result;
  } catch (e) {
    return empty(sessionId, (e as Error).message);
  } finally { unlock?.(); }
}

