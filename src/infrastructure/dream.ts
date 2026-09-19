/** Dream: background pattern extraction from session history. Heuristic, no LLM needed. */

import type { HydraDBLike, QueryChunk } from "./store.js";
import {
  planConsolidation,
  type ConsolidationCandidate,
} from "./lifecycle.js";

export interface DreamResult {
  discovered: DreamMemory[];
  reinforced: string[];
  contradictions: DreamContradiction[];
  consolidated: { pruned: number; expired: number };
  durationMs: number;
}

export interface DreamMemory {
  text: string;
  factKey: string;
  memoryType: "preference" | "lesson" | "pattern";
  confidence: number;
  source: "frequency" | "temporal" | "correction" | "contradiction";
  sourceIds: string[];
}

export interface DreamContradiction {
  factKey: string;
  versionA: { id: string; text: string; createdAt: string };
  versionB: { id: string; text: string; createdAt: string };
}

export interface DreamOptions {
  maxDiscoveries?: number;
  minConfidence?: number;
  consolidate?: boolean;
}

interface QueryFailureAware {
  getQueryFailures(limit?: number): Array<{ pattern: string; fails: number }>;
}

function groupByFactKey(chunks: QueryChunk[]): Map<string, QueryChunk[]> {
  const map = new Map<string, QueryChunk[]>();
  for (const chunk of chunks) {
    const key = (chunk.metadata?.fact_key as string) ?? chunk.id;
    const group = map.get(key) ?? [];
    group.push(chunk);
    map.set(key, group);
  }
  return map;
}

function metadataDate(chunk: QueryChunk, field: string): string | null {
  const val = chunk.metadata?.[field];
  return typeof val === "string" && val ? val : null;
}

export async function dreamHeuristic(
  client: HydraDBLike,
  collection: string,
  opts: DreamOptions = {},
): Promise<DreamResult> {
  const start = Date.now();
  const maxDiscoveries = opts.maxDiscoveries ?? 20;
  const minConfidence = opts.minConfidence ?? 0.6;

  const result: DreamResult = {
    discovered: [],
    reinforced: [],
    contradictions: [],
    consolidated: { pruned: 0, expired: 0 },
    durationMs: 0,
  };

  const queryResult = await client.query({
    query: "",
    database: collection,
    collection,
    max_results: 500,
    metadata_filters: {},
  });

  const chunks = queryResult.chunks;
  if (chunks.length === 0) {
    result.durationMs = Date.now() - start;
    return result;
  }

  const byFactKey = groupByFactKey(chunks);

  for (const [key, group] of byFactKey) {
    if (group.length < 3) continue;
    const confidence = Math.min(1.0, 0.6 + (group.length - 3) * 0.05);
    if (confidence < minConfidence) continue;
    result.discovered.push({
      text: `Repeated pattern (${group.length}x): ${group[0].text}`,
      factKey: `dream_pref_${key}`,
      memoryType: "preference",
      confidence,
      source: "frequency",
      sourceIds: group.map((c) => c.id),
    });
  }

  for (const [key, group] of byFactKey) {
    if (group.length < 2) continue;
    const dates = group
      .map((c) => metadataDate(c, "valid_from") ?? metadataDate(c, "created_at"))
      .filter((d): d is string => !!d)
      .sort();
    if (dates.length < 2) continue;

    const spanMs = Date.parse(dates[dates.length - 1]) - Date.parse(dates[0]);
    const spanDays = spanMs / (1000 * 60 * 60 * 24);
    if (spanDays > 7) {
      result.discovered.push({
        text: `Recurring topic across ${Math.round(spanDays)} days: ${group[0].text}`,
        factKey: `dream_temporal_${key}`,
        memoryType: "lesson",
        confidence: 0.7,
        source: "temporal",
        sourceIds: group.map((c) => c.id),
      });
    }
  }

  for (const [key, group] of byFactKey) {
    const corrections = group.filter((c) => c.metadata?.memory_type === "correction");
    if (corrections.length < 2) continue;
    result.contradictions.push({
      factKey: key,
      versionA: {
        id: corrections[0].id,
        text: corrections[0].text ?? "",
        createdAt: metadataDate(corrections[0], "valid_from") ?? "",
      },
      versionB: {
        id: corrections[corrections.length - 1].id,
        text: corrections[corrections.length - 1].text ?? "",
        createdAt: metadataDate(corrections[corrections.length - 1], "valid_from") ?? "",
      },
    });
  }

  result.discovered = result.discovered.slice(0, maxDiscoveries);

  const unique = new Map<string, DreamMemory>();
  for (const d of result.discovered) {
    const existing = unique.get(d.factKey);
    if (!existing || d.confidence > existing.confidence) {
      unique.set(d.factKey, d);
    }
  }
  result.discovered = Array.from(unique.values());

  for (const chunk of chunks) {
    const accessCount = (chunk.metadata?.access_count as number) ?? 0;
    if (accessCount >= 3) {
      result.reinforced.push(chunk.id);
    }
  }

  const maybeFailures = client as Partial<QueryFailureAware>;
  if (typeof maybeFailures.getQueryFailures === "function") {
    for (const f of maybeFailures.getQueryFailures(5)) {
      if (f.fails < 3) continue;
      result.discovered.push({
        text: `Recall gap: "${f.pattern}" failed ${f.fails}x — memory may be missing or misleading here`,
        factKey: `dream_gap_${f.pattern.slice(0, 40).replace(/\W+/g, "_")}`,
        memoryType: "lesson",
        confidence: Math.min(0.9, 0.5 + f.fails * 0.05),
        source: "contradiction",
        sourceIds: [],
      });
    }
  }

  if (opts.consolidate !== false) {
    const candidates: ConsolidationCandidate[] = chunks.map((c) => ({
      id: c.id,
      factKey: (c.metadata?.fact_key as string) ?? c.id,
      text: c.text ?? "",
      memoryType: (c.metadata?.memory_type as string) ?? null,
      createdAt: (metadataDate(c, "valid_from") ?? metadataDate(c, "created_at") ?? new Date().toISOString()),
      strength: (c.metadata?.strength as number) ?? 1.0,
      accessCount: (c.metadata?.access_count as number) ?? 0,
    }));

    const plan = planConsolidation(candidates);
    result.consolidated.pruned = plan.pruned.length;
    result.consolidated.expired = plan.expired.length;
  }

  result.durationMs = Date.now() - start;
  return result;
}

/** Gates: ≥5 unprocessed sessions, ≥24h since last run, not already running. */
export function shouldDream(
  lastDreamAt: string | null,
  unprocessedSessions: number,
  isRunning: boolean,
): boolean {
  if (isRunning) return false;
  if (unprocessedSessions < 5) return false;
  if (lastDreamAt) {
    const hoursSince = (Date.now() - Date.parse(lastDreamAt)) / (1000 * 60 * 60);
    if (hoursSince < 24) return false;
  }
  return true;
}
