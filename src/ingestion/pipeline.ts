/** Session ingestion pipeline and cross-session supersession linking. */

import type { HydraDBLike, MemoryItem, IngestKnowledgeInput } from "../infrastructure/hydradb-client.js";
import type { NormalizedSession } from "../domain/session.js";
import { sessionToEvents } from "./normalizer.js";
import { chunkEvents, DEFAULT_CHUNK_TOKENS, type Chunk } from "./chunker.js";
import { deduplicateEvents } from "./deduplicator.js";
import { extractFacts, type ExtractedFact } from "./extractor.js";
import { extractReason, extractTransition } from "../domain/causality.js";
import { LIMITS, assertMaxLength } from "../infrastructure/limits.js";
import { METADATA_SCHEMA_VERSION } from "../domain/receipts.js";

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

  const chunks = chunkEvents(session.sessionId, uniqueEvents, {
    maxTokens: options.maxTokensPerChunk ?? DEFAULT_CHUNK_TOKENS,
  });

  const facts = extractFacts(uniqueEvents);

  let knowledgeIds: string[] = [];
  let memoryIds: string[] = [];

  try {
    knowledgeIds = await storeChunks(client, chunks, options);
  } catch (e) {
    errors.push(`chunks: ${(e as Error).message}`);
  }

  try {
    memoryIds = await storeFacts(client, facts, options);
  } catch (e) {
    errors.push(`facts: ${(e as Error).message}`);
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
    factCount: facts.length,
    tokenCount: session.tokenCount,
    duplicateCount: dedupResult.removedCount,
    knowledgeIds,
    memoryIds,
    errors,
    partial: errors.length > 0,
  };
}

async function storeChunks(
  client: HydraDBLike,
  chunks: Chunk[],
  options: IngestionPipelineOptions,
): Promise<string[]> {
  if (chunks.length === 0) return [];
  const ids: string[] = [];
  const batchSize = 20;
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const documents = batch.map((chunk) => ({
      id: chunk.chunkId,
      content: { text: chunk.content },
      additional_metadata: {
        schema_version: METADATA_SCHEMA_VERSION,
        session_id: chunk.sessionId,
        chunk_sequence: chunk.chunkSequence,
        total_chunks: chunk.totalChunks,
        event_start: chunk.eventStart,
        event_end: chunk.eventEnd,
        occurred_at: chunk.occurredAt,
        memory_type: "conversation_chunk",
        source_ref: chunk.sessionId,
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
): Promise<string[]> {
  if (facts.length === 0) return [];

  const ordered = [...facts].sort(
    (a, b) => Date.parse(a.occurredAt || "0") - Date.parse(b.occurredAt || "0"),
  );

  const index = options.factIndex;
  const items: MemoryItem[] = [];

  for (const fact of ordered) {
    const versionId = `${fact.factKey}_${fact.sessionId}_${fact.eventId}`;
    const prior = index?.get(fact.factKey);
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

    const reason = extractReason(fact.value);
    const transition = extractTransition(fact.value);
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
      source_event_id: fact.eventId,
      status: "current",
      trust: "heuristic_extract",
    };

    items.push({
      id: versionId,
      text: fact.value,
      infer: true,
      relations: supersedes
        ? { ids: [supersedes.versionId], properties: { type: "supersedes", reason: reason ?? null } }
        : undefined,
      additional_metadata: metadata,
    });

    if (index) {
      const held = index.get(fact.factKey);
      if (!held || Date.parse(held.validFrom || "0") <= Date.parse(fact.occurredAt || "0")) {
        index.set(fact.factKey, {
          versionId,
          validFrom: fact.occurredAt,
          text: fact.value,
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
