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
  consolidationCandidates: { pruned: number; expired: number };
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

function observationSession(chunk: QueryChunk): string | undefined {
  const value = chunk.metadata?.root_session_id ?? chunk.metadata?.source_session_id ?? chunk.metadata?.source_ref;
  return typeof value === "string" && value ? value : undefined;
}

function wordSet(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9+#.-]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 3 && !["the", "and", "for", "with", "that", "this", "because"].includes(word)),
  );
}

function similarity(a: string, b: string): number {
  const left = wordSet(a);
  const right = wordSet(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.max(left.size, right.size);
}

function salientValue(chunk: QueryChunk): string | undefined {
  const metadataValue = chunk.metadata?.to_value;
  if (typeof metadataValue === "string" && metadataValue.trim()) return metadataValue.toLowerCase();
  const text = chunk.text ?? "";
  const match = text.match(
    /\b(?:use|using|prefer|chose|selected|adopted|migrated to|switched to|replaced with)\s+(?:to use\s+)?([a-z0-9][\w.+#-]{1,40})/i,
  );
  return match?.[1]?.toLowerCase();
}

function equivalentObservation(a: QueryChunk, b: QueryChunk): boolean {
  const leftValue = salientValue(a);
  const rightValue = salientValue(b);
  // One changed choice in an otherwise identical sentence is a new value, not
  // confirming evidence (Redis → Postgres must remain history).
  if (leftValue && rightValue && leftValue !== rightValue) return false;
  return similarity(a.text ?? "", b.text ?? "") >= 0.72;
}

/** Cluster observations by meaning before counting sessions. A shared fact key
 * alone is insufficient: Redis → Postgres → SQLite is a history, not a repeated
 * preference for Redis. */
function repeatedCluster(group: QueryChunk[]): { members: QueryChunk[]; sessions: Set<string> } | null {
  const clusters: QueryChunk[][] = [];
  for (const chunk of group) {
    const cluster = clusters.find((candidate) => equivalentObservation(candidate[0]!, chunk));
    if (cluster) cluster.push(chunk);
    else clusters.push([chunk]);
  }

  let best: { members: QueryChunk[]; sessions: Set<string> } | null = null;
  for (const members of clusters) {
    const sessions = new Set(members.map(observationSession).filter((v): v is string => !!v));
    if (!best || sessions.size > best.sessions.size) best = { members, sessions };
  }
  return best;
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
    consolidationCandidates: { pruned: 0, expired: 0 },
    durationMs: 0,
  };

  const queryResult = await client.query({
    query: "",
    database: collection,
    collection,
    type: "memory",
    max_results: 500,
    // Pattern learning needs observations from prior versions. Normal recall
    // correctly hides those versions; Dream deliberately studies the history.
    metadata_filters: { include_superseded: true },
  });

  const chunks = queryResult.chunks;
  if (chunks.length === 0) {
    result.durationMs = Date.now() - start;
    return result;
  }

  // Only user-grounded observations teach standing patterns. Agent-reported
  // episodes remain useful for recall, but cannot bootstrap themselves into a
  // durable preference; inferred patterns likewise cannot cite prior inferences.
  const observations = chunks.filter((chunk) => {
    const trust = String(chunk.metadata?.trust ?? "");
    const type = String(chunk.metadata?.memory_type ?? "");
    return trust !== "assistant_report" && trust !== "inferred_pattern" &&
      type !== "conversation_chunk" && type !== "corpus_stats";
  });
  const byFactKey = groupByFactKey(observations);

  for (const [key, group] of byFactKey) {
    const repeated = repeatedCluster(group);
    if (!repeated || repeated.sessions.size < 3) continue;
    const confidence = Math.min(1.0, 0.6 + (repeated.sessions.size - 3) * 0.05);
    if (confidence < minConfidence) continue;
    const representative = [...repeated.members].sort((a, b) =>
      Date.parse(metadataDate(b, "valid_from") ?? metadataDate(b, "created_at") ?? "0") -
      Date.parse(metadataDate(a, "valid_from") ?? metadataDate(a, "created_at") ?? "0")
    )[0]!;
    result.discovered.push({
      text: `Observed across ${repeated.sessions.size} independent sessions: ${representative.text}`,
      factKey: `dream_pref_${key}`,
      memoryType: representative.metadata?.memory_type === "preference" ? "preference" : "pattern",
      confidence,
      source: "frequency",
      sourceIds: repeated.members.map((c) => c.id),
    });
  }

  for (const [key, group] of byFactKey) {
    const sessions = new Set(group.map(observationSession).filter((v): v is string => !!v));
    if (group.length < 2 || sessions.size < 2) continue;
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

  const unique = new Map<string, DreamMemory>();
  for (const discovery of result.discovered) {
    const existing = unique.get(discovery.factKey);
    if (!existing || discovery.confidence > existing.confidence) unique.set(discovery.factKey, discovery);
  }
  result.discovered = [...unique.values()].slice(0, maxDiscoveries);

  if (opts.consolidate !== false) {
    const candidates: ConsolidationCandidate[] = chunks
      .filter((c) => c.metadata?.status !== "superseded" && c.metadata?.status !== "forgotten")
      .map((c) => ({
      id: c.id,
      factKey: (c.metadata?.fact_key as string) ?? c.id,
      text: c.text ?? "",
      memoryType: (c.metadata?.memory_type as string) ?? null,
      createdAt: (metadataDate(c, "valid_from") ?? metadataDate(c, "created_at") ?? new Date().toISOString()),
      strength: (c.metadata?.strength as number) ?? 1.0,
      accessCount: (c.metadata?.access_count as number) ?? 0,
    }));

    const plan = planConsolidation(candidates);
    result.consolidationCandidates.pruned = plan.pruned.length;
    result.consolidationCandidates.expired = plan.expired.length;
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
