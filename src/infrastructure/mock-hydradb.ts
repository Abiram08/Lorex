/** In-process HydraDB stand-in for offline demos, tests, and benchmarks. */

import {
  HydraDBLike,
  IngestMemoryInput,
  IngestKnowledgeInput,
  IngestResult,
  QueryInput,
  QueryResult,
  QueryChunk,
  FeedbackInput,
  MemoryItem,
  HydraRelations,
} from "./hydradb-client.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

interface StoredMemory {
  id: string;
  text: string;
  corpus: "memory" | "knowledge";
  collection: string;
  timestamp?: string;
  metadata: Record<string, unknown>;
  entities: string[];
  relations: string[];
}

interface FeedbackRecord {
  requestId: string;
  groundTruthAnswer?: string;
  rating?: string;
  query: string;
}

function extractEntities(text: string): string[] {
  const ents = new Set<string>();
  const cap = text.match(/\b([A-Z][a-z]+(?:\s+(?:of\s+|the\s+)?[A-Z][a-z]+)*)\b/g) ?? [];
  cap.forEach((c) => ents.add(c.toLowerCase()));
  const q = text.match(/["'`]([^"'`]{2,40})["'`]/g);
  q?.forEach((c) => ents.add(c.replace(/["'`]/g, "").toLowerCase()));
  const n = text.match(/\b(\d+(?:\.\d+)?\s*(?:days?|hours?|km|k|miles|lb|kg|5k|10k))\b/gi);
  n?.forEach((c) => ents.add(c.toLowerCase()));
  return [...ents].filter((e) => e.length > 2 && !STOP.has(e));
}

const STOP = new Set([
  "the", "and", "but", "for", "with", "from", "that", "this", "what", "when",
  "how", "many", "did", "was", "were", "have", "has", "about", "into", "your",
  "you", "are", "not", "yes", "no", "okay", "ok", "sure", "thanks", "thank",
]);

function parseDate(s?: string): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/gi, " ").split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w))
      .map((w) => (w.endsWith("s") && w.length > 3 ? w.slice(0, -1) : w)),
  );
}

function coverage(qTokens: Set<string>, docTokens: Set<string>): number {
  if (qTokens.size === 0) return 0;
  let hit = 0;
  for (const w of qTokens) if (docTokens.has(w)) hit++;
  return hit / qTokens.size;
}

function expandQueryTokens(_qLower: string, base: Set<string>): Set<string> {
  const out = new Set(base);
  for (const w of base) {
    if (w.length < 4) continue;
    if (w.endsWith("ed")) out.add(w.slice(0, -2));
    else if (w.endsWith("ing")) out.add(w.slice(0, -3));
    else if (w.endsWith("es")) out.add(w.slice(0, -2));
    else out.add(`${w}s`);
  }
  return out;
}

function phraseBoost(qLower: string, docLower: string): number {
  const phrases = qLower
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  if (phrases.length < 2) {
    return phrases.some((p) => docLower.includes(p)) ? 0.15 : 0;
  }
  let hits = 0;
  for (let i = 0; i < phrases.length - 1; i++) {
    const bigram = `${phrases[i]} ${phrases[i + 1]}`;
    if (docLower.includes(bigram)) hits++;
    if (docLower.includes(phrases[i]!)) hits += 0.25;
  }
  return Math.min(1, hits * 0.2);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

export class MockHydraDB implements HydraDBLike {
  private memories: StoredMemory[] = [];
  private feedbacks: FeedbackRecord[] = [];
  private databases = new Set<string>();
  private persistPath?: string;
  private loadedMtimeMs = 0;

  constructor(opts: { persistPath?: string } = {}) {
    this.persistPath = opts.persistPath;
    if (this.persistPath) this.load();
  }

  private refresh(): void {
    if (!this.persistPath) return;
    try {
      const { mtimeMs } = statSync(this.persistPath);
      if (mtimeMs > this.loadedMtimeMs) this.load();
    } catch {
      /* not written yet */
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.persistPath!)) return;
      const j = JSON.parse(readFileSync(this.persistPath!, "utf8"));
      this.memories = j.memories ?? [];
      this.feedbacks = j.feedbacks ?? [];
      this.loadedMtimeMs = statSync(this.persistPath!).mtimeMs;
    } catch {
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(
        this.persistPath,
        JSON.stringify({ memories: this.memories, feedbacks: this.feedbacks }),
      );
      this.loadedMtimeMs = statSync(this.persistPath).mtimeMs;
    } catch {
    }
  }

  async createDatabase(database: string): Promise<void> {
    this.databases.add(database);
  }
  async awaitDatabaseReady(_database: string): Promise<void> {}
  async databaseStatus(database: string): Promise<{ ready: boolean; raw: unknown }> {
    return { ready: this.databases.has(database) || true, raw: { infra: { ready_for_ingestion: true } } };
  }

  async ingestMemory(input: IngestMemoryInput): Promise<IngestResult> {
    const ids: string[] = [];
    for (const m of input.memories) {
      const id = m.id ?? `mem_${Math.random().toString(36).slice(2, 10)}`;
      const text = m.text ?? (m.user_assistant_pairs ?? []).map((p) => `${p.user} ${p.assistant}`).join(" ");
      const md: Record<string, unknown> = { ...(m.additional_metadata ?? {}) };
      if (m.tenant_metadata) {
        try { Object.assign(md, JSON.parse(m.tenant_metadata)); } catch {  }
      }
      const factKey = (md.fact_key as string | undefined) ?? id;

      const existingIdx = this.memories.findIndex(
        (stored) => stored.corpus === "memory" && stored.collection === input.collection && stored.id === id,
      );
      if (existingIdx >= 0) {
        this.memories[existingIdx] = {
          ...this.memories[existingIdx]!,
          text,
          metadata: { ...this.memories[existingIdx]!.metadata, ...md, fact_key: factKey },
          entities: extractEntities(text),
        };
        ids.push(id);
        continue;
      }

      this.memories.push({
        id,
        text,
        corpus: "memory",
        collection: input.collection,
        timestamp: (md.timestamp as string) ?? new Date().toISOString(),
        metadata: { ...md, fact_key: factKey },
        entities: extractEntities(text),
        relations: (m.relations?.ids ?? []),
      });
      ids.push(id);
    }
    this.persist();
    return { ok: true, ids, requestId: `req_${Math.random().toString(36).slice(2, 12)}` };
  }

  async ingestKnowledge(input: IngestKnowledgeInput): Promise<IngestResult> {
    const ids: string[] = [];
    for (const d of input.documents ?? []) {
      const id = d.id ?? `doc_${Math.random().toString(36).slice(2, 10)}`;
      const text = d.content?.text ?? d.content?.markdown ?? "";
      this.memories.push({
        id,
        text,
        corpus: "knowledge",
        collection: input.collection ?? "__default__",
        timestamp: d.timestamp,
        metadata: { ...(d.additional_metadata ?? {}), ...(d.tenant_metadata ?? {}), source_ref: d.url ?? d.title },
        entities: extractEntities(text),
        relations: d.relations?.ids ?? [],
      });
      ids.push(id);
    }
    this.persist();
    return { ok: true, ids, requestId: `req_${Math.random().toString(36).slice(2, 12)}` };
  }

  async awaitIndexed(
    _ids: string[],
    _maxAttempts?: number,
    _intervalMs?: number,
    _scope?: { database?: string; collection?: string },
  ): Promise<boolean> {
    return true;
  }
  async contextRelations(
    scope: { database?: string; collection?: string },
    ids?: string[],
  ): Promise<HydraRelations> {
    const scoped = this.memories.filter(
      (m) => (!scope.collection || m.collection === scope.collection) && (!ids?.length || ids.includes(m.id)),
    );

    const entities = new Map<string, { id: string; name: string; type: string }>();
    const relations: Array<{ source: string; target: string; type: string }> = [];

    for (const m of scoped) {
      for (const name of m.entities) {
        const id = `entity:${name}`;
        if (!entities.has(id)) entities.set(id, { id, name, type: "entity" });
        relations.push({ source: id, target: m.id, type: "mentions" });
      }
      for (const target of m.relations) {
        relations.push({ source: m.id, target, type: "supersedes" });
      }
    }

    return { entities: [...entities.values()], relations };
  }

  async contextStatus(ids: string[], _scope?: { database?: string; collection?: string }) {
    return { statuses: ids.map((id) => ({ id, indexing_status: "completed" })), raw: {} };
  }

  async query(input: QueryInput): Promise<QueryResult> {
    this.refresh();
    if (input.profile) {
      const snap = this.memories
        .filter((m) => (input.collection ? m.collection === input.collection : true))
        .sort((a, b) => (parseDate(b.timestamp) ?? 0) - (parseDate(a.timestamp) ?? 0))
        .slice(0, input.max_results ?? 15);
      return {
        chunks: snap.map((m) => ({
          id: m.id, text: m.text, content: m.text, score: 0.5,
          type: m.corpus, corpus: m.corpus,
          metadata: { valid_from: m.metadata.valid_from ?? m.timestamp, valid_to: m.metadata.valid_to },
        })),
        graphContext: input.graph_context ? { query_paths: [], chunk_relations: [] } : undefined,
        requestId: `req_${Math.random().toString(36).slice(2, 12)}`,
        latencyMs: 60, raw: {},
      };
    }

    const qLower = input.query.toLowerCase().trim();
    const qTokens = tokenize(input.query);
    const qEnts = extractEntities(input.query);
    const asOf = parseDate(input.metadata_filters?.as_of as string) ??
      parseDate((input.metadata_filters as Record<string, unknown>)?.asOf as string);
    const typeFilter = input.type ?? "all";
    const isIdLookup =
      !!qLower &&
      !/\s/.test(qLower) &&
      qLower.length >= 3 &&
      (/^[a-z0-9_.:-]+$/i.test(qLower) || qLower.includes("_") || qLower.startsWith("fact_") || qLower.startsWith("topic_"));

    const matchesFactId = (m: StoredMemory): boolean => {
      const fk = String(m.metadata?.fact_key ?? "").toLowerCase();
      const vid = String(m.metadata?.version_id ?? "").toLowerCase();
      const id = m.id.toLowerCase();
      return fk === qLower || id === qLower || vid === qLower || id.startsWith(qLower + "_");
    };

    let candidates = this.memories.filter((m) => {
      if (input.collection && m.collection !== input.collection) return false;
      if (typeFilter !== "all" && m.corpus !== typeFilter) return false;
      if (isIdLookup && matchesFactId(m)) return true;
      if (asOf !== undefined) {
        const vf = parseDate(m.metadata.valid_from as string) ?? parseDate(m.timestamp);
        const vt = parseDate(m.metadata.valid_to as string);
        if (vf && asOf < vf) return false;
        if (vt && asOf >= vt) return false;
      }
      return !isIdLookup;
    });

    if (isIdLookup && candidates.length === 0) {
      candidates = this.memories.filter((m) => {
        if (input.collection && m.collection !== input.collection) return false;
        if (typeFilter !== "all" && m.corpus !== typeFilter) return false;
        return true;
      });
    }

    const qExpanded = expandQueryTokens(qLower, qTokens);

    const scored = candidates.map((m) => {
      const mTokens = tokenize(m.text);
      const mLowers = m.text.toLowerCase();
      const cov = coverage(qExpanded, mTokens);
      const jac = jaccard(qExpanded, mTokens);
      const phrase = phraseBoost(qLower, mLowers);
      let score = cov * 0.45 + jac * 0.35 + phrase * 0.25;

      let kw = 0;
      for (const w of qExpanded) {
        if (w.length >= 4 && mLowers.includes(w)) kw++;
      }
      score += Math.min(0.25, kw * 0.04);

      const factKey = String(m.metadata?.fact_key ?? "").toLowerCase();
      const versionId = String(m.metadata?.version_id ?? "").toLowerCase();
      const memId = m.id.toLowerCase();
      if (
        (factKey && (factKey === qLower || qLower.includes(factKey) || factKey.includes(qLower))) ||
        memId === qLower ||
        versionId === qLower ||
        (qLower && memId.startsWith(qLower))
      ) {
        score = Math.max(score, 0.95);
      }
      const entOverlap = qEnts.filter((e) => m.entities.includes(e) || mLowers.includes(e)).length;
      score += Math.min(0.2, entOverlap * 0.08);
      if (input.recency_bias && m.timestamp) {
        const ageDays = (Date.now() - (parseDate(m.timestamp) ?? Date.now())) / 86_400_000;
        score += Math.max(0, input.recency_bias * 0.15 * Math.exp(-ageDays / 30));
      }
      for (const fb of this.feedbacks) {
        if (!fb.groundTruthAnswer) continue;
        if (mLowers.includes(fb.groundTruthAnswer.toLowerCase())) {
          const qSim = jaccard(qExpanded, tokenize(fb.query));
          if (qSim > 0.05) score += 0.25 * Math.max(qSim, coverage(qExpanded, tokenize(fb.query)));
        }
      }
      if (input.mode === "thinking" && m.relations.length > 0) score += 0.05;
      if (m.corpus === "memory" && m.text.length < 500) score += 0.03;
      score = Math.min(1.0, score);
      return { m, score };
    });

    if (input.mode === "thinking") {
      const directIds = new Set(scored.map((s) => s.m.id));
      for (const s of scored) {
        for (const rid of s.m.relations) {
          const linked = this.memories.find((m) => m.id === rid && !directIds.has(m.id));
          if (linked) {
            scored.push({ m: linked, score: s.score * 0.5 });
            directIds.add(rid);
          }
        }
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, input.max_results ?? 15);

    const chunks: QueryChunk[] = top.map((s) => ({
      id: s.m.id,
      text: s.m.text,
      content: s.m.text,
      score: s.score,
      type: s.m.corpus,
      corpus: s.m.corpus,
      metadata: {
        ...s.m.metadata,
        valid_from: s.m.metadata.valid_from ?? s.m.timestamp,
        valid_to: s.m.metadata.valid_to,
      },
    }));

    const graphContext = input.graph_context
      ? {
          query_paths: top.slice(0, 3).map((s) => ({
            chunk_id: s.m.id,
            entities: s.m.entities.slice(0, 5),
            relations: s.m.relations,
          })),
          chunk_relations: top.flatMap((s) =>
            s.m.relations.map((r) => ({ source: s.m.id, target: r })),
          ),
        }
      : undefined;

    return {
      chunks,
      graphContext,
      additionalContext: input.mode === "thinking" ? top.slice(0, 2).map((s) => s.m.text.slice(0, 120)) : undefined,
      requestId: `req_${Math.random().toString(36).slice(2, 12)}`,
      latencyMs: input.mode === "thinking" ? 240 : 60,
      raw: {},
    };
  }

  async feedback(input: FeedbackInput): Promise<void> {
    this.feedbacks.push({
      requestId: input.request_id,
      groundTruthAnswer: input.ground_truth?.answer,
      rating: input.rating,
      query: input.metadata?.query ?? "",
    });
    this.persist();
  }

  async ping(_database: string): Promise<{ reachable: boolean; authed: boolean; latencyMs: number; ready?: boolean }> {
    return { reachable: true, authed: true, latencyMs: 2, ready: true };
  }

  get size(): number {
    return this.memories.length;
  }
  get feedbackCount(): number {
    return this.feedbacks.length;
  }
}

export type { MemoryItem };
