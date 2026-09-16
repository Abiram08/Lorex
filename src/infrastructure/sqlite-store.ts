/**
 * SQLite-backed memory store with FTS5 full-text search.
 *
 * WAL mode for concurrent reads, FTS5 for fast lexical search,
 * prepared statement cache for repeated queries.
 *
 * Data model:
 *   memories  — fact_key, version_id, text, corpus, valid_from/to, status, agent, reason
 *   relations — from_id → to_id (supersedes edges for graph traversal)
 *   feedback  — request_id, rating, ground_truth
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  HydraDBLike,
  IngestMemoryInput,
  IngestKnowledgeInput,
  IngestResult,
  QueryInput,
  QueryResult,
  QueryChunk,
  FeedbackInput,
  HydraRelations,
  ContextScope,
} from "./hydradb-client.js";
import {
  memoryStrength,
  lifecycleScoreModifier,
  type ConsolidationCandidate,
  type ConsolidationResult,
} from "./lifecycle.js";

// ── SQL constants ────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    id            TEXT PRIMARY KEY,
    text          TEXT NOT NULL,
    corpus        TEXT NOT NULL DEFAULT 'memory',
    collection    TEXT NOT NULL DEFAULT 'default',
    fact_key      TEXT,
    version_id    TEXT,
    valid_from    TEXT,
    valid_to      TEXT,
    status        TEXT DEFAULT 'current',
    agent         TEXT,
    reason        TEXT,
    memory_type   TEXT,
    trust         TEXT,
    source_ref    TEXT,
    strength      REAL DEFAULT 1.0,
    access_count  INTEGER DEFAULT 0,
    last_accessed TEXT,
    metadata      TEXT DEFAULT '{}',
    relations     TEXT DEFAULT '[]',
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_memories_fact_key    ON memories(fact_key);
  CREATE INDEX IF NOT EXISTS idx_memories_status      ON memories(status);
  CREATE INDEX IF NOT EXISTS idx_memories_collection  ON memories(collection);
  CREATE INDEX IF NOT EXISTS idx_memories_valid_from  ON memories(valid_from);
  CREATE INDEX IF NOT EXISTS idx_memories_valid_to    ON memories(valid_to);
  CREATE INDEX IF NOT EXISTS idx_memories_corpus      ON memories(corpus);

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    text, fact_key,
    content=memories, content_rowid=rowid,
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, text, fact_key) VALUES (new.rowid, new.text, new.fact_key);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, text, fact_key) VALUES ('delete', old.rowid, old.text, old.fact_key);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, text, fact_key) VALUES ('delete', old.rowid, old.text, old.fact_key);
    INSERT INTO memories_fts(rowid, text, fact_key) VALUES (new.rowid, new.text, new.fact_key);
  END;

  CREATE TABLE IF NOT EXISTS relations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id     TEXT NOT NULL,
    to_id       TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'supersedes',
    reason      TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id);
  CREATE INDEX IF NOT EXISTS idx_relations_to   ON relations(to_id);

  CREATE TABLE IF NOT EXISTS feedback (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id   TEXT NOT NULL,
    rating       TEXT,
    feedback     TEXT,
    source       TEXT DEFAULT 'agent',
    ground_truth TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_feedback_request ON feedback(request_id);
`;

const INSERT_MEMORY = `
  INSERT OR REPLACE INTO memories (
    id, text, corpus, collection, fact_key, version_id,
    valid_from, valid_to, status, agent, reason, memory_type,
    trust, source_ref, metadata, relations, updated_at
  ) VALUES (?, ?, 'memory', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
`;

const INSERT_KNOWLEDGE = `
  INSERT OR REPLACE INTO memories (
    id, text, corpus, collection, fact_key, version_id,
    valid_from, status, source_ref, metadata, updated_at
  ) VALUES (?, ?, 'knowledge', ?, ?, ?, datetime('now'), 'current', ?, ?, datetime('now'))
`;

const INSERT_RELATION = `INSERT INTO relations (from_id, to_id, type, reason) VALUES (?, ?, ?, ?)`;

const SELECT_BY_IDS = (count: number) => {
  const ph = Array(count).fill("?").join(",");
  return `
    SELECT r.from_id, r.to_id, r.type, r.reason
    FROM relations r
    JOIN memories m ON r.from_id = m.id
    WHERE m.collection = ? AND (r.from_id IN (${ph}) OR r.to_id IN (${ph}))
  `;
};

const SELECT_FTS = (where: string) => `
  SELECT m.*, fts.rank AS score
  FROM memories_fts fts
  JOIN memories m ON m.rowid = fts.rowid
  ${where}
  AND fts.text MATCH ?
  ORDER BY fts.rank
  LIMIT ?
`;

const SELECT_LIKE = (where: string) => `
  SELECT m.*, 0.0 AS score
  FROM memories m
  ${where}
  AND (m.text LIKE ? OR m.fact_key LIKE ?)
  LIMIT ?
`;

const SELECT_RECENT = (where: string) => `
  SELECT m.*, 0.0 AS score
  FROM memories m
  ${where}
  ORDER BY m.created_at DESC
  LIMIT ?
`;

// ── Score normalization ──────────────────────────────────────────────────────

function normalizeFtsScore(rank: number): number {
  return Math.min(1, Math.abs(rank) / 10);
}

function recencyBoost(validFrom: string | null): number {
  if (!validFrom) return 0;
  const daysSince = (Date.now() - Date.parse(validFrom)) / 86_400_000;
  return Math.max(0, 1 - daysSince / 365) * 0.15;
}

// ── Store ────────────────────────────────────────────────────────────────────

export interface SqliteStoreOptions {
  path: string;
  readOnly?: boolean;
}

export class SqliteStore implements HydraDBLike {
  private db: Database.Database;
  private schemaReady = false;

  // Prepared statement cache — avoids re-preparing on every call
  private stmts = new Map<string, Database.Statement>();

  constructor(private readonly opts: SqliteStoreOptions) {
    const dir = dirname(opts.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(opts.path, { readonly: opts.readOnly ?? false });
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -8000");
    this.db.pragma("busy_timeout = 5000");
  }

  // ── Schema ──────────────────────────────────────────────────────────────

  private init(): void {
    if (this.schemaReady) return;
    this.schemaReady = true;
    this.db.exec(SCHEMA);
  }

  private prepared(sql: string): Database.Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  // ── HydraDBLike: lifecycle ──────────────────────────────────────────────

  async createDatabase(_database: string): Promise<void> { this.init(); }
  async awaitDatabaseReady(_d: string, _m?: number, _i?: number): Promise<void> { this.init(); }
  async databaseStatus(_d: string): Promise<{ ready: boolean; raw: unknown }> {
    this.init();
    return { ready: true, raw: { engine: "sqlite", path: this.opts.path } };
  }
  async ping(_database: string): Promise<{ reachable: boolean; authed: boolean; latencyMs: number; ready?: boolean; error?: string }> {
    this.init();
    const t = Date.now();
    try { this.db.prepare("SELECT 1").get(); return { reachable: true, authed: true, latencyMs: Date.now() - t, ready: true }; }
    catch (e) { return { reachable: false, authed: false, latencyMs: Date.now() - t, error: (e as Error).message }; }
  }

  // ── HydraDBLike: ingest ─────────────────────────────────────────────────

  async ingestMemory(input: IngestMemoryInput): Promise<IngestResult> {
    this.init();
    const ids: string[] = [];

    this.db.transaction(() => {
      for (const item of input.memories) {
        const id = item.id ?? `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const md = item.additional_metadata ?? {};

        this.prepared(INSERT_MEMORY).run(
          id, item.text ?? "", input.collection,
          md.fact_key ?? null, md.version_id ?? id,
          md.valid_from ?? null, md.valid_to ?? null,
          md.status ?? "current", md.agent ?? null,
          md.reason ?? null, md.memory_type ?? null,
          md.trust ?? null, md.source_ref ?? null,
          JSON.stringify(md), JSON.stringify(item.relations?.ids ?? []),
        );

        if (item.relations?.ids?.length && item.relations.properties?.type === "supersedes") {
          for (const toId of item.relations.ids) {
            this.prepared(INSERT_RELATION).run(id, toId, "supersedes", item.relations.properties.reason ?? null);
          }
        }

        ids.push(id);
      }
    })();

    return { ids, ok: true, requestId: `req_${Date.now().toString(36)}` };
  }

  async ingestKnowledge(input: IngestKnowledgeInput): Promise<IngestResult> {
    this.init();
    const ids: string[] = [];

    this.db.transaction(() => {
      for (const doc of input.documents ?? []) {
        const id = doc.id ?? `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const text = doc.content?.text ?? doc.content?.markdown ?? "";
        const md = doc.additional_metadata ?? {};

        this.prepared(INSERT_KNOWLEDGE).run(
          id, text, input.collection ?? "default",
          null, id, null, doc.url ?? null,
          JSON.stringify({ ...md, source_ref: doc.url, timestamp: doc.timestamp }),
        );
        ids.push(id);
      }
    })();

    return { ids, ok: true, requestId: `req_${Date.now().toString(36)}` };
  }

  // ── HydraDBLike: index status ───────────────────────────────────────────

  async awaitIndexed(ids: string[]): Promise<boolean> {
    this.init();
    return ids.length > 0;
  }

  async contextStatus(ids: string[]): Promise<{ statuses: Array<{ id: string; indexing_status: string }>; raw: unknown }> {
    this.init();
    return { statuses: ids.map((id) => ({ id, indexing_status: "ready" })), raw: { engine: "sqlite" } };
  }

  // ── HydraDBLike: relations ──────────────────────────────────────────────

  async contextRelations(scope: ContextScope, ids?: string[]): Promise<HydraRelations> {
    this.init();
    const collection = scope.collection ?? "default";

    let rows: Array<{ from_id: string; to_id: string; type: string; reason: string | null }>;
    if (ids?.length) {
      const sql = SELECT_BY_IDS(ids.length);
      rows = this.db.prepare(sql).all(collection, ...ids, ...ids) as typeof rows;
    } else {
      rows = this.db
        .prepare(`SELECT r.from_id, r.to_id, r.type, r.reason FROM relations r JOIN memories m ON r.from_id = m.id WHERE m.collection = ?`)
        .all(collection) as typeof rows;
    }

    return {
      entities: rows.map((r) => ({ id: r.from_id, type: "memory" })),
      relations: rows.map((r) => ({ source: r.from_id, target: r.to_id, type: r.type, reason: r.reason ?? undefined })),
    };
  }

  // ── HydraDBLike: query ──────────────────────────────────────────────────

  async query(input: QueryInput): Promise<QueryResult> {
    this.init();
    const collection = input.collection ?? "default";
    const maxResults = input.max_results ?? 15;
    const query = (input.query ?? "").trim();

    // Build WHERE clause
    const conditions = ["m.collection = ?"];
    const params: unknown[] = [collection];

    if (input.type && input.type !== "all") {
      conditions.push("m.corpus = ?");
      params.push(input.type);
    }
    conditions.push("(m.status IS NULL OR m.status NOT IN ('forgotten', 'superseded'))");

    if (input.metadata_filters?.as_of) {
      conditions.push("m.valid_from <= ?");
      conditions.push("(m.valid_to IS NULL OR m.valid_to > ?)");
      params.push(input.metadata_filters.as_of, input.metadata_filters.as_of);
    }

    // TTL enforcement: filter expired memories by type
    conditions.push(`(
      m.memory_type IS NULL
      OR m.memory_type IN ('fact', 'decision', 'preference', 'constraint', 'lesson')
      OR (m.memory_type = 'task' AND datetime(m.created_at, '+30 days') > datetime('now'))
      OR (m.memory_type = 'correction' AND datetime(m.created_at, '+180 days') > datetime('now'))
      OR (m.memory_type = 'episode' AND datetime(m.created_at, '+30 days') > datetime('now'))
    )`);

    const where = `WHERE ${conditions.join(" AND ")}`;
    const limit = Math.min(maxResults * 3, 200);

    // Execute search
    const rows = query ? this.searchFts(query, where, params, limit) : this.searchRecent(where, params, limit);

    // Score + rank with lifecycle-aware scoring
    const scored = rows
      .map((r) => {
        const ftsScore = r.score < 0 ? normalizeFtsScore(r.score) : r.score;
        const lifecycle = lifecycleScoreModifier(
          r.created_at, r.memory_type, r.access_count ?? 0, r.last_accessed, r.status,
        );
        // Combine FTS relevance with lifecycle strength
        const score = ftsScore * 0.7 + lifecycle * 0.3 + recencyBoost(r.valid_from);
        return { ...r, score, lifecycle_strength: lifecycle };
      })
      .sort((a, b) => b.score - a.score);

    const chunks: QueryChunk[] = scored.slice(0, maxResults).map((r) => {
      let md: Record<string, unknown> = {};
      try { md = JSON.parse(r.metadata); } catch { /* stored as JSON string */ }
      return {
        id: r.id, text: r.text, content: r.text,
        corpus: r.corpus as "memory" | "knowledge", score: r.score,
        metadata: {
          ...md, fact_key: r.fact_key, version_id: r.version_id,
          valid_from: r.valid_from, valid_to: r.valid_to, status: r.status,
          agent: r.agent, reason: r.reason, memory_type: r.memory_type,
          trust: r.trust, source_ref: r.source_ref,
          strength: r.lifecycle_strength ?? r.strength,
          access_count: r.access_count, last_accessed: r.last_accessed,
          created_at: r.created_at,
        },
      };
    });

    return { chunks, requestId: `req_${Date.now().toString(36)}`, latencyMs: 0, raw: { engine: "sqlite", path: this.opts.path } };
  }

  private searchFts(query: string, where: string, params: unknown[], limit: number) {
    const terms = query.replace(/[^\w\s]/g, " ").split(/\s+/).filter((t) => t.length > 1).map((t) => `${t}*`).join(" OR ");
    if (!terms) return this.searchLike(query, where, params, limit);

    try {
      return this.db.prepare(SELECT_FTS(where)).all(...params, terms, limit) as Row[];
    } catch {
      return this.searchLike(query, where, params, limit);
    }
  }

  private searchLike(query: string, where: string, params: unknown[], limit: number) {
    const like = `%${query}%`;
    return this.db.prepare(SELECT_LIKE(where)).all(...params, like, like, limit) as Row[];
  }

  private searchRecent(where: string, params: unknown[], limit: number) {
    return this.db.prepare(SELECT_RECENT(where)).all(...params, limit) as Row[];
  }

  // ── HydraDBLike: feedback ───────────────────────────────────────────────

  async feedback(input: FeedbackInput): Promise<void> {
    this.init();
    this.prepared(`INSERT INTO feedback (request_id, rating, feedback, source, ground_truth) VALUES (?, ?, ?, ?, ?)`)
      .run(input.request_id, input.rating ?? null, input.feedback ?? null, input.source ?? "agent", input.ground_truth ? JSON.stringify(input.ground_truth) : null);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Record that a memory was accessed (boosts reinforcement). */
  recordAccess(id: string): void {
    this.init();
    this.prepared(
      `UPDATE memories SET access_count = access_count + 1, last_accessed = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(id);
  }

  /** Get lifecycle statistics: count by type, avg strength, stale count. */
  getLifecycleStats(collection: string = "default"): {
    total: number;
    byType: Record<string, number>;
    avgStrength: number;
    staleCount: number;
    expiredCount: number;
  } {
    this.init();
    const rows = this.db.prepare(
      `SELECT memory_type, COUNT(*) as cnt, AVG(strength) as avg_str FROM memories WHERE collection = ? AND status != 'forgotten' GROUP BY memory_type`,
    ).all(collection) as Array<{ memory_type: string | null; cnt: number; avg_str: number }>;

    const byType: Record<string, number> = {};
    let total = 0;
    let totalStrength = 0;
    for (const r of rows) {
      const type = r.memory_type ?? "unknown";
      byType[type] = r.cnt;
      total += r.cnt;
      totalStrength += r.avg_str * r.cnt;
    }

    const staleCount = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memories WHERE collection = ? AND status = 'current' AND strength < 0.15`,
    ).get(collection) as { cnt: number };

    const expiredCount = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memories WHERE collection = ? AND status = 'current' AND valid_to IS NOT NULL AND valid_to < datetime('now')`,
    ).get(collection) as { cnt: number };

    return {
      total,
      byType,
      avgStrength: total > 0 ? totalStrength / total : 1,
      staleCount: staleCount.cnt,
      expiredCount: expiredCount.cnt,
    };
  }

  /** Get candidates for consolidation (all current memories with strength). */
  getConsolidationCandidates(collection: string = "default"): ConsolidationCandidate[] {
    this.init();
    return this.db.prepare(
      `SELECT id, fact_key, text, memory_type, created_at, strength, access_count
       FROM memories WHERE collection = ? AND status = 'current'`,
    ).all(collection) as ConsolidationCandidate[];
  }

  /** Apply a consolidation result: prune, mark expired, update strengths. */
  applyConsolidation(result: ConsolidationResult): { pruned: number; expired: number } {
    this.init();
    let pruned = 0;
    let expired = 0;

    this.db.transaction(() => {
      // Prune weak memories
      for (const id of result.pruned) {
        this.prepared(`UPDATE memories SET status = 'forgotten', updated_at = datetime('now') WHERE id = ?`).run(id);
        pruned++;
      }

      // Expire old memories
      for (const id of result.expired) {
        this.prepared(`UPDATE memories SET status = 'forgotten', updated_at = datetime('now') WHERE id = ?`).run(id);
        expired++;
      }

      // Mark merged memories as superseded
      for (const merge of result.merged) {
        for (const id of merge.drop) {
          this.prepared(`UPDATE memories SET status = 'superseded', updated_at = datetime('now') WHERE id = ?`).run(id);
          pruned++;
        }
      }

      // Reinforce accessed memories
      for (const id of result.reinforced) {
        this.prepared(
          `UPDATE memories SET strength = MIN(1.0, strength + 0.3), access_count = access_count + 1, last_accessed = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
        ).run(id);
      }
    })();

    return { pruned, expired };
  }

  /** Update strength for all memories (time-decay pass). Called periodically. */
  updateStrengths(collection: string = "default"): number {
    this.init();
    const rows = this.db.prepare(
      `SELECT id, created_at, memory_type, access_count, last_accessed FROM memories WHERE collection = ? AND status = 'current'`,
    ).all(collection) as Array<{ id: string; created_at: string; memory_type: string | null; access_count: number; last_accessed: string | null }>;

    let updated = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        const strength = memoryStrength(r.created_at, r.memory_type, r.access_count, r.last_accessed);
        this.prepared(`UPDATE memories SET strength = ?, updated_at = datetime('now') WHERE id = ?`).run(strength, r.id);
        updated++;
      }
    })();

    return updated;
  }

  close(): void {
    this.stmts.clear();
    this.db.close();
  }
}

// ── Internal types ───────────────────────────────────────────────────────────

interface Row {
  id: string; text: string; corpus: string; fact_key: string | null;
  version_id: string | null; valid_from: string | null; valid_to: string | null;
  status: string | null; agent: string | null; reason: string | null;
  memory_type: string | null; trust: string | null; source_ref: string | null;
  metadata: string; score: number; created_at: string;
  strength: number; access_count: number; last_accessed: string | null;
  lifecycle_strength?: number;
}
