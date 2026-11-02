/** Session ingestion pipeline and cross-session supersession linking. */

import type { HydraDBLike, MemoryItem, IngestKnowledgeInput } from "../infrastructure/store.js";
import type { NormalizedSession } from "../domain/session.js";
import { sessionToEvents } from "./normalizer.js";
import { chunkEvents, DEFAULT_CHUNK_TOKENS, type Chunk } from "./chunker.js";
import { deduplicateEvents } from "./deduplicator.js";
import { extractEpisodes, extractFacts, extractFactsWithLlm, llmExtractionEnabled, type ExtractedFact } from "./extractor.js";
import { extractReason, extractTransition } from "../domain/causality.js";
import { LIMITS, assertMaxLength } from "../infrastructure/limits.js";
import { METADATA_SCHEMA_VERSION } from "../domain/receipts.js";
import { redactSecrets } from "../infrastructure/secrets.js";

/** Backstop confidence floor; the extractor filters harder upstream. */
const MIN_PIPELINE_CONFIDENCE = 0.3;

export type FactIndex = Map<string, { versionId: string; validFrom: string; text: string; metadata: Record<string, unknown> }>;

export interface IngestionPipelineOptions {
  database: string;
  collection: string;
  maxTokensPerChunk?: number;
  factIndex?: FactIndex;
  indexWait?: { maxAttempts: number; intervalMs: number } | false;
}

export interface IngestionResult {
  sessionId: string;
  chunkCount: number;
  factCount: number;
  tokenCount: number;
  duplicateCount: number;
  knowledgeIds: string[];
  memoryIds: string[];
  errors: string[];
  partial: boolean;
}

export async function ingestSession(
  client: HydraDBLike,
  session: NormalizedSession,
  options: IngestionPipelineOptions,
): Promise<IngestionResult> {
  assertMaxLength("sessionId", session.sessionId, LIMITS.maxIdChars);
  if (session.turns.length > LIMITS.maxSessionTurns) {
    throw new Error(`session exceeds max turns (${session.turns.length} > ${LIMITS.maxSessionTurns})`);
  }
  for (const t of session.turns) {
    assertMaxLength("turn.content", t.content, LIMITS.maxTurnChars);
  }

  const errors: string[] = [];
  const events = sessionToEvents(session);
  const dedupResult = deduplicateEvents(events);
  const uniqueEvents = dedupResult.events;

  // Preserve the exact turn sequence in source chunks. Deduplication is useful
  // for fact extraction, but repeated user turns are still part of the record.
  const chunks = chunkEvents(session.sessionId, events, {
    maxTokens: options.maxTokensPerChunk ?? DEFAULT_CHUNK_TOKENS,
  });

  let facts = [...extractFacts(uniqueEvents), ...extractEpisodes(uniqueEvents)];
  // Tier 1 (opt-in): merge LLM-extracted facts under the heuristic baseline.
  if (llmExtractionEnabled()) {
    try {
      facts = await extractFactsWithLlm(uniqueEvents, facts);
    } catch {
      // Heuristic results stand on their own.
    }
  }
  // Extractors operate on events, but durable receipts must point to rows that
  // actually exist in the store. Resolve event provenance to the exact
  // verbatim chunk ids before any derived memory is written.
  facts = attachStoredEvidence(facts, chunks, events);

  let knowledgeIds: string[] = [];
  let memoryIds: string[] = [];

  try {
    knowledgeIds = await storeChunks(client, chunks, options, session.rootSessionId, session.agent, session.source);
  } catch (e) {
    errors.push(`chunks: ${(e as Error).message}`);
  }

  if (chunks.length && knowledgeIds.length !== chunks.length) {
    errors.push("facts: skipped because source chunks were not stored completely");
  } else {
    try {
      memoryIds = await storeFacts(client, facts.filter((fact) => fact.evidenceIds.length > 0), options, session.rootSessionId, session.agent, session.source);
    } catch (e) {
      errors.push(`facts: ${(e as Error).message}`);
    }
  }

  const allIds = [...knowledgeIds, ...memoryIds];
  if (allIds.length && options.indexWait !== false) {
    try {
      const wait = options.indexWait;
      await client.awaitIndexed(allIds, wait?.maxAttempts, wait?.intervalMs, {
        database: options.database,
        collection: options.collection,
      });
    } catch (e) {
      errors.push(`index_wait: ${(e as Error).message}`);
    }
  }

  if (knowledgeIds.length === 0 && memoryIds.length === 0 && errors.length) {
    throw new Error(`Session ingestion failed: ${errors.join("; ")}`);
  }

  return {
    sessionId: session.sessionId,
    chunkCount: chunks.length,
    factCount: memoryIds.length,
    tokenCount: session.tokenCount,
    duplicateCount: dedupResult.removedCount,
    knowledgeIds,
    memoryIds,
    errors,
    partial: errors.length > 0,
  };
}

function attachStoredEvidence(
  facts: ExtractedFact[],
  chunks: Chunk[],
  events: ReturnType<typeof sessionToEvents>,
): ExtractedFact[] {
  const eventIndexes = new Map(events.map((event, index) => [event.eventId, index]));
  return facts.map((fact) => {
    const evidence = new Set<string>();
    for (const eventId of fact.sourceEventIds) {
      const index = eventIndexes.get(eventId);
      if (index === undefined) continue;
      for (const chunk of chunks) {
        if (index >= chunk.eventStart && index <= chunk.eventEnd) evidence.add(chunk.chunkId);
      }
    }
    return { ...fact, evidenceIds: [...evidence] };
  });
}

async function storeChunks(
  client: HydraDBLike,
  chunks: Chunk[],
  options: IngestionPipelineOptions,
  rootSessionId?: string,
  agent?: string,
  source?: string,
): Promise<string[]> {
  if (chunks.length === 0) return [];
  const ids: string[] = [];
  const batchSize = 20;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const documents = batch.map((chunk) => ({
      id: chunk.chunkId,
      content: { text: redactSecrets(chunk.content).text },
      additional_metadata: {
        schema_version: METADATA_SCHEMA_VERSION,
        session_id: chunk.sessionId,
        source_session_id: chunk.sessionId,
        root_session_id: rootSessionId ?? chunk.sessionId,
        chunk_sequence: chunk.chunkSequence,
        total_chunks: chunk.totalChunks,
        event_start: chunk.eventStart,
        event_end: chunk.eventEnd,
        occurred_at: chunk.occurredAt,
        memory_type: "conversation_chunk",
        source_ref: chunk.sessionId,
        source,
        agent,
        trust: "verbatim_source",
      },
    }));
    const input: IngestKnowledgeInput = {
      database: options.database,
      collection: options.collection,
      documents,
    };
    const result = await client.ingestKnowledge(input);
    ids.push(...result.ids);
  }
  return ids;
}

async function storeFacts(
  client: HydraDBLike,
  facts: ExtractedFact[],
  options: IngestionPipelineOptions,
  rootSessionId?: string,
  agent?: string,
  source?: string,
): Promise<string[]> {
  if (facts.length === 0) return [];

  const ordered = [...facts].sort(
    (a, b) => Date.parse(a.occurredAt || "0") - Date.parse(b.occurredAt || "0"),
  );

  const index = options.factIndex;
  const items: MemoryItem[] = [];

  for (const fact of ordered) {
    if (fact.confidence < MIN_PIPELINE_CONFIDENCE) continue;
    const value = redactSecrets(fact.value).text;
    const versionId = `${fact.factKey}_${fact.sessionId}_${fact.eventId}`;
    // Agent-reported episodes are useful recollections, not authoritative
    // project state. They receive unique keys and must never close a user-
    // grounded fact chain.
    const canSupersede = fact.trust !== "assistant_report";
    const prior = canSupersede ? index?.get(fact.factKey) : undefined;
    const supersedes =
      prior && Date.parse(prior.validFrom || "0") < Date.parse(fact.occurredAt || "0")
        ? prior
        : undefined;

    if (supersedes) {
      items.push({
        id: supersedes.versionId,
        text: supersedes.text,
        infer: false,
        additional_metadata: {
          ...supersedes.metadata,
          valid_to: fact.occurredAt,
          status: "superseded",
          superseded_by: versionId,
        },
      });
    }

    const reason = extractReason(value);
    const transition = extractTransition(value);
    const metadata: Record<string, unknown> = {
      schema_version: METADATA_SCHEMA_VERSION,
      fact_key: fact.factKey,
      version_id: versionId,
      memory_type: fact.memoryType,
      valid_from: fact.occurredAt,
      timestamp: fact.occurredAt,
      evidence_ids: fact.evidenceIds,
      extraction_method: fact.extractionMethod,
      extraction_confidence: fact.confidence,
      is_correction: fact.isCorrection,
      supersedes: supersedes?.versionId,
      reason,
      reason_source: reason ? "extracted" : "unknown",
      from_value: transition.from,
      to_value: transition.to,
      source_ref: fact.sessionId,
      source_session_id: fact.sessionId,
      root_session_id: rootSessionId ?? fact.sessionId,
      source_event_id: fact.eventId,
      source_event_ids: fact.sourceEventIds,
      source,
      agent,
      status: "current",
      trust: fact.trust,
    };

    items.push({
      id: versionId,
      text: value,
      infer: true,
      relations: supersedes
        ? { ids: [supersedes.versionId], properties: { type: "supersedes", reason: reason ?? null } }
        : fact.evidenceIds.length
          ? { ids: fact.evidenceIds, properties: { type: "derives" } }
          : undefined,
      additional_metadata: metadata,
    });

    if (index && canSupersede) {
      const held = index.get(fact.factKey);
      if (!held || Date.parse(held.validFrom || "0") <= Date.parse(fact.occurredAt || "0")) {
        index.set(fact.factKey, {
          versionId,
          validFrom: fact.occurredAt,
          text: value,
          metadata,
        });
      }
    }
  }

  const ids: string[] = [];
  const batchSize = 25;
  for (let i = 0; i < items.length; i += batchSize) {
    const result = await client.ingestMemory({
      database: options.database,
      collection: options.collection,
      memories: items.slice(i, i + batchSize),
    });
    ids.push(...result.ids);
  }
  return ids;
}
