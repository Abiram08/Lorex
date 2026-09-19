/** Local memory store contract: types shared by the engine, stores, and interfaces. */

export interface HydraDBLike {
  createDatabase(database: string): Promise<void>;
  awaitDatabaseReady(database: string, maxAttempts?: number, intervalMs?: number): Promise<void>;
  databaseStatus(database: string): Promise<{ ready: boolean; raw: unknown }>;
  ingestMemory(input: IngestMemoryInput): Promise<IngestResult>;
  ingestKnowledge(input: IngestKnowledgeInput): Promise<IngestResult>;
  awaitIndexed(ids: string[], maxAttempts?: number, intervalMs?: number, scope?: ContextScope): Promise<boolean>;
  contextStatus(ids: string[], scope?: ContextScope): Promise<{ statuses: Array<{ id: string; indexing_status: string }>; raw: unknown }>;
  contextRelations(scope: ContextScope, ids?: string[]): Promise<HydraRelations>;
  query(input: QueryInput): Promise<QueryResult>;
  feedback(input: FeedbackInput): Promise<void>;
  ping(database: string): Promise<{ reachable: boolean; authed: boolean; latencyMs: number; ready?: boolean; error?: string }>;
}

export interface ContextScope {
  database?: string;
  collection?: string;
}

export type StoreType = "knowledge" | "memory" | "all";
export type QueryMode = "fast" | "thinking";
export type QueryBy = "hybrid" | "text";

export interface MemoryItem {
  id?: string;
  title?: string;
  text?: string;
  user_assistant_pairs?: { user: string; assistant: string }[];
  is_markdown?: boolean;
  infer?: boolean;
  custom_instructions?: string;
  user_name?: string;
  expiry_time?: number;
  tenant_metadata?: string;
  additional_metadata?: Record<string, unknown>;
  relations?: { ids: string[]; properties?: Record<string, unknown> };
}

export interface IngestMemoryInput {
  database: string;
  collection: string;
  memories: MemoryItem[];
}

export interface IngestKnowledgeInput {
  database: string;
  collection?: string;
  documents?: Array<{
    id?: string;
    title?: string;
    content?: { text?: string; markdown?: string };
    tenant_metadata?: Record<string, unknown>;
    additional_metadata?: Record<string, unknown>;
    url?: string;
    timestamp?: string;
    type?: string;
    relations?: { ids: string[]; properties?: Record<string, unknown> };
  }>;
}

export interface IngestResult {
  ok: boolean;
  ids: string[];
  requestId: string;
}

export const MAX_QUERY_RESULTS = 50;

export interface QueryInput {
  database: string;
  collection?: string;
  query: string;
  type?: StoreType;
  query_by?: QueryBy;
  operator?: "or" | "and" | "phrase";
  mode?: QueryMode;
  max_results?: number;
  alpha?: number | "auto";
  recency_bias?: number;
  graph_context?: boolean;
  query_forceful_relations?: boolean;
  additional_context?: string;
  metadata_filters?: Record<string, unknown>;
  query_apps?: boolean;
  profile?: boolean;
}

export interface QueryChunk {
  id: string;
  text?: string;
  content?: string;
  score?: number;
  type?: string;
  corpus?: "memory" | "knowledge";
  source_id?: string;
  metadata?: Record<string, unknown>;
}

export interface HydraRelations {
  entities?: Array<{ id?: string; name?: string; type?: string }>;
  relations?: Array<{ source?: string; target?: string; type?: string; from?: string; to?: string }>;
  chunk_relations?: unknown[];
  query_paths?: unknown[];
}

export interface GraphContext {
  query_paths?: unknown[];
  chunk_relations?: unknown[];
  chunk_id_to_group_ids?: Record<string, string[]>;
}

export interface QueryResult {
  chunks: QueryChunk[];
  graphContext?: GraphContext;
  additionalContext?: string[];
  requestId: string;
  latencyMs: number;
  raw: unknown;
}

export interface FeedbackInput {
  request_id: string;
  feedback?: string;
  rating?: "positive" | "negative" | "neutral";
  source?: "user" | "agent";
  database?: string;
  collection?: string;
  ground_truth?: { answer: string; source_ids?: string[] };
  metadata?: Record<string, string>;
}

export class HydraDBError extends Error {
  constructor(
    message: string,
    public readonly kind: "network" | "auth" | "rate_limit" | "server" | "client" | "not_ready",
    public readonly status?: number,
    public readonly code?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HydraDBError";
  }
}
