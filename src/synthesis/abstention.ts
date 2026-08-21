/** Abstention policy: when the evidence does not support an answer. */

import type { QueryChunk } from "../infrastructure/hydradb-client.js";

export type { AbstentionReason } from "../domain/receipts.js";
import type { AbstentionReason } from "../domain/receipts.js";

export interface AbstentionResult {
  abstained: boolean;
  reason?: AbstentionReason;
  confidence?: number;
  relevanceScore?: number;
  ambiguous?: boolean;
}

export interface AbstentionOptions {
  minScore?: number;
  minRelevance?: number;
  asOf?: string;
  unavailable?: boolean;
  query?: string;
  abstainOnAmbiguity?: boolean;
}

export const MIN_LEXICAL_RELEVANCE = 0.25;

const MIN_QUERY_CONTENT_WORDS = 3;

export function determineAbstention(
  chunks: QueryChunk[],
  options: AbstentionOptions = {},
): AbstentionResult {
  const minScore = options.minScore ?? 0.22;

  if (options.unavailable) {
    return { abstained: true, reason: "unavailable" };
  }

  if (chunks.length === 0) {
    return { abstained: true, reason: "no_evidence" };
  }

  const scored = [...chunks].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const scores = scored.map((c) => c.score).filter((s): s is number => typeof s === "number");
  const maxScore = scores.length ? Math.max(...scores) : 0;
  const secondScore = scores.length > 1 ? scores[1]! : 0;
  const hasAnyScore = scores.length > 0;

  if (hasAnyScore && maxScore < minScore) {
    return { abstained: true, reason: "low_confidence", confidence: maxScore };
  }

  if (options.asOf) {
    const asOfTime = Date.parse(options.asOf);
    if (!Number.isNaN(asOfTime)) {
      const validChunks = chunks.filter((chunk) => isValidAt(chunk, asOfTime));
      if (validChunks.length === 0) {
        const anyTemporal = chunks.some(
          (c) => c.metadata?.valid_from || c.metadata?.valid_to,
        );
        if (anyTemporal) {
          return { abstained: true, reason: "outside_time_window", confidence: maxScore };
        }
      }
    }
  }

  if (detectContradiction(scored)) {
    return { abstained: true, reason: "contradictory_evidence", confidence: maxScore };
  }

  const ambiguous =
    scored.length >= 2 &&
    maxScore >= 0.65 &&
    secondScore >= 0.6 &&
    (maxScore - secondScore) / Math.max(maxScore, 1e-6) < 0.08;

  if (ambiguous && options.abstainOnAmbiguity) {
    return {
      abstained: true,
      reason: "ambiguous_entity",
      confidence: maxScore,
      ambiguous: true,
    };
  }

  if (options.query && options.query.trim().length >= 8) {
    const queryWords = tokenize(options.query);
    const relevance = calculateRelevance(scored, options.query);
    const minRelevance = options.minRelevance ?? MIN_LEXICAL_RELEVANCE;

    if (queryWords.size >= MIN_QUERY_CONTENT_WORDS && relevance < minRelevance) {
      return {
        abstained: true,
        reason: "evidence_not_relevant",
        confidence: maxScore,
        relevanceScore: relevance,
      };
    }
    return {
      abstained: false,
      confidence: maxScore || relevance,
      relevanceScore: relevance,
      ambiguous,
    };
  }

  return { abstained: false, confidence: maxScore, ambiguous };
}

function isValidAt(chunk: QueryChunk, asOfTime: number): boolean {
  const validFrom = chunk.metadata?.valid_from as string | undefined;
  const validTo = chunk.metadata?.valid_to as string | undefined;
  if (!validFrom && !validTo) return true;
  const vfTime = validFrom ? Date.parse(validFrom) : 0;
  const vtTime = validTo ? Date.parse(validTo) : Infinity;
  if (Number.isNaN(vfTime)) return true;
  return vfTime <= asOfTime && asOfTime < (Number.isNaN(vtTime) ? Infinity : vtTime);
}

function calculateRelevance(chunks: QueryChunk[], query: string): number {
  const queryWords = tokenize(query);
  if (queryWords.size === 0) return 1;

  let best = 0;
  for (const chunk of chunks.slice(0, 8)) {
    const text = (chunk.text ?? chunk.content ?? "").toLowerCase();
    const textWords = tokenize(text);
    let overlap = 0;
    for (const w of queryWords) if (textWords.has(w)) overlap++;
    best = Math.max(best, overlap / queryWords.size);
  }
  return best;
}

const QUERY_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "was", "were", "have",
  "has", "had", "are", "you", "your", "they", "their", "about", "into", "when",
  "what", "which", "there", "then", "than", "them", "his", "her", "its", "did",
  "does", "how", "why", "who", "whom", "our", "ours", "yours", "can", "could",
  "would", "should", "will", "shall", "may", "might", "must", "any", "all",
  "some", "many", "much", "more", "most", "get", "got", "use", "used", "using",
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !QUERY_STOPWORDS.has(w)),
  );
}

function isResolved(chunk: QueryChunk): boolean {
  const md = chunk.metadata as Record<string, unknown> | undefined;
  if (!md) return false;
  if (md.status === "superseded" || md.status === "forgotten") return true;
  if (md.valid_to) {
    const closed = Date.parse(String(md.valid_to));
    if (!Number.isNaN(closed) && closed <= Date.now()) return true;
  }
  return false;
}

function detectContradiction(chunks: QueryChunk[]): boolean {
  const live = chunks.filter((c) => !isResolved(c));
  if (live.length < 2) return false;
  const top = live.slice(0, 3);
  const texts = top.map((c) => (c.text ?? c.content ?? "").toLowerCase());

  const switchPattern = /\b(switched|changed|moved)\s+from\s+(\w+)\s+to\s+(\w+)\b/;
  let switchFrom = "";
  for (const text of texts) {
    const match = text.match(switchPattern);
    if (match) {
      switchFrom = match[2] ?? "";
      break;
    }
  }
  if (switchFrom) {
    for (const text of texts) {
      if (
        new RegExp(`\\buse\\s+${escapeRe(switchFrom)}\\b`).test(text) &&
        !/\b(switched|changed|moved)\b/.test(text)
      ) {
        return true;
      }
    }
  }

  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const s1 = top[i]?.score ?? 0;
      const s2 = top[j]?.score ?? 0;
      if (s1 < 0.55 || s2 < 0.55) continue;
      const notPattern = /\bnot\s+(?:using?|choosing?|going\s+with)\s+(\w+)/;
      const m1 = texts[i]?.match(notPattern);
      const m2 = texts[j]?.match(notPattern);
      if (m1?.[1] && texts[j]?.includes(`use ${m1[1]}`)) return true;
      if (m2?.[1] && texts[i]?.includes(`use ${m2[1]}`)) return true;
    }
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
