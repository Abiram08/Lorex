/** LorexEngine: every memory and context operation, returning a Receipt. */

import {
  spaceLabel,
  type MemoryStore,
  type MemoryItem,
  type QueryChunk,
  type FeedbackInput,
  type SpaceRow,
} from "./infrastructure/store.js";
import type { Identity } from "./infrastructure/identity.js";
import {
  METADATA_SCHEMA_VERSION,
  type Receipt,
  type ReceiptSource,
  type AbstentionReason,
} from "./domain/receipts.js";
import {
  classifyMemoryType,
  generateTopicKey,
  makeVersionId,
  extractAtomicValue,
} from "./domain/fact.js";
import { excerpt } from "./domain/evidence.js";
import {
  buildContextGraph,
  type ContextGraph,
  type HydraGraphContext,
  type HydraRelationSlice,
} from "./domain/graph.js";
import {
  extractReason,
  extractTransition,
  detectExtension,
  renderCausalChain,
  type CausalChain,
  type CausalLink,
  type CausalSource,
} from "./domain/causality.js";
import { retrieve } from "./retrieval/store-retriever.js";
import { assembleEvidence, synthesizeTimeline, synthesizeAnswer } from "./retrieval/evidence-assembler.js";
import { buildContextPack } from "./retrieval/context-pack.js";
import { determineAbstention, MIN_LEXICAL_RELEVANCE_AGGREGATE } from "./synthesis/abstention.js";
import {
  resolveSynthesisConfig,
  synthesizeGroundedAnswer,
} from "./synthesis/llm-synthesizer.js";
import { verifyPackSupport, llmVerifySupport, type VerifyTier } from "./synthesis/verify.js";
import { classifyAndPlan } from "./retrieval/planner.js";
import { ingestSession as runSessionIngestion, type FactIndex } from "./ingestion/pipeline.js";
import { llmExtractionEnabled } from "./ingestion/extractor.js";
import type { NormalizedSession } from "./domain/session.js";
import { LIMITS, assertMaxLength, clampInt } from "./infrastructure/limits.js";
import { RateLimiter, RateLimitError } from "./infrastructure/rate-limiter.js";
import { computeCompression, resolveContextBudget } from "./domain/compression.js";
import { countTokens } from "./ingestion/token-counter.js";
import { redactSecrets } from "./infrastructure/secrets.js";

async function extractPdfText(path: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const { PDFParse } = (await import("pdf-parse")) as unknown as {
    PDFParse: new (opts: { data: Buffer }) => {
      getText(): Promise<{ text?: string; total?: number }>;
      destroy(): Promise<void>;
    };
  };
  const parser = new PDFParse({ data: readFileSync(path) });
  try {
    const result = await parser.getText();
    return result.text ?? "";
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
import { dreamHeuristic, shouldDream, type DreamMemory, type DreamOptions, type DreamResult } from "./infrastructure/dream.js";
import { planConsolidation } from "./infrastructure/lifecycle.js";
import type { ReviewRow, SqliteStore } from "./infrastructure/sqlite-store.js";
import { taskContext } from "./interfaces/task-context.js";

const CORPUS_STATS_KEY = "lorex_corpus_stats";
const CORPUS_STATS_TYPE = "corpus_stats";

/** Cap on paragraphs ingested from one document. Overflow is reported, not dropped silently. */
const MAX_DOCUMENT_PARAGRAPHS = 100;

/** Profile slot holding when Dream last ran, so the auto-trigger has a clock. */
const DREAM_PROFILE_KIND = "dream";
/** Sessions of new material required before Dream runs on its own. Mirrors shouldDream. */
const DREAM_GATE_SESSIONS = 5;
/** Derived memories below this bar require a human decision. */
const DREAM_AUTO_APPLY_CONFIDENCE = 0.8;

/**
 * The in-memory fact index is per-process and keyed by collection as well as
 * fact key: "global" scope is a different collection, so the same topic key in
 * two collections must not be treated as one chain.
 */
function scopedIndexKey(collection: string, factKey: string): string {
  return `${collection}::${factKey}`;
}

export interface RememberOpts {
  validFrom?: string;
  validTo?: string;
  id?: string;
  sourceRef?: string;
  forget?: boolean;
  ttlSeconds?: number;
  because?: string;
  agent?: string;
  /** "global" writes to the shared user-level collection visible everywhere. */
  scope?: "global" | "project";
  /** Explicit edge to the current version: extends keeps both current. */
  relation?: "supersedes" | "extends";
}

export interface ProfileSnapshot {
  collection: string;
  kind: "user" | "project";
  updatedAt: string;
  cached: boolean;
  preferences: Array<{ text: string; strength: number }>;
  decisions: Array<{ text: string; created_at: string }>;
  constraints: string[];
  openLoops: Array<{ text: string; age_days: number }>;
  lastHandoff?: { decision: string; nextStep?: string; at: string };
}

export interface RecallOpts {  query?: string;
  asOf?: string;
  mode?: "fast" | "thinking";
  type?: "memory" | "knowledge" | "all";
  maxResults?: number;
  maxTokens?: number;
  snapshot?: boolean;
  minRelevance?: number;
  abstainOnAmbiguity?: boolean;
  /** Opt-in: synthesize a grounded answer with [n] citations via the
   * LOREX_LLM_BASE_URL endpoint. Falls back to deterministic synthesis. */
  synthesize?: boolean;
  /** Post-retrieval support verification: "auto" (deterministic answer-type
   * entailment, default), "llm" (adds a cheap yes/no judgment on top-3
   * sources when an endpoint is configured), or "off". */
  verify?: VerifyTier;
}

/** Default query for a session-start pack when no specific question is given. */
const DEFAULT_PACK_QUERY =
  "current project decisions preferences constraints corrections open tasks handoff next step architecture";

export interface ContextPackOpts {
  query?: string;
  maxTokens?: number;
  maxResults?: number;
  mode?: "fast" | "thinking";
  type?: "memory" | "knowledge" | "all";
  /** Skip relevance abstention (session-start default; true when no query given). */
  snapshot?: boolean;
}

/** Memory-quality report from `engine.reflect()`. Read-only. */
export interface ReflectReport {
  /** False with the in-memory backend, which has no lifecycle columns to measure. */
  available: boolean;
  collection: string;
  total: number;
  byType: Record<string, number>;
  stale: number;
  expired: number;
  duplicateTextClusters: number;
  duplicateTextRows: number;
  multiCurrentTopics: Array<{ factKey: string; versions: number }>;
  contradictions: number;
  neverRecalled: number;
  recallGaps: Array<{ pattern: string; fails: number }>;
  healthy: boolean;
  findings: string[];
}

export class LorexEngine {
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private corpusTokens = 0;
  private readonly factIndex: FactIndex = new Map();
  private corpusStatsLoaded = false;
  private corpusTokensSaved = 0;
  private get agent(): string {
    return this.identity.agent || "unknown";
  }

  constructor(
    private readonly client: MemoryStore,
    private readonly identity: Identity,
    sharedLimiter?: RateLimiter,
  ) {
    this.limiter = sharedLimiter ?? new RateLimiter();
  }

  readonly limiter: RateLimiter;

  get usage() {
    return this.limiter.snapshot();
  }

  getCorpusTokens(): number {
    return this.corpusTokens;
  }

  setCorpusTokens(n: number): void {
    this.corpusTokens = Math.max(0, Math.floor(n));
  }

  private trackTokens(text: string): void {
    this.corpusTokens += countTokens(text);
  }

  private async loadCorpusStats(): Promise<void> {
    if (this.corpusStatsLoaded) return;
    this.corpusStatsLoaded = true;
    try {
      const result = await retrieve(this.client, {
        database: this.identity.database,
        collection: this.identity.collection,
        query: CORPUS_STATS_KEY,
        mode: "fast",
        type: "memory",
        maxResults: 5,
      });
      const marker = result.chunks.find(
        (c) => (c.metadata as Record<string, unknown> | undefined)?.fact_key === CORPUS_STATS_KEY,
      );
      const stored = Number((marker?.metadata as Record<string, unknown> | undefined)?.haystack_tokens);
      if (Number.isFinite(stored) && stored > this.corpusTokens) this.corpusTokens = stored;
    } catch {
    }
  }

  private async saveCorpusStats(): Promise<void> {
    if (this.corpusTokens <= 0) return;
    const grown = this.corpusTokens - this.corpusTokensSaved;
    if (this.corpusTokensSaved > 0 && grown < this.corpusTokensSaved * 0.1) return;
    const publishing = this.corpusTokens;
    this.corpusTokensSaved = publishing;
    const at = new Date().toISOString();
    // Internal follow-up write of an already-gated operation: count it against
    // the budget without re-checking, so it can never fail mid-operation.
    this.limiter.consume("write");
    try {
      await this.client.ingestMemory({
        database: this.identity.database,
        collection: this.identity.collection,
        memories: [{
          id: CORPUS_STATS_KEY,
          text: `${CORPUS_STATS_KEY}: ingested history of ${publishing} tokens.`,
          infer: false,
          additional_metadata: {
            schema_version: METADATA_SCHEMA_VERSION,
            fact_key: CORPUS_STATS_KEY,
            version_id: CORPUS_STATS_KEY,
            memory_type: CORPUS_STATS_TYPE,
            haystack_tokens: publishing,
            valid_from: at,
            timestamp: at,
            status: "current",
          },
        }],
      });
    } catch {
      this.corpusTokensSaved = 0;
    }
  }

  async ensureReady(): Promise<void> {
    if (this.ready) return;
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        await this.client.createDatabase(this.identity.database);
        await this.client.awaitDatabaseReady(
          this.identity.database,
          LIMITS.databaseReadyMaxAttempts,
          LIMITS.databaseReadyIntervalMs,
        );
        this.ready = true;
      })().catch((e) => {
        this.readyPromise = null;
        throw e;
      });
    }
    await this.readyPromise;
  }

  getIdentity(): Identity {
    return this.identity;
  }

  /** Fresh local task state for every prompt; no process-level cache. */
  sharedTaskContext(taskId?: string, maxChars = 3000): string {
    if (!taskId || typeof (this.client as Partial<SqliteStore>).getTask !== "function") return "";
    return taskContext(this.client as SqliteStore, this.identity.collection, taskId, maxChars);
  }

  /**
   * Documents in, memories out: read a file, URL, or raw text, split into
   * paragraph turns, and run the standard session pipeline with the source
   * stamped on every chunk and fact.
   */
  async ingestDocument(input: {
    path?: string;
    url?: string;
    text?: string;
    sourceRef?: string;
    sessionId?: string;
  }): Promise<import("./ingestion/pipeline.js").IngestionResult> {
    await this.ensureReady();
    let content: string;
    const sourceRef = input.sourceRef ?? input.path ?? input.url ?? "inline";

    if (input.text !== undefined) {
      content = input.text;
    } else if (input.path) {
      const { readFileSync, existsSync, statSync } = await import("node:fs");
      if (!existsSync(input.path)) throw new Error(`file not found: ${input.path}`);
      if (statSync(input.path).size > LIMITS.maxContentChars * 4) {
        throw new Error(`file too large (max ~${LIMITS.maxContentChars * 4} bytes)`);
      }
      if (input.path.toLowerCase().endsWith(".pdf")) {
        content = await extractPdfText(input.path);
      } else {
        content = readFileSync(input.path, "utf8");
      }
    } else if (input.url) {
      const res = await fetch(input.url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`fetch failed: ${res.status} ${input.url}`);
      content = (await res.text()).slice(0, LIMITS.maxContentChars);
    } else {
      throw new Error("path, url, or text is required");
    }

    // Split into paragraph turns. A very large document is capped, but the cap is
    // REPORTED: silently dropping the tail of someone's runbook is exactly the
    // kind of quiet data loss a memory layer must never have.
    const allParagraphs = content
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 20);
    const paragraphs = allParagraphs.slice(0, MAX_DOCUMENT_PARAGRAPHS);
    if (!paragraphs.length) throw new Error("document has no ingestible content");

    const { normalizeSession } = await import("./ingestion/normalizer.js");
    const sessionId = input.sessionId ?? `doc_${Date.now().toString(36)}`;
    const session = normalizeSession(
      sessionId,
      this.identity.database,
      this.identity.collection,
      paragraphs.map((p) => ({ role: "user" as const, content: p })),
      { agent: this.agent, source: sourceRef },
    );
    const result = await this.ingestSession(session);
    if (allParagraphs.length > paragraphs.length) {
      result.errors.push(
        `document truncated: ingested ${paragraphs.length} of ${allParagraphs.length} paragraphs ` +
          `(cap ${MAX_DOCUMENT_PARAGRAPHS}); split the file or raise the cap`,
      );
      result.partial = true;
    }
    return result;
  }

  async ingestSession(
    session: NormalizedSession,
    opts: {
      indexWait?: { maxAttempts: number; intervalMs: number } | false;
      maxTokensPerChunk?: number;
    } = {},
  ): Promise<import("./ingestion/pipeline.js").IngestionResult> {
    await this.ensureReady();
    const estimatedTokens = session.turns.reduce(
      (sum, t) => sum + countTokens(t.content),
      0,
    );
    // Check the token budget before consuming the write slot so a rejected
    // ingest doesn't burn a write from the hourly/daily quota.
    this.limiter.acquire("ingest_tokens", estimatedTokens);
    this.limiter.acquire("write");
    // LLM extraction (LOREX_EXTRACT=llm) bills against the synthesis budget.
    if (llmExtractionEnabled()) this.limiter.acquire("synth");
    const scoped: NormalizedSession = {
      ...session,
      database: this.identity.database,
      collection: this.identity.collection,
    };
    const result = await runSessionIngestion(this.client, scoped, {
      database: this.identity.database,
      collection: this.identity.collection,
      indexWait: opts.indexWait,
      maxTokensPerChunk: opts.maxTokensPerChunk,
      factIndex: this.factIndex,
    });
    this.corpusTokens += result.tokenCount || 0;
    await this.saveCorpusStats();
    return result;
  }

  async awaitIndexed(ids: string[], maxAttempts = 120, intervalMs = 1_000): Promise<boolean> {
    if (!ids.length) return true;
    return this.client.awaitIndexed(ids, maxAttempts, intervalMs, {
      database: this.identity.database,
      collection: this.identity.collection,
    });
  }

  withCollection(collection: string): LorexEngine {
    const sibling = new LorexEngine(
      this.client,
      { ...this.identity, collection, collectionLabel: collection },
      this.limiter,
    );
    sibling.ready = this.ready;
    sibling.readyPromise = this.readyPromise;
    return sibling;
  }

  async remember(fact: string, opts: RememberOpts = {}): Promise<Receipt> {
    await this.ensureReady();
    const body = fact.trim();
    if (!body) throw new Error("fact is required");
    assertMaxLength("fact", body, LIMITS.maxFactChars);
    if (opts.id) assertMaxLength("id", opts.id, LIMITS.maxIdChars);
    if (opts.sourceRef) assertMaxLength("sourceRef", opts.sourceRef, LIMITS.maxSourceRefChars);
    if (opts.ttlSeconds !== undefined &&
        (!Number.isSafeInteger(opts.ttlSeconds) || opts.ttlSeconds < 1 || opts.ttlSeconds > 365 * 24 * 3600)) {
      throw new Error("ttlSeconds must be an integer between 1 and 31536000");
    }

    const recordedAt = new Date().toISOString();
    const validFrom = opts.validFrom ?? recordedAt;
    if (Number.isNaN(Date.parse(validFrom))) throw new Error("validFrom must be a valid ISO date");
    if (opts.validTo && (Number.isNaN(Date.parse(opts.validTo)) || Date.parse(opts.validTo) <= Date.parse(validFrom))) {
      throw new Error("validTo must be a valid date after validFrom");
    }
    const ttlEnd = opts.ttlSeconds === undefined
      ? undefined
      : new Date(Date.parse(recordedAt) + opts.ttlSeconds * 1_000).toISOString();
    const validTo = ttlEnd && opts.validTo
      ? (Date.parse(ttlEnd) < Date.parse(opts.validTo) ? ttlEnd : opts.validTo)
      : ttlEnd ?? opts.validTo;

    const factKey = generateTopicKey(body, opts.id);
    const versionId = makeVersionId(factKey);
    const atomic = redactSecrets(extractAtomicValue(body)).text;
    // Global scope lives in its own collection, so the previous-version lookup
    // and the closure write must target it too — otherwise a global fact can
    // never supersede its own earlier version and duplicates pile up.
    const targetCollection = opts.scope === "global" ? "global" : this.identity.collection;

    const known = this.factIndex.get(scopedIndexKey(targetCollection, factKey));
    // The store is source of truth: the in-memory index goes stale across
    // processes (CLI + MCP server + hooks each hold their own). It only
    // fills in when the store has nothing (indexing lag, hash-key FTS miss).
    const current = (await this.findCurrentFactVersion(factKey, targetCollection)) ??
      (known && Date.parse(known.validFrom || "0") <= Date.parse(validFrom)
        ? { versionId: known.versionId, factKey, text: known.text, metadata: known.metadata }
        : undefined);

    this.limiter.acquire("write");
    this.limiter.acquire("ingest_tokens", countTokens(atomic));

    // Write the new version FIRST; only close the old one after it lands, so a
    // failed write never leaves the fact with no live version.
    const reason = opts.because?.trim() || extractReason(body);
    const reasonSource: "explicit" | "extracted" | "unknown" = opts.because?.trim()
      ? "explicit"
      : reason
        ? "extracted"
        : "unknown";
    const transition = extractTransition(body);
    // Additive update ("we also use X") extends the topic: both versions stay
    // current. Replacement ("we switched to X") supersedes. Explicit relation wins.
    const isExtension = opts.relation
      ? opts.relation === "extends"
      : !!current?.versionId && !opts.because && detectExtension(body, !!(transition.from || transition.to));

    // A fact with a future validTo is valid NOW and through that date, so it is
    // current; only an already-elapsed window is born superseded. The query-time
    // asOf/valid_to logic is what makes it expire.
    const validToElapsed = !!validTo && Date.parse(validTo) <= Date.parse(validFrom);
    const status = opts.forget ? "forgotten" : validToElapsed ? "superseded" : "current";
    const relationType = isExtension ? "extends" : "supersedes";
    const item: MemoryItem = {
      id: versionId,
      text: atomic,
      infer: true,
      expiry_time: opts.ttlSeconds,
      relations: current?.versionId
        ? { ids: [current.versionId], properties: { type: relationType, reason: reason ?? null } }
        : undefined,
      additional_metadata: {
        schema_version: METADATA_SCHEMA_VERSION,
        valid_from: validFrom,
        valid_to: opts.forget ? validFrom : validTo,
        source_ref: opts.sourceRef,
        timestamp: validFrom,
        recorded_at: recordedAt,
        fact_key: factKey,
        version_id: versionId,
        supersedes: isExtension ? undefined : current?.versionId,
        memory_type: classifyMemoryType(atomic),
        status,
        trust: "agent_explicit",
        agent: opts.agent ?? this.agent,
        reason,
        reason_source: reasonSource,
        from_value: transition.from,
        to_value: transition.to,
      },
    };

    const res = await this.client.ingestMemory({
      database: this.identity.database,
      collection: targetCollection,
      memories: [item],
    });
    await this.client.awaitIndexed(res.ids, LIMITS.indexMaxAttempts, LIMITS.indexIntervalMs, {
      database: this.identity.database,
      collection: targetCollection,
    });
    this.trackTokens(atomic);
    this.rememberVersion(targetCollection, factKey, versionId, validFrom, atomic, item.additional_metadata!);
    if (current && !isExtension && !(this.client as { atomicVersioning?: boolean }).atomicVersioning) {
      await this.closeFactVersion(current, validFrom, "superseded", targetCollection);
    }
    return this.ingestReceipt(true, "memory", {
      ids: res.ids,
      requestId: res.requestId,
      factKey,
      versionId,
    });
  }

  async forget(opts: { factId?: string; query?: string }): Promise<Receipt> {
    await this.ensureReady();
    this.limiter.acquire("query");
    const key = opts.factId ? generateTopicKey("", opts.factId) : undefined;
    if (!key && !opts.query) throw new Error("factId or query is required");

    const result = await retrieve(this.client, {
      database: this.identity.database,
      collection: this.identity.collection,
      query: key ?? opts.query ?? "",
      mode: "fast",
      type: "memory",
      maxResults: 20,
    });

    // Destroying a topic from a vague query is the one unrecoverable-feeling
    // action here, so the bar is high: the match must be strong (0.6, not 0.35)
    // AND the query's own words must actually appear in the matched text. A
    // weak top hit must never take an unrelated chain with it.
    const MIN_FORGET_SCORE = 0.6;
    const now = new Date().toISOString();
    const live = result.chunks.filter((c) => {
      const md = (c.metadata ?? {}) as Record<string, unknown>;
      return md.status !== "forgotten" && md.status !== "superseded";
    });
    const best = live[0];
    const bestText = (best?.text ?? best?.content ?? "").toLowerCase();
    const queryTokens = key
      ? []
      : [...new Set(
          (opts.query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4),
        )];
    const querySubstantiated =
      !!best && (queryTokens.length === 0 || queryTokens.some((w) => bestText.includes(w)));

    if (!key && (!best || (best.score ?? 0) < MIN_FORGET_SCORE || !querySubstantiated)) {
      return {
        op: "forget",
        sources: [],
        mode_used: "fast",
        request_id: result.requestId,
        token_cost: 0,
        abstained: true,
        abstention_reason: "low_confidence",
        summary: best
          ? `No confident match for that query (best score ${(best.score ?? 0).toFixed(2)}); nothing forgotten.`
          : "No match for that query; nothing forgotten.",
      };
    }

    // Only close the topic of the matched version — never every live version
    // that happens to share the collection.
    let targets: typeof live;
    if (key) {
      targets = live.filter((c) => (c.metadata as Record<string, unknown> | undefined)?.fact_key === key);
    } else {
      const bestKey = best
        ? String((best.metadata as Record<string, unknown> | undefined)?.fact_key ?? best.id)
        : undefined;
      if (!bestKey) {
        return {
          op: "forget",
          sources: [],
          mode_used: "fast",
          request_id: result.requestId,
          token_cost: 0,
          abstained: true,
          abstention_reason: "low_confidence",
          summary: "No topic identified for that query; nothing forgotten.",
        };
      }
      targets = live.filter(
        (c) => String((c.metadata as Record<string, unknown> | undefined)?.fact_key ?? c.id) === bestKey,
      );
    }

    // Deletes are writes: charge them against the write budget up front, then
    // close each version without re-checking (so a partial forget cannot throw
    // midway), matching how remember() closes a superseded version.
    if (targets.length) this.limiter.acquire("write", targets.length);

    let closed = 0;
    for (const c of targets) {
      const md = (c.metadata ?? {}) as Record<string, unknown>;
      const factKey = String(md.fact_key ?? c.id);
      const versionId = String(md.version_id ?? c.id);
      await this.closeFactVersion(
        { versionId, factKey, text: c.text ?? c.content ?? "", metadata: md },
        now,
        "forgotten",
        this.identity.collection,
        false,
      );
      closed++;
    }

    return {
      op: "forget",
      sources: targets.map((c) => this.toSource(c)),
      mode_used: "fast",
      request_id: result.requestId,
      token_cost: 0,
      abstained: closed === 0,
      summary: closed === 0 ? "Nothing to forget." : `Forgot ${closed} version(s).`,
    };
  }

  private async closeFactVersion(
    version: {
      versionId: string;
      factKey: string;
      text?: string;
      metadata?: Record<string, unknown>;
    },
    closedAt: string,
    status: "superseded" | "forgotten" = "superseded",
    collection: string = this.identity.collection,
    chargeWrite = true,
  ): Promise<void> {
    let text = version.text ?? "";
    let metadata = version.metadata ?? {};

    if (!text) {
      const result = await retrieve(this.client, {
        database: this.identity.database,
        collection,
        query: version.factKey,
        mode: "fast",
        type: "memory",
        maxResults: 10,
      });
      const oldVersion = result.chunks.find((c) => {
        const md = c.metadata as Record<string, unknown> | undefined;
        return md?.version_id === version.versionId || c.id === version.versionId;
      });
      if (!oldVersion) return;
      text = oldVersion.text ?? oldVersion.content ?? "";
      metadata = (oldVersion.metadata ?? {}) as Record<string, unknown>;
    }

    const closedItem: MemoryItem = {
      id: version.versionId,
      text,
      infer: false,
      additional_metadata: {
        ...metadata,
        fact_key: version.factKey,
        version_id: version.versionId,
        valid_to: closedAt,
        status,
      },
    };

    // Internal follow-up write of an already-gated operation: counted, not
    // re-checked, so closing a version can never throw mid-operation. Callers
    // that close many versions at once pre-charge the limiter and pass false.
    if (chargeWrite) this.limiter.consume("write");
    const res = await this.client.ingestMemory({
      database: this.identity.database,
      collection,
      memories: [closedItem],
    });
    // Wait for the closure to land like the new version does, so a concurrent
    // recall cannot observe two live versions of the same topic.
    await this.client.awaitIndexed(res.ids, LIMITS.indexMaxAttempts, LIMITS.indexIntervalMs, {
      database: this.identity.database,
      collection,
    });
  }

  async learn(content: string, sourceRef?: string): Promise<Receipt> {
    await this.ensureReady();
    const body = content.trim();
    if (!body) throw new Error("content is required");
    assertMaxLength("content", body, LIMITS.maxContentChars);
    if (sourceRef) assertMaxLength("sourceRef", sourceRef, LIMITS.maxSourceRefChars);
    this.limiter.acquire("write");
    this.limiter.acquire("ingest_tokens", countTokens(body));

    const doc = {
      content: { text: body },
      additional_metadata: {
        source_ref: sourceRef,
        timestamp: new Date().toISOString(),
        trust: "verbatim_source",
      },
      url: sourceRef,
    };

    const res = await this.client.ingestKnowledge({
      database: this.identity.database,
      collection: this.identity.collection,
      documents: [doc],
    });
    await this.client.awaitIndexed(res.ids, LIMITS.indexMaxAttempts, LIMITS.indexIntervalMs, {
      database: this.identity.database,
      collection: this.identity.collection,
    });
    this.trackTokens(body);
    return this.ingestReceipt(true, "knowledge", { ids: res.ids, requestId: res.requestId });
  }

  async recall(opts: RecallOpts = {}): Promise<Receipt> {
    await this.ensureReady();
    this.limiter.acquire("query");
    if (opts.query) assertMaxLength("query", opts.query, LIMITS.maxQueryChars);

    await this.loadCorpusStats();

    const plan = classifyAndPlan(opts.query ?? "", {
      asOf: opts.asOf,
      mode: opts.mode,
      type: opts.type,
    });

    const maxResults = clampInt(opts.maxResults, 15, 1, LIMITS.maxResults);
    const measuredHaystack = this.corpusTokens >= 1_000 ? this.corpusTokens : undefined;
    const maxTokens = resolveContextBudget(opts.maxTokens, measuredHaystack);

    // Filter historical candidates in the store before applying the result
    // limit. Otherwise newer versions can crowd a valid old version out of a
    // small top-k window. A separate existence probe below distinguishes an
    // empty historical window from a topic that was never stored at all.
    const result = await retrieve(this.client, {
      database: this.identity.database,
      collection: this.identity.collection,
      // Snapshot mode lists what is recent instead of searching: an empty store
      // query returns the newest rows, where a keyword net silently misses
      // memories that do not happen to contain the magic vocabulary.
      query: opts.snapshot ? "" : plan.query,
      mode: plan.mode,
      type: plan.type,
      maxResults,
      asOf: plan.asOf,
      includeSuperseded: !!plan.asOf,
    });

    const unavailable = result.unavailable || !!result.error;

    const liveChunks = result.chunks.filter((c) => {
      const md = c.metadata as Record<string, unknown> | undefined;
      if (md?.status === "forgotten") return false;
      return md?.memory_type !== CORPUS_STATS_TYPE;
    });

    const effective = plan.asOf
      ? filterByAsOf(liveChunks, plan.asOf)
      : resolveCurrentVersions(liveChunks);

    // History exists, but none of it was valid at that time. Abstain with
    // outside_time_window instead of answering from a different era.
    let outsideWindow = false;
    if (plan.asOf && effective.length === 0 && !unavailable) {
      const historyProbe = await retrieve(this.client, {
        database: this.identity.database,
        collection: this.identity.collection,
        query: plan.query,
        mode: "fast",
        type: plan.type,
        maxResults: 15,
        includeSuperseded: true,
      });
      outsideWindow = historyProbe.chunks.some((c) =>
        (c.metadata as Record<string, unknown> | undefined)?.memory_type !== CORPUS_STATS_TYPE);
    }

    const disputes = detectDisputes(effective);

    const assembled = assembleEvidence(effective, {
      maxTokens,
      chronological: plan.requireChronology,
      preferCompact: true,
      preferCurrent: !plan.asOf && !plan.requireChronology,
    });

    const abstention = determineAbstention(effective, {
      asOf: plan.asOf,
      unavailable,
      query: opts.query,
      minScore: opts.snapshot ? 0 : undefined,
      minRelevance:
        opts.snapshot ? 0
          : opts.minRelevance
            ?? (plan.requireChronology ? MIN_LEXICAL_RELEVANCE_AGGREGATE : undefined),
      abstainOnAmbiguity:
        opts.abstainOnAmbiguity ?? process.env.LOREX_ABSTAIN_ON_AMBIGUITY === "1",
    });

    // An absent value at that time is a temporal answer, not a generic miss.
    if (outsideWindow) {
      abstention.abstained = true;
      abstention.reason = "outside_time_window";
    }

    // Cite-or-abstain verification: lexical gates can pass on shared
    // vocabulary alone; this checks that the pack actually entails an answer.
    if (!abstention.abstained) {
      const verdict = verifyPackSupport(opts.query ?? "", assembled.evidence, {
        tier: opts.verify ?? "auto",
      });
      if (!verdict.supported) {
        abstention.abstained = true;
        abstention.reason = "unsupported_claim";
      } else if (verdict.tier === "answer_type" && (opts.verify ?? "auto") === "llm") {
        const cfg = resolveSynthesisConfig();
        if (cfg) {
          const llmOk = await llmVerifySupport(opts.query!, assembled.evidence, cfg);
          if (llmOk === false) {
            abstention.abstained = true;
            abstention.reason = "unsupported_claim";
          }
        }
      }
    }

    const compression = computeCompression(assembled.totalTokens, measuredHaystack);

    let answer = abstention.abstained
      ? undefined
      : plan.requireChronology
        ? synthesizeTimeline(assembled.evidence)
        : synthesizeAnswer(assembled.evidence, opts.query);

    let synthesis: import("./domain/receipts.js").SynthesisInfo | undefined;
    if (opts.synthesize && !abstention.abstained && opts.query) {
      const cfg = resolveSynthesisConfig();
      if (cfg) {
        try {
          this.limiter.acquire("synth");
          const s = await synthesizeGroundedAnswer(opts.query, assembled.evidence, cfg);
          answer = s.answer;
          synthesis = {
            model: s.model,
            cited_sources: s.citedIds,
            dropped_claims: s.droppedClaims,
          };
        } catch (e) {
          if (e instanceof RateLimitError) throw e;
          // Deterministic answer stays; synthesis is best-effort by design.
        }
      }
    }

    const packLine = abstention.abstained
      ? `Abstained (${abstention.reason}): ${getAbstentionMessage(abstention.reason)}`
      : compression.haystack_measured
        ? `Retrieved ${assembled.evidence.length} sources · ${assembled.totalTokens} tokens (${compression.context_pct}% of ${compression.haystack_tokens.toLocaleString()}-token history, ${compression.compression_ratio}× smaller)`
        : `Retrieved ${assembled.evidence.length} sources · ${assembled.totalTokens} tokens`;

    return {
      op: "recall",
      sources: assembled.evidence.map((e) => this.evidenceToSource(e)),
      mode_used: plan.mode,
      request_id: result.requestId,
      token_cost: assembled.totalTokens,
      abstained: abstention.abstained,
      abstention_reason: abstention.reason,
      confidence: abstention.confidence,
      relevance: abstention.relevanceScore,
      unavailable,
      as_of: plan.asOf,
      summary: disputes.length
        ? `${packLine} ⚠ ${disputes.length} disputed topic(s): ${disputes.map((d) => d.factKey).join(", ")}`
        : packLine,
      answer,
      disputes: disputes.length ? disputes : undefined,
      context: assembled.evidence.map((e) => `[${e.id}] ${e.excerpt}`).join("\n"),
      compression,
      synthesis,
      result: synthesis ? { synthesis } : undefined,
    };
  }

  async history(opts: { factId?: string; query?: string; maxResults?: number }): Promise<Receipt> {
    await this.ensureReady();
    this.limiter.acquire("query");
    const factKey = opts.factId ? generateTopicKey("", opts.factId) : undefined;
    const q = factKey ?? opts.query ?? "";
    if (!q) throw new Error("factId or query is required");

    const result = await retrieve(this.client, {
      database: this.identity.database,
      collection: this.identity.collection,
      query: q,
      mode: "fast",
      type: "memory",
      maxResults: clampInt(opts.maxResults, 100, 1, LIMITS.maxResults),
      includeSuperseded: true,
    });

    const matchVersion = (c: QueryChunk): boolean => {
      if (!factKey) return true;
      const md = c.metadata as Record<string, unknown> | undefined;
      const fk = String(md?.fact_key ?? "").toLowerCase();
      const id = c.id.toLowerCase();
      const key = factKey.toLowerCase();
      return fk === key || id === key || id.startsWith(key + "_");
    };

    let matched = result.chunks.filter(matchVersion);
    if (factKey && matched.length === 0) {
      const retry = await retrieve(this.client, {
        database: this.identity.database,
        collection: this.identity.collection,
        query: factKey,
        mode: "fast",
        type: "all",
        maxResults: 100,
        includeSuperseded: true,
      });
      matched = retry.chunks.filter(matchVersion);
    }

    const versions = matched
      .map((c) => this.toSource(c))
      .sort((a, b) => {
        const aTime = new Date(a.valid_from ?? 0).getTime();
        const bTime = new Date(b.valid_from ?? 0).getTime();
        return aTime - bTime;
      });

    const conflicts = detectSupersessionConflicts(matched);
    const abstained = versions.length === 0;
    const conflictNote = conflicts.length > 0 ? ` ⚠ ${conflicts.length} conflicting version(s)` : "";

    return {
      op: "history",
      sources: versions,
      mode_used: "fast",
      request_id: result.requestId,
      token_cost: versions.reduce((sum, s) => sum + countTokens(s.content), 0),
      abstained,
      summary: abstained
        ? "No history found."
        : `Found ${versions.length} versions.${conflictNote}`,
      result: { fact_key: factKey, conflicts },
    };
  }

  async why(opts: { factId?: string; query?: string; maxResults?: number }): Promise<Receipt> {
    await this.ensureReady();
    this.limiter.acquire("query", 2);
    const factKey = opts.factId ? generateTopicKey("", opts.factId) : undefined;
    const q = factKey ?? opts.query ?? "";
    if (!q) throw new Error("factId or query is required");

    const result = await retrieve(this.client, {
      database: this.identity.database,
      collection: this.identity.collection,
      query: q,
      mode: "thinking",
      type: "memory",
      maxResults: clampInt(opts.maxResults, 60, 1, LIMITS.maxResults),
    });

    const versions = result.chunks.filter((c) => {
      const md = (c.metadata ?? {}) as Record<string, unknown>;
      // The corpus-stats marker carries a version_id, so without this it would
      // be rendered as a causal chain of its own.
      if (md.memory_type === CORPUS_STATS_TYPE) return false;
      if (!factKey) return !!md.version_id;
      return String(md.fact_key ?? "").toLowerCase() === factKey.toLowerCase();
    });

    const byKey = new Map<string, QueryChunk[]>();
    for (const c of versions) {
      const md = (c.metadata ?? {}) as Record<string, unknown>;
      const key = String(md.fact_key ?? c.id);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(c);
    }

    const chains: CausalChain[] = [];
    for (const [key, chunks] of byKey) {
      const links: CausalLink[] = chunks
        .map((c) => {
          const md = (c.metadata ?? {}) as Record<string, unknown>;
          return {
            versionId: String(md.version_id ?? c.id),
            supersedesVersionId: md.supersedes ? String(md.supersedes) : undefined,
            reason: md.reason ? String(md.reason) : undefined,
            reasonSource: (md.reason_source as CausalSource) ?? "unknown",
            at: String(md.valid_from ?? md.timestamp ?? ""),
            fromValue: md.from_value ? String(md.from_value) : undefined,
            toValue: md.to_value ? String(md.to_value) : (c.text ?? c.content ?? undefined),
          } satisfies CausalLink;
        })
        .sort((a, b) => Date.parse(a.at || "0") - Date.parse(b.at || "0"));

      if (links.length === 0) continue;
      chains.push({ factKey: key, links, hasReasons: links.some((l) => !!l.reason) });
    }

    chains.sort((a, b) => b.links.length - a.links.length);

    const abstained = chains.length === 0;
    const narrative = chains
      .map((c) => `### ${c.factKey}\n${renderCausalChain(c)}`)
      .join("\n\n");

    const changed = chains.filter((c) => c.links.length > 1).length;
    const explained = chains.filter((c) => c.hasReasons).length;

    return {
      op: "why",
      sources: versions.map((c) => this.toSource(c)),
      mode_used: "thinking",
      request_id: result.requestId,
      token_cost: countTokens(narrative),
      abstained,
      abstention_reason: abstained ? "no_evidence" : undefined,
      summary: abstained
        ? "No causal history found for that topic."
        : `${chains.length} topic(s), ${changed} with recorded changes, ${explained} with a stated reason.`,
      answer: abstained ? undefined : narrative,
      context: narrative,
      result: { chains },
    };
  }

  async graph(opts: { query?: string; maxResults?: number } = {}): Promise<{
    graph: ContextGraph;
    requestId: string;
  }> {
    await this.ensureReady();
    this.limiter.acquire("query", 3);

    const sweep = await retrieve(this.client, {
      database: this.identity.database,
      collection: this.identity.collection,
      query: opts.query || "project decisions preferences constraints status handoff next step",
      mode: "thinking",
      type: "all",
      maxResults: clampInt(opts.maxResults, 50, 1, 50),
    });

    let packIds: Set<string> | undefined;
    if (opts.query) {
      const receipt = await this.recall({ query: opts.query, mode: "thinking" });
      packIds = new Set(receipt.sources.map((src) => src.id));
    }

    const relations = await this.client.contextRelations(
      { database: this.identity.database, collection: this.identity.collection },
      sweep.chunks.map((c) => c.id).slice(0, 100),
    );

    const sources = sweep.chunks
      .filter(
        (c) =>
          (c.metadata as Record<string, unknown> | undefined)?.memory_type !== CORPUS_STATS_TYPE,
      )
      .map((c) => {
        const src = this.toSource(c);
        return { ...src, corpus: src.corpus as string };
      });

    return {
      graph: buildContextGraph(sources, {
        graphContext: sweep.graphContext as HydraGraphContext | undefined,
        relations: relations as HydraRelationSlice,
        packIds,
        query: opts.query,
      }),
      requestId: sweep.requestId,
    };
  }

  async list(opts: { type?: "memory" | "knowledge" | "all"; maxResults?: number }): Promise<Receipt> {
    await this.ensureReady();
    this.limiter.acquire("query");
    const result = await retrieve(this.client, {
      database: this.identity.database,
      collection: this.identity.collection,
      // Empty query = the store's recency listing; a keyword net would only
      // list memories that happen to contain those words.
      query: "",
      mode: "fast",
      type: opts.type ?? "all",
      maxResults: clampInt(opts.maxResults, 50, 1, LIMITS.maxResults),
      recencyBias: 0.5,
    });

    const sources = result.chunks
      .filter((c) => {
        const md = c.metadata as Record<string, unknown> | undefined;
        return md?.status !== "forgotten" && md?.memory_type !== CORPUS_STATS_TYPE;
      })
      .map((c) => this.toSource(c));

    return {
      op: "list",
      sources,
      mode_used: "fast",
      request_id: result.requestId,
      token_cost: sources.reduce((sum, s) => sum + countTokens(s.content), 0),
      abstained: sources.length === 0,
      summary: sources.length === 0
        ? "Nothing stored yet."
        : `Found ${sources.length} items (snapshot, not full dump).`,
    };
  }

  async handoff(input: {
    decision: string;
    nextStep?: string;
    sessionId?: string;
    agent?: string;
  }): Promise<Receipt> {
    await this.ensureReady();
    const decision = input.decision.trim();
    if (!decision) throw new Error("decision is required");
    assertMaxLength("decision", decision, LIMITS.maxFactChars);
    if (input.nextStep) assertMaxLength("nextStep", input.nextStep, LIMITS.maxFactChars);

    const agent = input.agent?.trim() || this.agent;
    const at = new Date().toISOString();
    const body = input.nextStep
      ? `${decision}\nNext step: ${input.nextStep}`
      : decision;
    this.limiter.acquire("write");
    this.limiter.acquire("ingest_tokens", countTokens(body));

    const versionId = `handoff_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const item: MemoryItem = {
      id: versionId,
      text: body,
      infer: true,
      additional_metadata: {
        schema_version: METADATA_SCHEMA_VERSION,
        fact_key: "project_handoff",
        version_id: versionId,
        memory_type: "handoff",
        valid_from: at,
        timestamp: at,
        recorded_at: at,
        status: "current",
        trust: "agent_explicit",
        agent,
        decision,
        next_step: input.nextStep,
        source_ref: input.sessionId,
      },
    };

    const res = await this.client.ingestMemory({
      database: this.identity.database,
      collection: this.identity.collection,
      memories: [item],
    });
    await this.client.awaitIndexed(res.ids, LIMITS.indexMaxAttempts, LIMITS.indexIntervalMs, {
      database: this.identity.database,
      collection: this.identity.collection,
    });
    this.trackTokens(body);
    return {
      op: "ingest",
      sources: [],
      mode_used: "fast",
      request_id: res.requestId,
      token_cost: countTokens(body),
      abstained: false,
      result: { version_id: versionId, agent, next_step: input.nextStep },
      summary: `Handoff recorded by ${agent}${input.nextStep ? ` · next: ${input.nextStep}` : ""}`,
    };
  }

  async resume(): Promise<Receipt> {
    const r = await this.recall({
      query: "current project decisions preferences constraints status architecture next step handoff",
      mode: "thinking",
      type: "memory",
      maxResults: 25,
      maxTokens: LIMITS.defaultContextTokens,
      snapshot: true,
    });

    const handoffs = r.sources
      .filter((s) => s.memory_type === "handoff")
      .sort((a, b) => Date.parse(b.valid_from ?? "0") - Date.parse(a.valid_from ?? "0"));

    const agents = [...new Set(r.sources.map((s) => s.agent).filter(Boolean))] as string[];
    const others = agents.filter((a) => a !== this.agent);

    const where = this.identity.workspace
      ? `workspace "${this.identity.workspace}"`
      : `project "${this.identity.collectionLabel}"`;

    if (r.abstained) {
      r.summary = `Resuming ${where} with an empty profile.`;
      return r;
    }

    const latest = handoffs[0];
    const lines = [`Resuming ${where} as ${this.agent}.`];
    if (others.length) {
      lines.push(`Also worked on by: ${others.join(", ")}.`);
    }
    if (latest) {
      const who = latest.agent ?? "another agent";
      const when = latest.valid_from?.slice(0, 10) ?? "earlier";
      lines.push(`Last handoff (${who}, ${when}): ${latest.excerpt}`);
    }
    lines.push(r.summary);

    r.summary = lines.join(" ");
    r.result = {
      ...(r.result as Record<string, unknown> | undefined),
      agent: this.agent,
      workspace: this.identity.workspace,
      contributing_agents: agents,
      handoffs: handoffs.slice(0, 5),
    };
    return r;
  }

  /**
   * Session-start context pack: recall, then format the sources as a small,
   * typed, budgeted block of text a harness can inject. Deterministic — no
   * model, no network. With no query it behaves like `resume` but emits the
   * grouped pack instead of a summary line.
   */
  async contextPack(opts: ContextPackOpts = {}): Promise<Receipt> {
    await this.ensureReady();
    if (opts.query) assertMaxLength("query", opts.query, LIMITS.maxQueryChars);

    const hasQuery = !!opts.query?.trim();
    const snapshot = opts.snapshot ?? !hasQuery;
    const query = opts.query?.trim() || DEFAULT_PACK_QUERY;

    const receipt = await this.recall({
      query,
      mode: opts.mode ?? "thinking",
      type: opts.type ?? "all",
      maxResults: clampInt(opts.maxResults, 25, 1, LIMITS.maxResults),
      maxTokens: opts.maxTokens,
      snapshot,
    });

    const agents = [...new Set(receipt.sources.map((s) => s.agent).filter(Boolean))];
    const header = agents.length
      ? `Contributing agents: ${agents.join(", ")}`
      : undefined;

    const built = buildContextPack({
      label: this.identity.collectionLabel,
      query: hasQuery ? query : undefined,
      header,
      sources: receipt.sources,
      maxTokens: opts.maxTokens ?? LIMITS.defaultContextTokens,
    });

    return {
      op: "context",
      sources: built.usedSources,
      mode_used: receipt.mode_used,
      request_id: receipt.request_id,
      token_cost: built.tokens,
      abstained: receipt.abstained,
      abstention_reason: receipt.abstention_reason,
      summary: built.text
        ? `Context pack: ${built.memoryCount} memories` +
          (built.knowledgeCount ? ` + ${built.knowledgeCount} reference` : "") +
          ` · ${built.tokens} tokens${built.truncated ? " (truncated)" : ""}`
        : receipt.summary,
      answer: built.text || undefined,
      context: built.text,
      result: {
        sections: built.sections,
        truncated: built.truncated,
        memory_count: built.memoryCount,
        knowledge_count: built.knowledgeCount,
        query: hasQuery ? query : undefined,
        contributing_agents: agents,
      },
    };
  }

  // ── Spaces ────────────────────────────────────────────────────────────────

  /** Friendly names over collections; null when the backend has no spaces (mock). */
  async listSpaces(): Promise<SpaceRow[] | null> {
    if (typeof this.client.listSpaces !== "function") return null;
    return this.client.listSpaces();
  }

  /** Create or claim a user-named space (`ws_<slug>` collection). */
  async createSpace(name: string, description = ""): Promise<{ id: string } | null> {
    if (typeof this.client.upsertSpace !== "function") return null;
    const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) throw new Error("space name must contain at least one letter or digit");
    const id = `ws_${slug}`;
    await this.client.upsertSpace({ id, name, description, source: "user" });
    return { id };
  }

  async updateSpace(
    id: string,
    patch: { name?: string; description?: string; archived?: boolean },
  ): Promise<boolean> {
    if (typeof this.client.patchSpace !== "function") return false;
    return this.client.patchSpace(id, patch);
  }

  /** Register this engine's own collection as a space (auto-named until confirmed). */
  async ensureSpace(): Promise<void> {
    if (typeof this.client.upsertSpace !== "function") return;
    await this.client.upsertSpace({
      id: this.identity.collection,
      name: spaceLabel(this.identity.collection),
      source: "auto",
    });
  }

  private get lifecycleStore(): SqliteStore | null {
    const c = this.client as Partial<SqliteStore>;
    return typeof c.getConsolidationCandidates === "function" ? (c as SqliteStore) : null;
  }

  private async persistDreamDiscoveries(discoveries: DreamMemory[]): Promise<number> {
    if (!discoveries.length) return 0;
    this.limiter.acquire("write");
    const now = new Date().toISOString();
    await this.client.ingestMemory({
      database: this.identity.database,
      collection: this.identity.collection,
      memories: discoveries.map((d) => ({
        // Stable id makes repeated Dream runs update one inference instead of
        // accumulating duplicate current memories for the same pattern.
        id: `dream_${d.factKey}`,
        text: d.text,
        relations: d.sourceIds.length
          ? { ids: d.sourceIds.slice(0, 10), properties: { type: "derives" } }
          : undefined,
        additional_metadata: {
          schema_version: METADATA_SCHEMA_VERSION,
          fact_key: d.factKey,
          memory_type: d.memoryType,
          valid_from: now,
          status: "current",
          agent: this.agent,
          confidence: d.confidence,
          extraction_confidence: d.confidence,
          evidence_ids: d.sourceIds,
          trust: "inferred_pattern",
          source: `dream:${d.source}`,
        },
      })),
    });
    return discoveries.length;
  }

  /** Run heuristic Dream; confident patterns apply, uncertain derivations queue. */
  async dream(opts: DreamOptions = {}): Promise<DreamResult & { persisted: number; queued: number }> {
    await this.ensureReady();
    const result = await dreamHeuristic(this.client, this.identity.collection, opts);
    const store = this.lifecycleStore;
    const automatic = store
      ? result.discovered.filter((d) => d.confidence >= DREAM_AUTO_APPLY_CONFIDENCE)
      : result.discovered;
    const needsReview = store
      ? result.discovered.filter((d) => d.confidence < DREAM_AUTO_APPLY_CONFIDENCE)
      : [];
    const persisted = await this.persistDreamDiscoveries(automatic);
    let queued = 0;
    for (const discovery of needsReview) {
      if (store!.enqueueReview({
        id: `dream_${this.identity.collection}_${discovery.factKey}`,
        collection: this.identity.collection,
        kind: "dream",
        payload: { ...discovery },
        confidence: discovery.confidence,
      })) queued++;
    }

    for (const id of result.reinforced) {
      this.lifecycleStore?.recordAccess(id);
    }

    // Record the run so the auto-trigger can tell how much new material exists.
    this.lifecycleStore?.saveProfile(this.identity.collection, DREAM_PROFILE_KIND, {
      lastDreamAt: new Date().toISOString(),
      discovered: result.discovered.length,
      persisted,
      queued,
    });

    return { ...result, persisted, queued };
  }

  async reviews(): Promise<ReviewRow[]> {
    await this.ensureReady();
    return this.lifecycleStore?.listReviews(this.identity.collection) ?? [];
  }

  async resolveReview(id: string, decision: "approve" | "decline"): Promise<{ resolved: boolean; decision: string }> {
    await this.ensureReady();
    const store = this.lifecycleStore;
    if (!store) return { resolved: false, decision };
    const review = store.getReview(this.identity.collection, id);
    if (!review || review.status !== "pending") return { resolved: false, decision };
    if (decision === "approve") {
      const discovery = review.payload as unknown as DreamMemory;
      await this.persistDreamDiscoveries([discovery]);
    }
    return { resolved: store.resolveReview(this.identity.collection, id, decision === "approve" ? "approved" : "declined"), decision };
  }

  /** When Dream last ran, and how much new material has arrived since. */
  async dreamStatus(): Promise<{ lastDreamAt?: string; sessionsSince: number; shouldRun: boolean; reason: string }> {
    await this.ensureReady();
    const store = this.lifecycleStore;
    if (!store) {
      return { sessionsSince: 0, shouldRun: false, reason: "Dream needs the local SQLite backend" };
    }
    const saved = store.getProfile(this.identity.collection, DREAM_PROFILE_KIND);
    const lastDreamAt = (saved?.body as { lastDreamAt?: string } | undefined)?.lastDreamAt;
    const sessionsSince = store.countSessionsSince(this.identity.collection, lastDreamAt ?? null);
    const shouldRun = shouldDream(lastDreamAt ?? null, sessionsSince, false);
    const reason = shouldRun
      ? `${sessionsSince} session(s) of new material`
      : sessionsSince < DREAM_GATE_SESSIONS
        ? `only ${sessionsSince} session(s) since the last Dream (needs ${DREAM_GATE_SESSIONS})`
        : "the last Dream ran under 24h ago";
    return { lastDreamAt, sessionsSince, shouldRun, reason };
  }

  /**
   * Dream only when its gates pass. Safe to call on every session end: it is a
   * no-op most of the time, which is the point — background mining should not
   * run per session.
   */
  async dreamAuto(opts: DreamOptions = {}): Promise<
    { ran: true; result: DreamResult & { persisted: number; queued: number } } | { ran: false; reason: string }
  > {
    const status = await this.dreamStatus();
    if (!status.shouldRun) return { ran: false, reason: status.reason };
    return { ran: true, result: await this.dream(opts) };
  }

  /**
   * Memory-quality report. `doctor` answers "is it working"; this answers "is
   * what is in there any good" — duplicates, unsplit topics, staleness,
   * contradictions, and memories that have never been recalled. Read-only: it
   * never mutates, so it is safe to run at any time.
   */
  async reflect(): Promise<ReflectReport> {
    await this.ensureReady();
    this.limiter.acquire("query");
    const store = this.lifecycleStore;
    const collection = this.identity.collection;
    // A diagnostic must not throw. With the in-memory backend there are no
    // lifecycle columns to measure, so say so and report nothing rather than
    // fabricating a clean bill of health.
    if (!store) {
      return {
        available: false,
        collection,
        total: 0,
        byType: {},
        stale: 0,
        expired: 0,
        duplicateTextClusters: 0,
        duplicateTextRows: 0,
        multiCurrentTopics: [],
        contradictions: 0,
        neverRecalled: 0,
        recallGaps: [],
        healthy: true,
        findings: [],
      };
    }
    const stats = store.getLifecycleStats(collection);
    const candidates = store.getConsolidationCandidates(collection);
    const recallGaps = store.getQueryFailures(10).filter((g) => g.fails >= 3);
    const plan = planConsolidation(candidates);

    const byKey = new Map<string, number>();
    for (const c of candidates) byKey.set(c.factKey, (byKey.get(c.factKey) ?? 0) + 1);
    const multiCurrentTopics = [...byKey.entries()]
      .filter(([, n]) => n > 1)
      .map(([factKey, versions]) => ({ factKey, versions }))
      .sort((a, b) => b.versions - a.versions)
      .slice(0, 10);

    const byText = new Map<string, number>();
    for (const c of candidates) {
      const key = c.text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
      byText.set(key, (byText.get(key) ?? 0) + 1);
    }
    const dupCounts = [...byText.values()].filter((n) => n > 1);

    let contradictions = 0;
    const corrections = new Map<string, number>();
    for (const c of candidates) {
      if (c.memoryType !== "correction") continue;
      corrections.set(c.factKey, (corrections.get(c.factKey) ?? 0) + 1);
    }
    for (const n of corrections.values()) if (n > 1) contradictions++;

    const neverRecalled = candidates.filter((c) => (c.accessCount ?? 0) === 0).length;

    const findings: string[] = [];
    if (multiCurrentTopics.length) {
      findings.push(
        `${multiCurrentTopics.length} topic(s) have more than one current version — supersession did not close the old one`,
      );
    }
    if (dupCounts.length) {
      findings.push(
        `${dupCounts.reduce((s, n) => s + n, 0)} rows across ${dupCounts.length} exact-duplicate text cluster(s)`,
      );
    }
    if (contradictions) findings.push(`${contradictions} topic(s) carry competing corrections`);
    if (stats.staleCount) findings.push(`${stats.staleCount} memory(ies) are stale (strength < 0.15)`);
    if (stats.expiredCount) findings.push(`${stats.expiredCount} memory(ies) have an elapsed validity window`);
    if (plan.merged.length) {
      findings.push(`${plan.merged.length} near-duplicate topic pair(s) could merge — run \`lorex consolidate --prune\``);
    }
    if (recallGaps.length) {
      findings.push(`${recallGaps.length} query pattern(s) failed 3+ times — memory may be thin there`);
    }
    if (neverRecalled > 5 && stats.total > 10) {
      findings.push(`${neverRecalled}/${stats.total} memories have never been recalled — possibly noise`);
    }

    return {
      available: true,
      collection,
      total: stats.total,
      byType: stats.byType,
      stale: stats.staleCount,
      expired: stats.expiredCount,
      duplicateTextClusters: dupCounts.length,
      duplicateTextRows: dupCounts.reduce((s, n) => s + n, 0),
      multiCurrentTopics,
      contradictions,
      neverRecalled,
      recallGaps,
      healthy: findings.length === 0,
      findings,
    };
  }

  /** Plan consolidation; auto-applies expired TTL entries, reports the rest. */
  async consolidate(applyPruned = false): Promise<{ planned: number; pruned: number; expired: number; merged: number }> {
    await this.ensureReady();
    const store = this.lifecycleStore;
    if (!store) return { planned: 0, pruned: 0, expired: 0, merged: 0 };

    const candidates = store.getConsolidationCandidates(this.identity.collection);
    const plan = planConsolidation(candidates);
    const resolved = store.resolveContradictions(this.identity.collection);
    const applied = store.applyConsolidation({
      pruned: applyPruned ? plan.pruned : [],
      merged: applyPruned ? plan.merged : [],
      reinforced: [],
      expired: plan.expired,
    });

    return { planned: plan.pruned.length + plan.expired.length + plan.merged.length + resolved, pruned: applied.pruned, expired: applied.expired, merged: applyPruned ? plan.merged.length : 0 };
  }

  /** Unfinished work: tasks recorded but never acted on. */
  async openLoops(): Promise<Array<{ id: string; text: string; created_at: string; age_days: number }>> {
    await this.ensureReady();
    const store = this.lifecycleStore;
    return store ? store.getOpenLoops(this.identity.collection) : [];
  }

  /** Standing state, maintained not queried. Refreshes when stale (>1h) or forced. */
  async profile(kind: "user" | "project" = "project", refresh = false): Promise<ProfileSnapshot | null> {
    await this.ensureReady();
    const store = this.lifecycleStore;
    if (!store) return null;

    if (!refresh) {
      const cached = store.getProfile(this.identity.collection, kind);
      // SQLite datetime('now') has no TZ designator and is always UTC.
      const at = cached ? Date.parse(cached.updated_at.includes("T") ? cached.updated_at : `${cached.updated_at}Z`) : NaN;
      if (cached && !Number.isNaN(at) && Date.now() - at < 3_600_000) {
        return { ...(cached.body as unknown as ProfileSnapshot), cached: true };
      }
    }
    return this.refreshProfile(kind);
  }

  async refreshProfile(kind: "user" | "project" = "project"): Promise<ProfileSnapshot | null> {
    await this.ensureReady();
    const store = this.lifecycleStore;
    if (!store) return null;

    const collection = this.identity.collection;
    const prefs = [
      ...store.topByType("global", "preference", 10),
      ...(kind === "user" ? store.topByType(collection, "preference", 10) : []),
    ];
    const decisions = store.topByType(collection, "decision", 10);
    const constraints = store.topByType(collection, "constraint", 10);
    const loops = store.getOpenLoops(collection).slice(0, 10);
    const handoffs = store.topByType(collection, "handoff", 1);

    const snapshot: ProfileSnapshot = {
      collection,
      kind,
      updatedAt: new Date().toISOString(),
      cached: false,
      preferences: prefs.slice(0, 10).map((p) => ({ text: p.text, strength: p.strength })),
      decisions: decisions.map((d) => ({ text: d.text, created_at: d.created_at })),
      constraints: constraints.map((c) => c.text),
      openLoops: loops.map((l) => ({ text: l.text, age_days: l.age_days })),
      lastHandoff: handoffs[0] ? { decision: handoffs[0].text, at: handoffs[0].created_at } : undefined,
    };
    store.saveProfile(collection, kind, snapshot as unknown as Record<string, unknown>);
    return snapshot;
  }

  /** Dump rows for backup or cross-machine sync. Null when backend can't export. */
  async exportData(collection?: string): Promise<Array<Record<string, unknown>> | null> {
    await this.ensureReady();
    const store = this.lifecycleStore;
    return store ? store.exportRows(collection) : null;
  }

  /** Merge a dump. Local rows win unless overwrite is set. */
  async importData(rows: Array<Record<string, unknown>>, overwrite = false): Promise<{ imported: number; skipped: number } | null> {
    await this.ensureReady();
    const store = this.lifecycleStore;
    return store ? store.importRows(rows, overwrite) : null;
  }

  async report(input: {
    requestId: string;
    answer?: string;
    sourceIds?: string[];
    rating?: "positive" | "negative" | "neutral";
    feedback?: string;
    query?: string;
  }): Promise<Receipt> {
    if (!input.requestId?.trim()) throw new Error("requestId is required");
    this.limiter.acquire("write");
    const feedback: FeedbackInput = {
      request_id: input.requestId,
      rating: input.rating,
      source: "agent",
      feedback: input.feedback,
      database: this.identity.database,
      collection: this.identity.collection,
      ground_truth: input.answer ? { answer: input.answer, source_ids: input.sourceIds } : undefined,
      metadata: { agent: "lorex", ...(input.query ? { query: input.query } : {}) },
    };
    await this.client.feedback(feedback);

    return {
      op: "feedback",
      sources: [],
      mode_used: "fast",
      request_id: input.requestId,
      token_cost: 0,
      abstained: false,
      summary: "Feedback recorded.",
    };
  }

  private rememberVersion(
    collection: string,
    factKey: string,
    versionId: string,
    validFrom: string,
    text: string,
    metadata: Record<string, unknown>,
  ): void {
    const indexKey = scopedIndexKey(collection, factKey);
    const held = this.factIndex.get(indexKey);
    if (held && Date.parse(held.validFrom || "0") > Date.parse(validFrom)) return;
    this.factIndex.set(indexKey, { versionId, validFrom, text, metadata });
  }

  private async findCurrentFactVersion(factKey: string, collection: string): Promise<{
    versionId: string;
    factKey: string;
    text?: string;
    metadata?: Record<string, unknown>;
  } | undefined> {
    // Exact lookup first: correct across processes, no FTS involved.
    const store = this.client as Partial<{
      getCurrentByFactKey(collection: string, factKey: string): {
        versionId: string; text: string; metadata: Record<string, unknown>;
      } | null;
    }>;
    if (typeof store.getCurrentByFactKey === "function") {
      const exact = store.getCurrentByFactKey(collection, factKey);
      if (exact) return { versionId: exact.versionId, factKey, text: exact.text, metadata: exact.metadata };
    }
    const result = await retrieve(this.client, {
      database: this.identity.database,
      collection,
      query: factKey,
      mode: "fast",
      type: "memory",
      maxResults: 15,
    });

    const versions = result.chunks
      .filter((c) => {
        const md = c.metadata as Record<string, unknown> | undefined;
        if (!md) return false;
        if (md.fact_key !== factKey) return false;
        if (md.status === "superseded" || md.status === "forgotten") return false;
        // Only an elapsed window disqualifies a version; a future validTo is
        // still the live one.
        if (md.valid_to && Date.parse(String(md.valid_to)) <= Date.now()) return false;
        return true;
      })
      .sort((a, b) => {
        const aTime = new Date(String((a.metadata as Record<string, unknown>)?.valid_from ?? 0)).getTime();
        const bTime = new Date(String((b.metadata as Record<string, unknown>)?.valid_from ?? 0)).getTime();
        return bTime - aTime;
      });

    if (versions.length === 0) return undefined;
    const top = versions[0]!;
    const md = (top.metadata ?? {}) as Record<string, unknown>;
    return {
      versionId: String(md.version_id ?? top.id),
      factKey,
      text: top.text ?? top.content,
      metadata: md,
    };
  }

  private ingestReceipt(
    ok: boolean,
    corpus: "memory" | "knowledge",
    opts: {
      ids?: string[];
      queued?: boolean;
      requestId?: string;
      factKey?: string;
      versionId?: string;
    },
  ): Receipt {
    return {
      op: "ingest",
      sources: [],
      mode_used: "fast",
      request_id: opts.requestId,
      token_cost: 0,
      abstained: false,
      queued: opts.queued,
      result: { fact_key: opts.factKey, version_id: opts.versionId, ids: opts.ids },
      summary: ok
        ? `Ingested ${opts.ids?.length ?? 1} ${corpus} item(s).`
        : opts.queued
          ? `Queued ${corpus} write for retry.`
          : `Failed to ingest ${corpus}.`,
    };
  }

  private toSource(c: QueryChunk): ReceiptSource {
    const md = (c.metadata ?? {}) as Record<string, unknown>;
    return {
      id: c.id,
      corpus: c.corpus ?? "memory",
      excerpt: excerpt(c.text ?? c.content ?? ""),
      content: c.text ?? c.content ?? "",
      score: c.score,
      valid_from: md.valid_from as string | undefined,
      valid_to: md.valid_to as string | undefined,
      source_ref: md.source_ref as string | undefined,
      fact_key: md.fact_key as string | undefined,
      status: md.status as string | undefined,
      agent: md.agent as string | undefined,
      memory_type: md.memory_type as string | undefined,
      reason: md.reason as string | undefined,
      trust: md.trust as string | undefined,
      source_session_id: md.source_session_id as string | undefined,
      root_session_id: md.root_session_id as string | undefined,
      source_event_id: md.source_event_id as string | undefined,
      evidence_ids: md.evidence_ids as string[] | undefined,
    };
  }

  private evidenceToSource(e: import("./domain/evidence.js").Evidence): ReceiptSource {
    return {
      id: e.id,
      corpus: e.corpus,
      excerpt: e.excerpt,
      content: e.content,
      score: e.score,
      valid_from: e.validFrom,
      valid_to: e.validTo,
      source_ref: e.sourceRef,
      fact_key: e.factKey,
      agent: e.agent,
      memory_type: e.memoryType,
      reason: e.reason,
      status: e.status,
      trust: e.trust,
      source_session_id: e.sourceSessionId,
      root_session_id: e.rootSessionId,
      source_event_id: e.sourceEventId,
      evidence_ids: e.evidenceIds,
    };
  }
}

function filterByAsOf(chunks: QueryChunk[], asOf: string): QueryChunk[] {
  const t = Date.parse(asOf);
  if (Number.isNaN(t)) return chunks;
  const filtered = chunks.filter((c) => {
    const md = c.metadata as Record<string, unknown> | undefined;
    const vf = md?.valid_from ? Date.parse(String(md.valid_from)) : undefined;
    const vt = md?.valid_to ? Date.parse(String(md.valid_to)) : undefined;
    if (vf === undefined && vt === undefined) return true;
    if (vf !== undefined && !Number.isNaN(vf) && t < vf) return false;
    if (vt !== undefined && !Number.isNaN(vt) && t >= vt) return false;
    return true;
  });
  return filtered;
}

function resolveCurrentVersions(chunks: QueryChunk[]): QueryChunk[] {
  const newestByKey = new Map<string, number>();

  for (const c of chunks) {
    const md = c.metadata as Record<string, unknown> | undefined;
    const key = md?.fact_key ? String(md.fact_key) : undefined;
    if (!key) continue;
    const at = Date.parse(String(md?.valid_from ?? md?.timestamp ?? ""));
    if (Number.isNaN(at)) continue;
    const held = newestByKey.get(key);
    if (held === undefined || at > held) newestByKey.set(key, at);
  }

  if (newestByKey.size === 0) return chunks;

  return chunks.map((c) => {
    const md = c.metadata as Record<string, unknown> | undefined;
    const key = md?.fact_key ? String(md.fact_key) : undefined;
    if (!key || !md) return c;
    if (md.status === "superseded" || md.status === "forgotten" || md.valid_to) return c;

    const at = Date.parse(String(md.valid_from ?? md.timestamp ?? ""));
    const newest = newestByKey.get(key);
    if (Number.isNaN(at) || newest === undefined || at >= newest) return c;

    return {
      ...c,
      metadata: { ...md, status: "superseded", status_source: "derived" },
    };
  });
}

function detectDisputes(chunks: QueryChunk[]): Array<{ factKey: string; versionIds: string[]; values: string[] }> {
  const live = new Map<string, QueryChunk[]>();
  for (const c of chunks) {
    const md = c.metadata as Record<string, unknown> | undefined;
    if (!md?.fact_key) continue;
    if (md.status === "superseded" || md.status === "forgotten" || md.valid_to) continue;
    const key = String(md.fact_key);
    if (!live.has(key)) live.set(key, []);
    live.get(key)!.push(c);
  }

  const disputes: Array<{ factKey: string; versionIds: string[]; values: string[] }> = [];
  for (const [factKey, versions] of live) {
    if (versions.length < 2) continue;
    const values = [...new Set(versions.map((v) => (v.text ?? v.content ?? "").trim()))];
    if (values.length < 2) continue;
    disputes.push({
      factKey,
      versionIds: versions.map((v) =>
        String((v.metadata as Record<string, unknown> | undefined)?.version_id ?? v.id),
      ),
      values,
    });
  }
  return disputes;
}

function detectSupersessionConflicts(chunks: QueryChunk[]): Array<{ type: string; versionIds: string[] }> {
  const conflicts: Array<{ type: string; versionIds: string[] }> = [];

  const currentVersions = chunks.filter((c) => {
    const md = c.metadata as Record<string, unknown> | undefined;
    // Only versions carrying the full metadata schema participate; chunks
    // without fact_key/version_id are not part of any supersession chain.
    if (!md?.fact_key || !md?.version_id) return false;
    return md.status === "current" || (!md.valid_to && md.status !== "superseded" && md.status !== "forgotten");
  });
  const byKey = new Map<string, string[]>();
  for (const c of currentVersions) {
    const md = c.metadata as Record<string, unknown> | undefined;
    const key = String(md?.fact_key ?? c.id);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(String(md?.version_id ?? c.id));
  }
  for (const [, ids] of byKey) {
    if (ids.length > 1) conflicts.push({ type: "multiple_current", versionIds: ids });
  }

  return conflicts;
}

function getAbstentionMessage(reason?: AbstentionReason): string {
  switch (reason) {
    case "no_evidence":
      return "No relevant evidence found.";
    case "low_confidence":
      return "Evidence found but confidence is too low.";
    case "outside_time_window":
      return "No evidence valid at the requested time.";
    case "unavailable":
      return "Service unavailable.";
    case "contradictory_evidence":
      return "Evidence is contradictory.";
    case "ambiguous_entity":
      return "Multiple equally-relevant results found (ambiguous).";
    case "evidence_not_relevant":
      return "Retrieved text does not appear to answer the query.";
    case "unsupported_claim":
      return "No retrieved source actually contains the requested information.";
    default:
      return "Unable to retrieve a reliable answer.";
  }
}
