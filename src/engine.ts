/** LorexEngine: every memory and context operation, returning a Receipt. */

import type { HydraDBLike, MemoryItem, QueryChunk, FeedbackInput } from "./infrastructure/hydradb-client.js";
import type { Identity } from "./infrastructure/identity.js";
import { WriteQueue } from "./infrastructure/write-queue.js";
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
  renderCausalChain,
  type CausalChain,
  type CausalLink,
  type CausalSource,
} from "./domain/causality.js";
import { retrieve } from "./retrieval/hydradb-retriever.js";
import { assembleEvidence, synthesizeTimeline, synthesizeAnswer } from "./retrieval/evidence-assembler.js";
import { determineAbstention } from "./synthesis/abstention.js";
import { classifyAndPlan } from "./retrieval/planner.js";
import { ingestSession as runSessionIngestion, type FactIndex } from "./ingestion/pipeline.js";
import type { NormalizedSession } from "./domain/session.js";
import { LIMITS, assertMaxLength, clampInt } from "./infrastructure/limits.js";
import { HydraDBError } from "./infrastructure/hydradb-client.js";
import { RateLimiter } from "./infrastructure/rate-limiter.js";
import { computeCompression, resolveContextBudget } from "./domain/compression.js";
import { countTokens } from "./ingestion/token-counter.js";

const CORPUS_STATS_KEY = "lorex_corpus_stats";
const CORPUS_STATS_TYPE = "corpus_stats";

export interface RememberOpts {
  validFrom?: string;
  validTo?: string;
  id?: string;
  sourceRef?: string;
  forget?: boolean;
  ttlSeconds?: number;
  because?: string;
  agent?: string;
}

export interface RecallOpts {
  query?: string;
  asOf?: string;
  mode?: "fast" | "thinking";
  type?: "memory" | "knowledge" | "all";
  maxResults?: number;
  maxTokens?: number;
  snapshot?: boolean;
  minRelevance?: number;
  abstainOnAmbiguity?: boolean;
}

export class LorexEngine {
  readonly queue: WriteQueue;
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
    private readonly client: HydraDBLike,
    private readonly identity: Identity,
    queueCap: number,
    sharedQueue?: WriteQueue,
    sharedLimiter?: RateLimiter,
  ) {
    this.limiter = sharedLimiter ?? new RateLimiter();
    if (sharedQueue) {
      this.queue = sharedQueue;
      return;
    }
    this.queue = new WriteQueue(client, queueCap);
    this.queue.startAutoFlush();
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

  get queueLength(): number {
    return this.queue.length;
  }

  getIdentity(): Identity {
    return this.identity;
  }

  async ingestSession(
    session: NormalizedSession,
    opts: {
      indexWait?: { maxAttempts: number; intervalMs: number } | false;
      maxTokensPerChunk?: number;
    } = {},
  ): Promise<import("./ingestion/pipeline.js").IngestionResult> {
    await this.ensureReady();
    this.limiter.acquire("write");
    const estimatedTokens = session.turns.reduce(
      (sum, t) => sum + countTokens(t.content),
      0,
    );
    this.limiter.acquire("ingest_tokens", estimatedTokens);
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
      0,
      this.queue,
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

    const recordedAt = new Date().toISOString();
    const validFrom = opts.validFrom ?? recordedAt;
    if (Number.isNaN(Date.parse(validFrom))) throw new Error("validFrom must be a valid ISO date");
    if (opts.validTo && (Number.isNaN(Date.parse(opts.validTo)) || Date.parse(opts.validTo) <= Date.parse(validFrom))) {
      throw new Error("validTo must be a valid date after validFrom");
    }

    const factKey = generateTopicKey(body, opts.id);
    const versionId = makeVersionId(factKey);
    const atomic = extractAtomicValue(body);

    const known = this.factIndex.get(factKey);
    const current =
      known && Date.parse(known.validFrom || "0") <= Date.parse(validFrom)
        ? { versionId: known.versionId, factKey, text: known.text, metadata: known.metadata }
        : await this.findCurrentFactVersion(factKey);

    this.limiter.acquire("write");
    this.limiter.acquire("ingest_tokens", countTokens(atomic));

    // Write the new version FIRST; only close the old one after it lands, so a
    // failed write never leaves the fact with no live version.
    const supersedes = current?.versionId;
    const reason = opts.because?.trim() || extractReason(body);
    const reasonSource: "explicit" | "extracted" | "unknown" = opts.because?.trim()
      ? "explicit"
      : reason
        ? "extracted"
        : "unknown";
    const transition = extractTransition(body);

    const status = opts.forget ? "forgotten" : opts.validTo ? "superseded" : "current";
    const item: MemoryItem = {
      id: versionId,
      text: atomic,
      infer: true,
      expiry_time: opts.ttlSeconds,
      relations: supersedes
        ? { ids: [supersedes], properties: { type: "supersedes", reason: reason ?? null } }
        : undefined,
      additional_metadata: {
        schema_version: METADATA_SCHEMA_VERSION,
        valid_from: validFrom,
        valid_to: opts.forget ? validFrom : opts.validTo,
        source_ref: opts.sourceRef,
        timestamp: validFrom,
        recorded_at: recordedAt,
        fact_key: factKey,
        version_id: versionId,
        supersedes,
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

    try {
      const res = await this.client.ingestMemory({
        database: this.identity.database,
        collection: this.identity.collection,
        memories: [item],
      });
      await this.client.awaitIndexed(res.ids, LIMITS.indexMaxAttempts, LIMITS.indexIntervalMs, {
        database: this.identity.database,
        collection: this.identity.collection,
      });
      this.trackTokens(atomic);
      this.rememberVersion(factKey, versionId, validFrom, atomic, item.additional_metadata!);
      if (current && supersedes) await this.closeFactVersion(current, validFrom);
      return this.ingestReceipt(true, "memory", {
        ids: res.ids,
        requestId: res.requestId,
        factKey,
        versionId,
      });
    } catch (e) {
      if (isPermanentError(e)) throw e;
      this.queue.enqueueMemory({
        database: this.identity.database,
        collection: this.identity.collection,
        memories: [item],
      }, (e as Error).message);
      this.trackTokens(atomic);
      this.rememberVersion(factKey, versionId, validFrom, atomic, item.additional_metadata!);
      return this.ingestReceipt(false, "memory", { queued: true, factKey, versionId });
    }
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

    // Query-only forget must match with reasonable confidence before deleting.
    const MIN_FORGET_SCORE = 0.35;
    const now = new Date().toISOString();
    const live = result.chunks.filter((c) => {
      const md = (c.metadata ?? {}) as Record<string, unknown>;
      return md.status !== "forgotten" && md.status !== "superseded";
    });
    if (!key && (live.length === 0 || (live[0]!.score ?? 0) < MIN_FORGET_SCORE)) {
      return {
        op: "forget",
        sources: [],
        mode_used: "fast",
        request_id: result.requestId,
        token_cost: 0,
        abstained: true,
        abstention_reason: "low_confidence",
        summary: `No confident match for that query (best score ${(live[0]?.score ?? 0).toFixed(2)}); nothing forgotten.`,
      };
    }

    let targets: typeof live;
    if (key) {
      targets = live.filter((c) => (c.metadata as Record<string, unknown> | undefined)?.fact_key === key);
    } else {
      const best = live[0];
      const bestKey = best
        ? String((best.metadata as Record<string, unknown> | undefined)?.fact_key ?? best.id)
        : undefined;
      targets = bestKey
        ? live.filter(
            (c) =>
              String((c.metadata as Record<string, unknown> | undefined)?.fact_key ?? c.id) === bestKey,
          )
        : [];
    }

    let closed = 0;
    for (const c of targets) {
      const md = (c.metadata ?? {}) as Record<string, unknown>;
      const factKey = String(md.fact_key ?? c.id);
      const versionId = String(md.version_id ?? c.id);
      await this.closeFactVersion(
        { versionId, factKey, text: c.text ?? c.content ?? "", metadata: md },
        now,
        "forgotten",
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
  ): Promise<void> {
    let text = version.text ?? "";
    let metadata = version.metadata ?? {};

    if (!text) {
      const result = await retrieve(this.client, {
        database: this.identity.database,
        collection: this.identity.collection,
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
    // re-checked, so closing a version can never throw mid-operation.
    this.limiter.consume("write");
    try {
      await this.client.ingestMemory({
        database: this.identity.database,
        collection: this.identity.collection,
        memories: [closedItem],
      });
    } catch (e) {
      if (isPermanentError(e)) return;
      this.queue.enqueueMemory({
        database: this.identity.database,
        collection: this.identity.collection,
        memories: [closedItem],
      }, (e as Error).message);
    }
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

    try {
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
    } catch (e) {
      if (isPermanentError(e)) throw e;
      this.queue.enqueueKnowledge({
        database: this.identity.database,
        collection: this.identity.collection,
        documents: [doc],
      }, (e as Error).message);
      this.trackTokens(body);
      return this.ingestReceipt(false, "knowledge", { queued: true });
    }
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

    const result = await retrieve(this.client, {
      database: this.identity.database,
      collection: this.identity.collection,
      query: plan.query,
      mode: plan.mode,
      type: plan.type,
      maxResults,
      asOf: plan.asOf,
    });

    const unavailable = result.unavailable || !!result.error;

    const liveChunks = result.chunks.filter((c) => {
      const md = c.metadata as Record<string, unknown> | undefined;
      if (md?.status === "forgotten") return false;
      return md?.memory_type !== CORPUS_STATS_TYPE;
    });

    const temporallyFiltered = plan.asOf
      ? filterByAsOf(liveChunks, plan.asOf)
      : resolveCurrentVersions(liveChunks);

    const disputes = detectDisputes(temporallyFiltered);

    const assembled = assembleEvidence(temporallyFiltered, {
      maxTokens,
      chronological: plan.requireChronology,
      preferCompact: true,
      preferCurrent: !plan.asOf && !plan.requireChronology,
    });

    const abstention = determineAbstention(temporallyFiltered, {
      asOf: plan.asOf,
      unavailable,
      query: opts.query,
      minScore: opts.snapshot ? 0 : undefined,
      minRelevance: opts.snapshot ? 0 : opts.minRelevance,
      abstainOnAmbiguity:
        opts.abstainOnAmbiguity ?? process.env.LOREX_ABSTAIN_ON_AMBIGUITY === "1",
    });

    const compression = computeCompression(assembled.totalTokens, measuredHaystack);

    const answer = abstention.abstained
      ? undefined
      : plan.requireChronology
        ? synthesizeTimeline(assembled.evidence)
        : synthesizeAnswer(assembled.evidence, opts.query);

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
      op: "history",
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
      query: "project decisions preferences facts constraints status",
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

    try {
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
    } catch (e) {
      if (isPermanentError(e)) throw e;
      this.queue.enqueueMemory(
        { database: this.identity.database, collection: this.identity.collection, memories: [item] },
        (e as Error).message,
      );
      this.trackTokens(body);
      return {
        op: "ingest",
        sources: [],
        mode_used: "fast",
        token_cost: countTokens(body),
        abstained: false,
        queued: true,
        result: { version_id: versionId, agent },
        summary: `Handoff queued for delivery (${agent}).`,
      };
    }
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

  async report(input: {
    requestId: string;
    answer?: string;
    sourceIds?: string[];
    rating?: "positive" | "negative" | "neutral";
    feedback?: string;
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
      metadata: { agent: "lorex" },
    };
    try {
      await this.client.feedback(feedback);
    } catch (error) {
      this.queue.enqueueFeedback(feedback, error instanceof Error ? error.message : String(error));
      return {
        op: "feedback",
        sources: [],
        mode_used: "fast",
        request_id: input.requestId,
        token_cost: 0,
        abstained: false,
        queued: true,
        summary: "Feedback queued for delivery to HydraDB.",
      };
    }

    return {
      op: "feedback",
      sources: [],
      mode_used: "fast",
      request_id: input.requestId,
      token_cost: 0,
      abstained: false,
      summary: "Feedback sent to HydraDB.",
    };
  }

  private rememberVersion(
    factKey: string,
    versionId: string,
    validFrom: string,
    text: string,
    metadata: Record<string, unknown>,
  ): void {
    const held = this.factIndex.get(factKey);
    if (held && Date.parse(held.validFrom || "0") > Date.parse(validFrom)) return;
    this.factIndex.set(factKey, { versionId, validFrom, text, metadata });
  }

  private async findCurrentFactVersion(factKey: string): Promise<{
    versionId: string;
    factKey: string;
    text?: string;
    metadata?: Record<string, unknown>;
  } | undefined> {
    const result = await retrieve(this.client, {
      database: this.identity.database,
      collection: this.identity.collection,
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
        if (md.valid_to) return false;
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
      agent: e.agent,
      memory_type: e.memoryType,
      reason: e.reason,
      status: e.status,
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

function isPermanentError(error: unknown): boolean {
  if (error instanceof HydraDBError) {
    return error.kind === "auth" || error.kind === "client";
  }
  const kind = (error as { kind?: string }).kind;
  return kind === "auth" || kind === "client";
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
    return md?.status === "current" || (!md?.valid_to && md?.status !== "superseded" && md?.status !== "forgotten");
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
    default:
      return "Unable to retrieve a reliable answer.";
  }
}
