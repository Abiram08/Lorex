/** Streaming and stratified sampling of the LongMemEval dataset. */

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

export interface RawQuestion {
  question_id?: string;
  question_type?: string;
  question?: string;
  answer?: unknown;
  question_date?: string;
  haystack_dates?: string[];
  haystack_session_ids?: string[];
  haystack_sessions?: Array<Array<{ role?: string; content?: string; occurredAt?: string }>>;
  answer_session_ids?: string[];
}

export async function* streamJsonArray(path: string): AsyncGenerator<RawQuestion> {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 });

  let buffer = "";
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  let started = false;
  let scanned = 0;

  for await (const chunk of stream) {
    buffer += chunk as string;

    for (let i = scanned; i < buffer.length; i++) {
      const c = buffer[i]!;

      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }

      if (c === '"') { inString = true; continue; }

      if (c === "[" && !started && depth === 0) { started = true; continue; }

      if (c === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          yield JSON.parse(buffer.slice(start, i + 1)) as RawQuestion;
          buffer = buffer.slice(i + 1);
          i = -1;
          scanned = 0;
          start = -1;
        }
      }
    }

    scanned = buffer.length;

    if (depth === 0 && start === -1 && buffer.length > 1 << 20) {
      buffer = buffer.slice(-1024);
      scanned = buffer.length;
    }
  }
}

async function* streamJsonl(path: string): AsyncGenerator<RawQuestion> {
  const raw = await readFile(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim()) yield JSON.parse(line) as RawQuestion;
  }
}

function resolveDatasetPath(inPath: string | undefined): string {
  const candidates = [
    inPath,
    "data/longmemeval_s_cleaned.json",
    "data/longmemeval_s.json",
    "longmemeval-sample.jsonl",
  ].filter(Boolean) as string[];
  const path = candidates.find((p) => existsSync(p));
  if (!path) {
    throw new Error(
      "No benchmark dataset found. Run: npm run longmemeval:download\n" +
        "Or pass --in path/to/longmemeval_s.json",
    );
  }
  return path;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function loadStratifiedSample(
  inPath: string | undefined,
  size: number,
  seed = 42,
): Promise<RawQuestion[]> {
  const path = resolveDatasetPath(inPath);
  const buckets = new Map<string, RawQuestion[]>();

  const source = path.endsWith(".jsonl") ? streamJsonl(path) : streamJsonArray(path);
  for await (const q of source) {
    const abs = String(q.question_id ?? "").toLowerCase().endsWith("_abs");
    const key = `${String(q.question_type ?? "unknown")}::${abs ? "abs" : "ans"}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(q);
  }

  const rand = mulberry32(seed);
  const categories = [...buckets.keys()].sort();
  for (const c of categories) {
    const arr = buckets.get(c)!;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
  }

  const population = [...buckets.values()].reduce((n, arr) => n + arr.length, 0);
  const out: RawQuestion[] = [];
  const cursors = new Map(categories.map((c) => [c, 0]));

  for (const c of categories) {
    const arr = buckets.get(c)!;
    const want = Math.min(arr.length, Math.round((arr.length / population) * size));
    for (let i = 0; i < want && out.length < size; i++) {
      out.push(arr[i]!);
      cursors.set(c, i + 1);
    }
  }

  while (out.length < size) {
    let progressed = false;
    for (const c of categories) {
      if (out.length >= size) break;
      const i = cursors.get(c)!;
      const arr = buckets.get(c)!;
      if (i < arr.length) {
        out.push(arr[i]!);
        cursors.set(c, i + 1);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}

export async function* loadQuestions(
  inPath: string | undefined,
  opts: { skip?: number; limit?: number } = {},
): AsyncGenerator<{ question: RawQuestion; index: number }> {
  const path = resolveDatasetPath(inPath);

  const skip = opts.skip ?? 0;
  const limit = opts.limit;
  const source = path.endsWith(".jsonl") ? streamJsonl(path) : streamJsonArray(path);

  let index = 0;
  let emitted = 0;
  for await (const question of source) {
    if (index++ < skip) continue;
    if (limit !== undefined && emitted >= limit) return;
    emitted++;
    yield { question, index: index - 1 };
  }
}
