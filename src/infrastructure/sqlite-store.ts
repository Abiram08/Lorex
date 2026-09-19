/**
 * SQLite-backed memory store with FTS5 full-text search.
 * WAL mode, prepared statement cache, lifecycle-aware scoring.
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
  stalenessLabel,
  TTL_DAYS,
  type ConsolidationCandidate,
  type ConsolidationResult,
} from "./lifecycle.js";

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
    signal        REAL DEFAULT 0,
    metadata      TEXT DEFAULT '{}',
    relations     TEXT DEFAULT '[]',
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );

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

  CREATE TABLE IF NOT EXISTS feedback (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id   TEXT NOT NULL,
    rating       TEXT,
    feedback     TEXT,
    source       TEXT DEFAULT 'agent',
    ground_truth TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS query_failures (
    pattern    TEXT PRIMARY KEY,
    fails      INTEGER DEFAULT 1,
    last_at    TEXT DEFAULT (datetime('now'))
  );
`;

/** Column-dependent indexes: run AFTER migrate() so legacy DBs have the columns. */
const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_memories_fact_key    ON memories(fact_key);
  CREATE INDEX IF NOT EXISTS idx_memories_status      ON memories(status);
  CREATE INDEX IF NOT EXISTS idx_memories_collection  ON memories(collection);
  CREATE INDEX IF NOT EXISTS idx_memories_valid_from  ON memories(valid_from);
  CREATE INDEX IF NOT EXISTS idx_memories_valid_to    ON memories(valid_to);
  CREATE INDEX IF NOT EXISTS idx_memories_corpus      ON memories(corpus);
  CREATE INDEX IF NOT EXISTS idx_memories_coll_status ON memories(collection, status);
  CREATE INDEX IF NOT EXISTS idx_memories_type        ON memories(memory_type);
  CREATE INDEX IF NOT EXISTS idx_memories_created     ON memories(created_at);
  CREATE INDEX IF NOT EXISTS idx_memories_signal      ON memories(signal);
  CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id);
  CREATE INDEX IF NOT EXISTS idx_relations_to   ON relations(to_id);
  CREATE INDEX IF NOT EXISTS idx_feedback_request ON feedback(request_id);
`;

const INSERT_MEMORY = `
  INSERT INTO memories (
    id, text, corpus, collection, fact_key, version_id,
    valid_from, valid_to, status, agent, reason, memory_type,
    trust, source_ref, strength, metadata, relations, updated_at
  ) VALUES (?, ?, 'memory', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    text = excluded.text,
    fact_key = excluded.fact_key,
    version_id = excluded.version_id,
    valid_from = excluded.valid_from,
    valid_to = excluded.valid_to,
    status = excluded.status,
    agent = excluded.agent,
    reason = excluded.reason,
    memory_type = excluded.memory_type,
    trust = excluded.trust,
    source_ref = excluded.source_ref,
    metadata = excluded.metadata,
    relations = excluded.relations,
    updated_at = datetime('now')
    -- strength, access_count, last_accessed, created_at survive re-ingest
`;

const INSERT_KNOWLEDGE = `
  INSERT INTO memories (
    id, text, corpus, collection, fact_key, version_id,
    valid_from, status, source_ref, metadata, updated_at
  ) VALUES (?, ?, 'knowledge', ?, ?, ?, datetime('now'), 'current', ?, ?, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    text = excluded.text,
    source_ref = excluded.source_ref,
    metadata = excluded.metadata,
    updated_at = datetime('now')
    -- strength, access_count, last_accessed, created_at survive re-ingest
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
  AND memories_fts MATCH ?
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

/** Signal delta for a positive rating (memory was useful). */
const SIGNAL_POSITIVE = 0.2;
/** Signal delta for a negative rating (memory was misleading). */
const SIGNAL_NEGATIVE = -0.3;
/** Weight of signal in the final retrieval score. */
const SIGNAL_WEIGHT = 0.15;

/** Extract explicit memory ids from feedback ground truth ({source_ids}). */
function parseSignalIds(groundTruth: unknown): string[] {
  if (!groundTruth || typeof groundTruth !== "object") return [];
  const ids = (groundTruth as Record<string, unknown>).source_ids;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}

const SYNONYMS: Record<string, string> = {
  db: "database",
  postgres: "postgresql",
  psql: "postgresql",
  mongo: "mongodb",
  k8s: "kubernetes",
  js: "javascript",
  ts: "typescript",
  golang: "go",
  repo: "repository",
  auth: "authentication",
  config: "configuration",
  docs: "documentation",
  perf: "performance",
  deploy: "deployment",
};

function expandTerms(query: string): string {
  const words = query.replace(/[^\w\s]/g, " ").split(/\s+/).filter((t) => t.length > 1);
  const expanded = words.flatMap((w) => {
    const syn = SYNONYMS[w.toLowerCase()];
    return syn && syn !== w.toLowerCase() ? [`${w}*`, `${syn}*`] : [`${w}*`];
  });
  return [...new Set(expanded)].join(" OR ");
}

function normalizeFtsScore(rank: number): number {
  return Math.min(1, Math.abs(rank) / 10);
}

function recencyBoost(validFrom: string | null): number {
  if (!validFrom) return 0;
  const daysSince = (Date.now() - Date.parse(validFrom)) / 86_400_000;
  return Math.max(0, 1 - daysSince / 365) * 0.15;
}

/** TTL filter derived from lifecycle.TTL_DAYS. Fail-open: unknown types persist. */
function ttlCondition(): string {
  const clauses = Object.entries(TTL_DAYS)
    .filter(([, ttl]) => ttl !== null)
    .map(([type, ttl]) => `(m.memory_type != '${type}' OR datetime(m.created_at, '+${ttl} days') > datetime('now'))`);
  return clauses.length ? `(${clauses.join(" AND ")})` : `(1 = 1)`;
}

export interface SqliteStoreOptions {
  path: string;
  readOnly?: boolean;
}

export class SqliteStore implements HydraDBLike {
  private db: Database.Database;
  private schemaReady = false;

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

  private init(): void {
    if (this.schemaReady) return;
    this.schemaReady = true;
    this.db.exec(SCHEMA);
    this.migrate();
    this.db.exec(INDEXES);
  }

  /**
   * Additive migrations for DBs created before newer columns existed.
   * CREATE TABLE IF NOT EXISTS never alters, so each new column needs
   * an explicit ALTER here. Idempotent: skips columns that exist.
   */
  private migrate(): void {
    const existing = new Set(
      (this.db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    const addColumn = (name: string, ddl: string) => {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${ddl}`);
    };
    // Every column ever added, oldest first — DBs from any version migrate.
    addColumn("corpus", `corpus TEXT NOT NULL DEFAULT 'memory'`);
    addColumn("collection", `collection TEXT NOT NULL DEFAULT 'default'`);
    addColumn("fact_key", `fact_key TEXT`);
    addColumn("version_id", `version_id TEXT`);
    addColumn("valid_from", `valid_from TEXT`);
    addColumn("valid_to", `valid_to TEXT`);
    addColumn("status", `status TEXT DEFAULT 'current'`);
    addColumn("agent", `agent TEXT`);
    addColumn("reason", `reason TEXT`);
    addColumn("memory_type", `memory_type TEXT`);
    addColumn("trust", `trust TEXT`);
    addColumn("source_ref", `source_ref TEXT`);
    addColumn("strength", `strength REAL DEFAULT 1.0`);
    addColumn("access_count", `access_count INTEGER DEFAULT 0`);
    addColumn("last_accessed", `last_accessed TEXT`);
    addColumn("signal", `signal REAL DEFAULT 0`);
    addColumn("metadata", `metadata TEXT DEFAULT '{}'`);
    addColumn("relations", `relations TEXT DEFAULT '[]'`);
    addColumn("created_at", `created_at TEXT DEFAULT (datetime('now'))`);
    addColumn("updated_at", `updated_at TEXT DEFAULT (datetime('now'))`);
    // Rows inserted before the FTS table existed are invisible to MATCH.
    // Rebuild is idempotent and cheap on small stores.
    this.db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
  }

  private prepared(sql: string): Database.Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

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

  async ingestMemory(input: IngestMemoryInput): Promise<IngestResult> {
    this.init();
    const ids: string[] = [];

    this.db.transaction(() => {
      for (const item of input.memories) {
        const text = item.text ?? "";
        // Verbatim re-ingest (e.g. session re-capture) with no stable id:
        // reuse the existing row instead of duplicating.
        if (!item.id) {
          const dupe = this.prepared(
            `SELECT id FROM memories WHERE collection = ? AND status = 'current' AND text = ? LIMIT 1`,
          ).get(input.collection, text) as { id: string } | undefined;
          if (dupe) {
            this.recordAccessInTxn(dupe.id);
            ids.push(dupe.id);
            continue;
          }
        }

        const id = item.id ?? `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const md = item.additional_metadata ?? {};
        const initialStrength = memoryStrength(new Date().toISOString(), (md.memory_type as string) ?? null, 0, null);

        this.prepared(INSERT_MEMORY).run(
          id, item.text ?? "", input.collection,
          md.fact_key ?? null, md.version_id ?? id,
          md.valid_from ?? null, md.valid_to ?? null,
          md.status ?? "current", md.agent ?? null,
          md.reason ?? null, md.memory_type ?? null,
          md.trust ?? null, md.source_ref ?? null, initialStrength,
          JSON.stringify(md), JSON.stringify(item.relations?.ids ?? []),
        );

        const relType = item.relations?.ids?.length ? (item.relations.properties?.type as string ?? "relates") : null;
        if (relType) {
          for (const toId of item.relations!.ids!) {
            this.prepared(INSERT_RELATION).run(id, toId, relType, (item.relations!.properties?.reason as string | undefined) ?? null);
          }
        }

        if (md.memory_type === "correction") {
          this.prepared(
            `UPDATE memories
             SET signal = MIN(1.0, COALESCE(signal, 0) + ?),
                 updated_at = datetime('now')
             WHERE id = ?`,
          ).run(SIGNAL_POSITIVE, id);
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
          null, id, doc.url ?? null,
          JSON.stringify({ ...md, source_ref: doc.url, timestamp: doc.timestamp }),
        );
        ids.push(id);
      }
    })();

    return { ids, ok: true, requestId: `req_${Date.now().toString(36)}` };
  }

  async awaitIndexed(ids: string[]): Promise<boolean> {
    this.init();
    return ids.length > 0;
  }

  async contextStatus(ids: string[]): Promise<{ statuses: Array<{ id: string; indexing_status: string }>; raw: unknown }> {
    this.init();
    return { statuses: ids.map((id) => ({ id, indexing_status: "ready" })), raw: { engine: "sqlite" } };
  }

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

  async query(input: QueryInput): Promise<QueryResult> {
    this.init();
    const collection = input.collection ?? "default";
    const maxResults = input.max_results ?? 15;
    const query = (input.query ?? "").trim();

    // Global scope: user-level memories visible from every collection.
    const collections = collection === "global" ? [collection] : [collection, "global"];
    const conditions = [`m.collection IN (${collections.map(() => "?").join(",")})`];
    const params: unknown[] = [...collections];

    if (input.type && input.type !== "all") {
      conditions.push("m.corpus = ?");
      params.push(input.type);
    }
    if (input.metadata_filters?.include_superseded || input.metadata_filters?.as_of) {
      conditions.push("(m.status IS NULL OR m.status NOT IN ('forgotten'))");
    } else {
      conditions.push("(m.status IS NULL OR m.status NOT IN ('forgotten', 'superseded'))");
    }

    if (input.metadata_filters?.as_of) {
      conditions.push("m.valid_from <= ?");
      conditions.push("(m.valid_to IS NULL OR m.valid_to > ?)");
      params.push(input.metadata_filters.as_of, input.metadata_filters.as_of);
    }

    // TTL enforcement: filter expired memories by type (from lifecycle.TTL_DAYS)
    conditions.push(ttlCondition());

    const where = `WHERE ${conditions.join(" AND ")}`;
    const limit = Math.min(maxResults * 3, 200);

    const rows = query ? this.searchFts(query, where, params, limit) : this.searchRecent(where, params, limit);

    const scored = rows
      .map((r) => {
        const ftsScore = r.score < 0 ? normalizeFtsScore(r.score) : r.score;
        const lifecycle = lifecycleScoreModifier(
          r.created_at, r.memory_type, r.access_count ?? 0, r.last_accessed, r.status,
        );
        // FTS relevance + lifecycle strength + learned feedback signal
        const score = ftsScore * 0.7 + lifecycle * 0.3
          + recencyBoost(r.valid_from) + (r.signal ?? 0) * SIGNAL_WEIGHT;
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
          created_at: r.created_at, signal: r.signal ?? 0,
          staleness: stalenessLabel(r.created_at),
        },
      };
    });

    if (input.mode === "thinking" || input.graph_context === true) {
      chunks.push(...this.expandRelations(chunks, collection, maxResults));
    }

    return { chunks, requestId: `req_${Date.now().toString(36)}`, latencyMs: 0, raw: { engine: "sqlite", path: this.opts.path } };
  }

  /** 1-hop relation expansion for thinking mode: linked memories at half score. */
  private expandRelations(chunks: QueryChunk[], collection: string, maxResults: number): QueryChunk[] {
    const seen = new Set(chunks.map((c) => c.id));
    const out: QueryChunk[] = [];
    for (const chunk of chunks) {
      if (out.length + chunks.length >= maxResults) break;
      const linked = this.db.prepare(
        `SELECT m.* FROM relations r
         JOIN memories m ON m.id = CASE WHEN r.from_id = ? THEN r.to_id ELSE r.from_id END
         WHERE (r.from_id = ? OR r.to_id = ?) AND m.collection = ? AND m.status = 'current'
         LIMIT 3`,
      ).all(chunk.id, chunk.id, chunk.id, collection) as Row[];
      for (const row of linked) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        let md: Record<string, unknown> = {};
        try { md = JSON.parse(row.metadata); } catch { /* ignore */ }
        out.push({
          id: row.id, text: row.text, content: row.text,
          corpus: row.corpus as "memory" | "knowledge", score: (chunk.score ?? 0) * 0.5,
          metadata: { ...md, fact_key: row.fact_key, via_relation: chunk.id },
        });
      }
    }
    return out;
  }

  private searchFts(query: string, where: string, params: unknown[], limit: number) {
    const terms = expandTerms(query);
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

  async feedback(input: FeedbackInput): Promise<void> {
    this.init();
    this.prepared(`INSERT INTO feedback (request_id, rating, feedback, source, ground_truth) VALUES (?, ?, ?, ?, ?)`)
      .run(input.request_id, input.rating ?? null, input.feedback ?? null, input.source ?? "agent", input.ground_truth ? JSON.stringify(input.ground_truth) : null);

    // Close the loop: ratings adjust per-memory signal used in ranking.
    const delta = input.rating === "positive" ? SIGNAL_POSITIVE
      : input.rating === "negative" ? SIGNAL_NEGATIVE : 0;
    if (delta !== 0) {
      const ids = parseSignalIds(input.ground_truth);
      if (ids.length) this.applySignal(ids, delta);
    }

    if (input.rating === "negative" && input.metadata?.query?.trim()) {
      const pattern = input.metadata.query.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
      this.prepared(
        `INSERT INTO query_failures (pattern, fails, last_at) VALUES (?, 1, datetime('now'))
         ON CONFLICT(pattern) DO UPDATE SET fails = fails + 1, last_at = datetime('now')`,
      ).run(pattern);
    }
  }

  /** Top failing query patterns for Dream gap analysis. */
  getQueryFailures(limit = 10): Array<{ pattern: string; fails: number }> {
    this.init();
    return this.db.prepare(
      `SELECT pattern, fails FROM query_failures ORDER BY fails DESC, last_at DESC LIMIT ?`,
    ).all(limit) as Array<{ pattern: string; fails: number }>;
  }

  /**
   * Adjust retrieval signal for explicit memory ids.
   * Positive = useful (rank higher), negative = misleading (rank lower).
   * Clamped to [-1, 1]. Used by feedback() and correction learning.
   */
  applySignal(ids: string[], delta: number): void {
    this.init();
    this.db.transaction(() => {
      for (const id of ids) {
        this.prepared(
          `UPDATE memories
           SET signal = MIN(1.0, MAX(-1.0, COALESCE(signal, 0) + ?)),
               updated_at = datetime('now')
           WHERE id = ?`,
        ).run(delta, id);
      }
    })();
  }

  /** Record access: bumps count + timestamp for reinforcement. */
  recordAccess(id: string): void {
    this.init();
    this.prepared(
      `UPDATE memories SET access_count = access_count + 1, last_accessed = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(id);
  }

  private recordAccessInTxn(id: string): void {
    this.prepared(
      `UPDATE memories SET access_count = access_count + 1, last_accessed = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(id);
  }

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

  getConsolidationCandidates(collection: string = "default"): ConsolidationCandidate[] {
    this.init();
    return this.db.prepare(
      `SELECT id, fact_key AS factKey, text, memory_type AS memoryType,
              created_at AS createdAt, strength, access_count AS accessCount
       FROM memories WHERE collection = ? AND status = 'current'`,
    ).all(collection) as ConsolidationCandidate[];
  }

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

  updateStrengths(collection: string = "default", onlyStaleOlderThanHours = 0): number {
    this.init();
    const rows = this.db.prepare(
      `SELECT id, created_at, memory_type, access_count, last_accessed, strength, updated_at
       FROM memories WHERE collection = ? AND status = 'current'`,
    ).all(collection) as Array<{
      id: string; created_at: string; memory_type: string | null;
      access_count: number; last_accessed: string | null;
      strength: number; updated_at: string;
    }>;

    const cutoff = Date.now() - onlyStaleOlderThanHours * 3_600_000;
    const due = rows.filter((r) => {
      if (onlyStaleOlderThanHours <= 0) return true;
      if (Date.parse(r.updated_at) <= cutoff) return true;
      return Math.abs((r.strength ?? 1) - memoryStrength(r.created_at, r.memory_type, r.access_count, r.last_accessed)) >= 0.01;
    });

    this.db.transaction(() => {
      for (const r of due) {
        const strength = memoryStrength(r.created_at, r.memory_type, r.access_count, r.last_accessed);
        this.prepared(`UPDATE memories SET strength = ?, updated_at = datetime('now') WHERE id = ?`).run(strength, r.id);
      }
    })();

    return due.length;
  }

  /** Unfinished work: current tasks, never accessed, older than 7 days. */
  getOpenLoops(collection: string = "default"): Array<{ id: string; text: string; created_at: string; age_days: number }> {
    this.init();
    return this.db.prepare(
      `SELECT id, text, created_at,
              CAST((julianday('now') - julianday(created_at)) AS INTEGER) AS age_days
       FROM memories
       WHERE collection = ? AND status = 'current' AND memory_type = 'task'
         AND COALESCE(access_count, 0) = 0
         AND datetime(created_at, '+7 days') <= datetime('now')
       ORDER BY created_at ASC
       LIMIT 50`,
    ).all(collection) as Array<{ id: string; text: string; created_at: string; age_days: number }>;
  }

  /** Auto-resolve correction chains: newest correction per fact_key wins, rest superseded. */
  resolveContradictions(collection: string = "default"): number {
    this.init();
    const rows = this.db.prepare(
      `SELECT id, fact_key, created_at FROM memories
       WHERE collection = ? AND status = 'current' AND memory_type = 'correction' AND fact_key IS NOT NULL
       ORDER BY fact_key, created_at DESC`,
    ).all(collection) as Array<{ id: string; fact_key: string; created_at: string }>;

    const seen = new Set<string>();
    const losers: string[] = [];
    for (const r of rows) {
      if (seen.has(r.fact_key)) losers.push(r.id);
      else seen.add(r.fact_key);
    }

    this.db.transaction(() => {
      for (const id of losers) {
        this.prepared(`UPDATE memories SET status = 'superseded', updated_at = datetime('now') WHERE id = ?`).run(id);
      }
    })();

    return losers.length;
  }

  /** Export all rows for backup or cross-machine sync (JSONL-friendly). */
  exportRows(collection?: string): Array<Record<string, unknown>> {
    this.init();
    const memories = (collection
      ? this.db.prepare(`SELECT * FROM memories WHERE collection = ?`).all(collection)
      : this.db.prepare(`SELECT * FROM memories`).all()) as Array<Record<string, unknown>>;
    const relations = this.db.prepare(`SELECT from_id, to_id, type, reason FROM relations`).all() as Array<Record<string, unknown>>;
    return [
      ...memories.map((m) => ({ kind: "memory", ...m })),
      ...relations.map((r) => ({ kind: "relation", ...r })),
    ];
  }

  /**
   * Import rows from exportRows. Local wins by default: existing ids are
   * skipped unless overwrite is set. Returns { imported, skipped }.
   */
  importRows(rows: Array<Record<string, unknown>>, overwrite = false): { imported: number; skipped: number } {
    this.init();
    let imported = 0;
    let skipped = 0;

    this.db.transaction(() => {
      for (const row of rows) {
        if (row.kind === "relation") {
          const exists = this.db.prepare(`SELECT 1 FROM relations WHERE from_id = ? AND to_id = ? AND type = ?`)
            .get(row.from_id, row.to_id, row.type);
          if (exists) { skipped++; continue; }
          this.prepared(INSERT_RELATION).run(row.from_id, row.to_id, row.type, row.reason ?? null);
          imported++;
          continue;
        }
        if (row.kind !== "memory" || typeof row.id !== "string") { skipped++; continue; }
        const exists = this.prepared(`SELECT 1 FROM memories WHERE id = ?`).get(row.id);
        if (exists && !overwrite) { skipped++; continue; }
        const cols = ["id", "text", "corpus", "collection", "fact_key", "version_id", "valid_from", "valid_to", "status", "agent", "reason", "memory_type", "trust", "source_ref", "strength", "access_count", "last_accessed", "metadata", "relations", "created_at", "updated_at"];
        const vals = cols.map((c) => (row[c] as unknown) ?? null);
        this.prepared(
          overwrite
            ? `INSERT OR REPLACE INTO memories (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`
            : `INSERT OR IGNORE INTO memories (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
        ).run(...vals);
        imported++;
      }
      this.db.exec(`INSERT INTO memories_fts(memories_fts) VALUES('rebuild')`);
    })();

    return { imported, skipped };
  }

  close(): void {
    this.stmts.clear();
    this.db.close();
  }
}

interface Row {
  id: string; text: string; corpus: string; fact_key: string | null;
  version_id: string | null; valid_from: string | null; valid_to: string | null;
  status: string | null; agent: string | null; reason: string | null;
  memory_type: string | null; trust: string | null; source_ref: string | null;
  metadata: string; score: number; created_at: string;
  strength: number; access_count: number; last_accessed: string | null;
  signal: number | null;
  lifecycle_strength?: number;
}
