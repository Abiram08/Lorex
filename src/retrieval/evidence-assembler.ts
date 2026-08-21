/** Evidence ranking and packing under a token budget. */

import type { QueryChunk } from "../infrastructure/hydradb-client.js";
import type { Evidence } from "../domain/evidence.js";
import { excerpt } from "../domain/evidence.js";
import { countTokens, truncateToTokenBudget } from "../ingestion/token-counter.js";
import { DEFAULT_CONTEXT_TOKEN_BUDGET } from "../domain/compression.js";

export interface AssembleOptions {
  maxTokens?: number;
  chronological?: boolean;
  ensureDiversity?: boolean;
  preferCompact?: boolean;
  preferCurrent?: boolean;
}

export interface AssembledEvidence {
  evidence: Evidence[];
  totalTokens: number;
  truncated: boolean;
  memoryCount: number;
  knowledgeCount: number;
  candidateTokens: number;
}

export function assembleEvidence(
  chunks: QueryChunk[],
  options: AssembleOptions = {},
): AssembledEvidence {
  const maxTokens = options.maxTokens ?? DEFAULT_CONTEXT_TOKEN_BUDGET;
  const chronological = options.chronological ?? false;
  const ensureDiversity = options.ensureDiversity ?? true;
  const preferCompact = options.preferCompact ?? true;
  const preferCurrent = options.preferCurrent ?? !chronological;

  const evidence: Evidence[] = chunks.map((chunk) => {
    const raw = chunk.text ?? chunk.content ?? "";
    const corpus = chunk.corpus ?? "memory";
    const perSourceCap = Math.max(200, Math.floor(maxTokens / 4));
    const content =
      preferCompact && corpus === "knowledge" && countTokens(raw) > perSourceCap
        ? truncateToTokenBudget(raw, perSourceCap)
        : raw;
    return {
      id: chunk.id,
      corpus,
      content,
      excerpt: excerpt(raw),
      score: chunk.score,
      validFrom: chunk.metadata?.valid_from as string | undefined,
      validTo: chunk.metadata?.valid_to as string | undefined,
      sourceRef: chunk.metadata?.source_ref as string | undefined,
      sessionId: chunk.metadata?.session_id as string | undefined,
      occurredAt: chunk.metadata?.occurred_at as string | undefined,
      agent: chunk.metadata?.agent as string | undefined,
      memoryType: chunk.metadata?.memory_type as string | undefined,
      reason: chunk.metadata?.reason as string | undefined,
      status: chunk.metadata?.status as string | undefined,
    };
  });

  const candidateTokens = evidence.reduce((s, e) => s + countTokens(e.content), 0);
  const deduped = deduplicateEvidence(evidence);

  const isStale = (e: Evidence): boolean =>
    e.status === "superseded" || e.status === "forgotten";

  deduped.sort((a, b) => {
    if (chronological) {
      const aTime = a.validFrom ?? a.occurredAt;
      const bTime = b.validFrom ?? b.occurredAt;
      if (aTime && bTime) {
        return new Date(aTime).getTime() - new Date(bTime).getTime();
      }
    }
    if (preferCurrent) {
      const aStale = isStale(a);
      const bStale = isStale(b);
      if (aStale !== bStale) return aStale ? 1 : -1;
    }
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
    if (Math.abs(scoreDiff) > 0.05) return scoreDiff;

    if (a.corpus !== b.corpus) {
      const aAuthoritative = a.corpus === "memory" && !!a.validFrom;
      const bAuthoritative = b.corpus === "memory" && !!b.validFrom;
      if (aAuthoritative !== bAuthoritative) return aAuthoritative ? -1 : 1;
    }
    return countTokens(a.content) - countTokens(b.content);
  });

  const result: Evidence[] = [];
  let totalTokens = 0;
  let memoryCount = 0;
  let knowledgeCount = 0;
  let truncated = false;

  if (ensureDiversity) {
    const memories = deduped.filter((e) => e.corpus === "memory");
    const knowledge = deduped.filter((e) => e.corpus === "knowledge");
    if (memories[0]) {
      const t = countTokens(memories[0].content);
      if (t <= maxTokens) {
        result.push(memories[0]);
        totalTokens += t;
        memoryCount++;
      }
    }
    if (knowledge[0] && totalTokens < maxTokens) {
      const t = countTokens(knowledge[0].content);
      if (totalTokens + t <= maxTokens) {
        result.push(knowledge[0]);
        totalTokens += t;
        knowledgeCount++;
      }
    }
  }

  const usedIds = new Set(result.map((e) => e.id));
  for (const e of deduped) {
    if (usedIds.has(e.id)) continue;
    if (totalTokens >= maxTokens) {
      truncated = true;
      break;
    }
    let content = e.content;
    let tokens = countTokens(content);
    if (totalTokens + tokens > maxTokens) {
      const room = maxTokens - totalTokens;
      if (room < 80) {
        truncated = true;
        continue;
      }
      content = truncateToTokenBudget(content, room);
      tokens = countTokens(content);
      truncated = true;
    }
    result.push({ ...e, content, excerpt: excerpt(content) });
    totalTokens += tokens;
    usedIds.add(e.id);
    if (e.corpus === "memory") memoryCount++;
    else knowledgeCount++;
  }

  return {
    evidence: result,
    totalTokens,
    truncated,
    memoryCount,
    knowledgeCount,
    candidateTokens,
  };
}

function deduplicateEvidence(evidence: Evidence[]): Evidence[] {
  const result: Evidence[] = [];
  const seen = new Set<string>();

  for (const e of evidence) {
    const normalized = e.content.toLowerCase().replace(/\s+/g, " ").trim();
    const key = normalized.slice(0, 200);
    if (seen.has(key)) continue;

    let isDuplicate = false;
    for (let i = 0; i < result.length; i++) {
      const existing = result[i]!;
      const existingNorm = existing.content.toLowerCase().replace(/\s+/g, " ").trim();
      if (normalized.length > 50 && existingNorm.length > 50) {
        if (
          normalized.includes(existingNorm.slice(0, 100)) ||
          existingNorm.includes(normalized.slice(0, 100))
        ) {
          isDuplicate = true;
          if ((e.score ?? 0) > (existing.score ?? 0)) result[i] = e;
          break;
        }
      }
    }

    if (!isDuplicate) {
      result.push(e);
      seen.add(key);
    }
  }
  return result;
}

export function synthesizeTimeline(evidence: Evidence[]): string {
  if (evidence.length === 0) return "No evidence found.";
  const lines: string[] = ["## Evidence Timeline", ""];
  for (const item of evidence) {
    const date = item.validFrom ?? item.occurredAt ?? "unknown date";
    const confidence = item.score ? ` (${Math.round(item.score * 100)}%)` : "";
    lines.push(`- **${date}**: ${item.excerpt}${confidence}`);
  }
  return lines.join("\n");
}

export function synthesizeAnswer(evidence: Evidence[], query?: string): string {
  if (evidence.length === 0) return "No evidence found to answer this question.";
  const lines: string[] = [];
  if (query) lines.push(`**Question**: ${query}`, "");
  lines.push("**Grounded context**:", "");
  for (let i = 0; i < Math.min(5, evidence.length); i++) {
    const e = evidence[i]!;
    const confidence = e.score ? ` (${Math.round(e.score * 100)}%)` : "";
    lines.push(`${i + 1}. ${e.excerpt}${confidence} [${e.corpus}]`);
  }
  if (evidence.length > 5) lines.push(`\n… +${evidence.length - 5} more`);
  return lines.join("\n");
}
