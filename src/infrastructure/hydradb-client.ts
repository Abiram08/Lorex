/** HydraDB v2 API client: types, request handling, and response validation. */

import type { Config } from "./config.js";
import { VERSION } from "./version.js";

const MAX_CONCURRENT_REQUESTS = 5;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffDelay(attempt: number): number {
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return Math.floor(exponential * (0.5 + Math.random() * 0.5));
}

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

export interface Envelope<T> {
  success: boolean;
  data: T;
  error: { code: string; message: string } | null;
  meta: { request_id: string; latency_ms: number; deprecation?: unknown[] };
}

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

interface IngestEnvelope {
  results?: Array<{ id?: string; status?: string; error?: string | null; error_code?: string | null }>;
  ids?: string[];
  success_count?: number;
  failed_count?: number;
}

function toIngestResult(env: Envelope<IngestEnvelope>): IngestResult {
  const results = env.data?.results ?? [];
  const ids = results.length
    ? results.map((r) => r.id).filter((id): id is string => !!id)
    : (env.data?.ids ?? []);

  const failed = results.filter((r) => r.error || r.error_code);
  if (failed.length) {
    const first = failed[0]!;
    throw new HydraDBError(
      `HydraDB rejected ${failed.length}/${results.length} item(s): ${first.error_code ?? ""} ${first.error ?? ""}`.trim(),
      "client",
    );
  }
  return { ok: env.success, ids, requestId: env.meta.request_id };
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

function validateEnvelope<T>(raw: unknown, path: string): Envelope<T> {
  if (!raw || typeof raw !== "object") {
    throw new HydraDBError(`HydraDB returned non-object on ${path}`, "server");
  }
  const env = raw as Record<string, unknown>;
  if (typeof env.success !== "boolean") {
    throw new HydraDBError(`HydraDB response missing 'success' on ${path}`, "server");
  }
  if (!env.meta || typeof env.meta !== "object") {
    throw new HydraDBError(`HydraDB response missing 'meta' on ${path}`, "server");
  }
  const meta = env.meta as Record<string, unknown>;
  if (typeof meta.request_id !== "string") {
    throw new HydraDBError(`HydraDB response missing 'meta.request_id' on ${path}`, "server");
  }
  return env as unknown as Envelope<T>;
}

function validateChunk(chunk: unknown): QueryChunk | null {
  if (!chunk || typeof chunk !== "object") return null;
  const c = chunk as Record<string, unknown>;

  const id = c.chunk_uuid ?? c.id ?? c.chunk_id;
  if (id === undefined || id === null || id === "") return null;

  const text = unwrapEnvelope(
    pickString(c.chunk_content) ??
      pickString(c.text) ??
      pickString(c.content) ??
      pickString((c.content as Record<string, unknown> | undefined)?.text),
  );

  const score =
    pickNumber(c.relevancy_score) ?? pickNumber(c.score) ?? pickNumber(c.relevance_score);

  const rawType = pickString(c.type) ?? pickString(c.source_type);
  const corpus =
    rawType === "memory" || rawType === "knowledge" ? (rawType as "memory" | "knowledge") : undefined;

  const metadata: Record<string, unknown> = {
    ...(isObject(c.metadata) ? c.metadata : {}),
    ...(isObject(c.additional_metadata) ? c.additional_metadata : {}),
  };
  if (pickString(c.source_title)) metadata.source_title = c.source_title;

  return {
    id: String(id),
    text,
    content: text,
    score,
    type: rawType,
    corpus,
    source_id: pickString(c.source_id) ?? pickString(c.id),
    metadata: Object.keys(metadata).length ? metadata : undefined,
  };
}

function unwrapEnvelope(text: string | undefined): string | undefined {
  if (!text) return text;
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return text;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const inner =
      pickString((parsed.content as Record<string, unknown> | undefined)?.text) ??
      pickString((parsed.content as Record<string, unknown> | undefined)?.markdown) ??
      pickString(parsed.text) ??
      pickString(parsed.chunk_content);
    if (!inner) return text;
    const title = pickString(parsed.title);
    return title && !inner.includes(title) ? `${title}\n${inner}` : inner;
  } catch {
    const marker = trimmed.match(/"content"\s*:\s*\{\s*"(?:text|markdown)"\s*:\s*"/);
    if (marker?.index !== undefined) {
      const body = trimmed.slice(marker.index + marker[0].length);
      const cleaned = body
        .replace(/(?<!\\)"\s*\}\s*\}?\s*$/, "")
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
      if (cleaned.trim().length > 20) return cleaned;
    }
    return text;
  }
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function pickNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
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

function classify(status: number): HydraDBError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (status >= 400) return "client";
  return "network";
}

export class HydraDBClient implements HydraDBLike {
  private inFlight = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly config: Config) {}

  private async acquireSlot(): Promise<void> {
    if (this.inFlight < MAX_CONCURRENT_REQUESTS) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.inFlight++;
  }

  private releaseSlot(): void {
    this.inFlight--;
    this.waiting.shift()?.();
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "API-Version": "2",
      "User-Agent": `lorex-mcp/${VERSION}`,
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts: { allowEmpty?: boolean; retries?: number } = {},
  ): Promise<Envelope<T>> {
    await this.acquireSlot();
    try {
      return await this.request<T>(method, path, body, opts);
    } finally {
      this.releaseSlot();
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts: { allowEmpty?: boolean; retries?: number } = {},
  ): Promise<Envelope<T>> {
    const maxRetries = opts.retries ?? 3;
    let lastError: HydraDBError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const url = `${this.config.baseUrl}${path}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: this.headers(!(body instanceof FormData)),
          body:
            body === undefined
              ? undefined
              : body instanceof FormData
                ? body
                : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if ((e as Error).name === "AbortError") {
          lastError = new HydraDBError(`HydraDB timed out after ${this.config.timeoutMs}ms: ${path}`, "network");
          if (attempt < maxRetries) {
            await sleep(backoffDelay(attempt));
            continue;
          }
          throw lastError;
        }
        lastError = new HydraDBError(`HydraDB unreachable (${path}): ${(e as Error).message}`, "network");
        if (attempt < maxRetries) {
          await sleep(backoffDelay(attempt));
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text();
      if (!res.ok) {
        const kind = classify(res.status);
        let code: string | undefined;
        try {
          const j = JSON.parse(text);
          code = j?.error?.code;
        } catch {  }
        const retryAfter = res.headers.get("retry-after");
        const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;

        if (kind === "rate_limit" && attempt < maxRetries) {
          await sleep(retryAfterMs ?? backoffDelay(attempt));
          continue;
        }

        if (kind === "server" && attempt < maxRetries) {
          lastError = new HydraDBError(
            `HydraDB ${res.status} ${kind} on ${path}: ${text.slice(0, 300)}`,
            kind,
            res.status,
            code,
            retryAfterMs,
          );
          await sleep(backoffDelay(attempt));
          continue;
        }

        throw new HydraDBError(
          `HydraDB ${res.status} ${kind} on ${path}: ${text.slice(0, 300)}`,
          kind,
          res.status,
          code,
          retryAfterMs,
        );
      }

      if (opts.allowEmpty && !text.trim()) {
        return { success: true, data: {} as T, error: null, meta: { request_id: `empty_${Date.now()}`, latency_ms: 0 } };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new HydraDBError(`HydraDB returned non-JSON on ${path}: ${text.slice(0, 200)}`, "server", res.status);
      }
      const env = validateEnvelope<T>(parsed, path);
      if (!env.success && env.error) {
        throw new HydraDBError(
          `HydraDB logical error on ${path}: ${env.error.message}`,
          "client",
          res.status,
          env.error.code,
        );
      }
      return env;
    }
    throw lastError ?? new HydraDBError(`HydraDB ${path}: max retries exceeded`, "server");
  }

  async createDatabase(database: string): Promise<void> {
    try {
      await this.call("POST", "/databases", { database });
    } catch (e) {
      const err = e as HydraDBError;
      if (err.code === "DATABASE_ALREADY_EXISTS" || err.status === 409) return;
      throw e;
    }
  }

  async databaseStatus(database: string): Promise<{ ready: boolean; raw: unknown }> {
    const env = await this.call<{ infra?: { ready_for_ingestion?: boolean }; status?: string }>(
      "GET",
      `/databases/status?database=${encodeURIComponent(database)}`,
      undefined,
    );
    return { ready: !!env.data?.infra?.ready_for_ingestion, raw: env.data };
  }

  async awaitDatabaseReady(database: string, maxAttempts = 15, intervalMs = 1000): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const { ready } = await this.databaseStatus(database);
      if (ready) return;
      await sleep(intervalMs);
    }
    throw new HydraDBError(`Database "${database}" not ready after ${maxAttempts} polls`, "not_ready");
  }

  async ingestMemory(input: IngestMemoryInput): Promise<IngestResult> {
    const form = new FormData();
    form.set("type", "memory");
    form.set("database", input.database);
    if (input.collection) form.set("collection", input.collection);
    form.set("memories", JSON.stringify(input.memories));

    const env = await this.call<IngestEnvelope>("POST", "/context/ingest", form);
    return toIngestResult(env);
  }

  async ingestKnowledge(input: IngestKnowledgeInput): Promise<IngestResult> {
    const form = new FormData();
    form.set("type", "knowledge");
    form.set("database", input.database);
    if (input.collection) form.set("collection", input.collection);
    if (input.documents) form.set("app_knowledge", JSON.stringify(input.documents));

    const env = await this.call<IngestEnvelope>("POST", "/context/ingest", form);
    return toIngestResult(env);
  }

  async contextStatus(
    ids: string[],
    scope: ContextScope = {},
  ): Promise<{ statuses: Array<{ id: string; indexing_status: string }>; raw: unknown }> {
    const params = new URLSearchParams();
    params.set("ids", ids.join(","));
    if (scope.database) params.set("database", scope.database);
    if (scope.collection) params.set("collection", scope.collection);
    const env = await this.call<{ statuses?: Array<{ id: string; indexing_status: string }> }>(
      "GET",
      `/context/status?${params.toString()}`,
      undefined,
    );
    return { statuses: env.data?.statuses ?? [], raw: env.data };
  }

  async contextRelations(scope: ContextScope, ids?: string[]): Promise<HydraRelations> {
    const params = new URLSearchParams();
    if (scope.database) params.set("database", scope.database);
    if (scope.collection) params.set("collection", scope.collection);
    if (ids?.length) params.set("ids", ids.join(","));
    try {
      const env = await this.call<HydraRelations>(
        "GET",
        `/context/relations?${params.toString()}`,
        undefined,
      );
      return env.data ?? {};
    } catch {
      return {};
    }
  }

  async awaitIndexed(
    ids: string[],
    maxAttempts = 60,
    intervalMs = 1000,
    scope: ContextScope = {},
  ): Promise<boolean> {
    if (ids.length === 0) return true;
    const started = Date.now();
    const hardCapMs = Math.max(60_000, maxAttempts * intervalMs);
    for (let i = 0; i < maxAttempts; i++) {
      if (Date.now() - started > hardCapMs) return false;
      const { statuses } = await this.contextStatus(ids, scope);
      const allDone =
        statuses.length > 0 &&
        ids.every((id) => {
          const s = statuses.find((x) => x.id === id);
          return s && (s.indexing_status === "completed" || s.indexing_status === "graph_creation");
        });
      if (allDone) return true;
      await sleep(intervalMs);
    }
    return false;
  }

  async query(input: QueryInput): Promise<QueryResult> {
    const { profile: _profile, ...rest } = input;
    const wire = {
      ...rest,
      max_results: Math.min(rest.max_results ?? 15, MAX_QUERY_RESULTS),
    };
    const env = await this.call<{
      results?: unknown[];
      chunks?: unknown[];
      graph_context?: GraphContext;
      additional_context?: string[];
    }>("POST", "/query", wire as unknown as Record<string, unknown>);

    const rawChunks = env.data?.results ?? env.data?.chunks ?? [];
    if (!Array.isArray(rawChunks)) {
      throw new HydraDBError(`HydraDB query response: expected array of chunks, got ${typeof rawChunks}`, "server");
    }

    const chunks: QueryChunk[] = [];
    for (let i = 0; i < rawChunks.length; i++) {
      const validated = validateChunk(rawChunks[i]);
      if (validated) {
        if (!validated.corpus) {
          validated.corpus = (input.type === "memory" || input.type === "knowledge") ? input.type : "memory";
        }
        if (!validated.text && !validated.content) {
          validated.text = "";
        }
        chunks.push(validated);
      }
    }

    return {
      chunks,
      graphContext: env.data?.graph_context,
      additionalContext: env.data?.additional_context,
      requestId: env.meta.request_id,
      latencyMs: env.meta.latency_ms,
      raw: env.data,
    };
  }

  async feedback(input: FeedbackInput): Promise<void> {
    await this.call("POST", "/feedback", input as unknown as Record<string, unknown>, { allowEmpty: true });
  }

  async ping(database: string): Promise<{
    reachable: boolean; authed: boolean; latencyMs: number; ready?: boolean; error?: string;
  }> {
    const start = Date.now();
    try {
      const env = await this.call<{ infra?: { ready_for_ingestion?: boolean } }>(
        "GET",
        `/databases/status?database=${encodeURIComponent(database)}`,
        undefined,
      );
      return {
        reachable: true,
        authed: true,
        latencyMs: Date.now() - start,
        ready: !!env.data?.infra?.ready_for_ingestion,
      };
    } catch (e) {
      const err = e as HydraDBError;
      return {
        reachable: err.kind !== "network",
        authed: err.kind !== "auth",
        latencyMs: Date.now() - start,
        error: err.message,
      };
    }
  }
}
