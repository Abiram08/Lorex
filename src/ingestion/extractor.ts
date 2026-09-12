/** Heuristic extraction of durable facts from conversation turns. */

import type { ConversationEvent } from "../domain/event.js";
import {
  generateTopicKey,
  generateContentKey,
  classifyMemoryType,
  extractAtomicValue,
} from "../domain/fact.js";
import type { MemoryType } from "../domain/fact.js";

export interface ExtractedFact {
  factKey: string;
  value: string;
  memoryType: MemoryType;
  eventId: string;
  sessionId: string;
  occurredAt: string;
  confidence: number;
  extractionMethod: "heuristic";
  evidenceIds: string[];
  isCorrection: boolean;
  supersedes?: string;
}

export function extractFacts(events: ConversationEvent[]): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  for (const event of events) {
    if (event.role === "tool") continue;
    if (event.content.length < 20) continue;
    if (isNoise(event.content)) continue;
    if (event.role === "assistant" && isLikelyHallucination(event.content)) continue;

    const signal = detectFactSignal(event.content);
    if (!signal.isDurable) continue;

    const atomic = extractAtomicValue(event.content);
    const memoryType = classifyMemoryType(atomic);
    const factKey =
      memoryType === "decision" || memoryType === "preference" || memoryType === "constraint"
        ? generateTopicKey(atomic)
        : generateContentKey(atomic);

    if (seen.has(factKey + ":" + atomic.slice(0, 80))) continue;
    seen.add(factKey + ":" + atomic.slice(0, 80));

    const confidence = calculateConfidence(signal, atomic, event.role);
    if (signal.strength === "weak" && confidence < 0.55) continue;

    facts.push({
      factKey,
      value: atomic,
      memoryType,
      eventId: event.eventId,
      sessionId: event.sessionId,
      occurredAt: event.occurredAt,
      confidence,
      extractionMethod: "heuristic",
      evidenceIds: [event.eventId],
      isCorrection: memoryType === "correction",
    });
  }

  return facts;
}

// ── Tier 1: opt-in LLM extraction (LOREX_EXTRACT=llm) ────────────────────────
// Batch 10-20 candidate chunks per call to a cheap OpenAI-compatible model
// with a JSON contract, merged with heuristic results and deduped by factKey.
// One call per batch of candidates — not per chunk — so cost stays bounded.

const LLM_EXTRACT_SYSTEM = `Extract durable facts from conversation excerpts: decisions, preferences, constraints, corrections, and stable project facts. Ignore questions, small talk, and speculation. Reply with ONLY a JSON array like:
[{"value":"<atomic fact sentence>","type":"decision|preference|constraint|correction|fact","confidence":0.0}]
Return [] when nothing is durable.`;

export function llmExtractionEnabled(): boolean {
  return (process.env.LOREX_EXTRACT ?? "").trim().toLowerCase() === "llm";
}

function synthEndpoint(): { baseUrl: string; apiKey: string; model: string } | null {
  const baseUrl = (process.env.LOREX_LLM_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiKey: (process.env.LOREX_LLM_API_KEY ?? "local").trim() || "local",
    model: (process.env.LOREX_EXTRACT_MODEL ?? process.env.LOREX_SYNTH_MODEL ?? "").trim() || "gpt-4o-mini",
  };
}

const EXTRACT_BATCH = 15;

export async function extractFactsWithLlm(
  events: ConversationEvent[],
  base: ExtractedFact[],
): Promise<ExtractedFact[]> {
  const cfg = synthEndpoint();
  if (!cfg) return base;

  const coveredKeys = new Set(base.map((f) => f.factKey));
  const candidates = events
    .filter((e) => e.role !== "tool" && e.content.length >= 40 && !isNoise(e.content))
    .slice(0, 200);

  let lastError: unknown;
  for (let i = 0; i < candidates.length; i += EXTRACT_BATCH) {
    const batch = candidates.slice(i, i + EXTRACT_BATCH);
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: LLM_EXTRACT_SYSTEM },
            {
              role: "user",
              content: batch
                .map((e, j) => `[${j + 1}] (${e.role}, ${e.occurredAt ?? "undated"}) ${e.content.slice(0, 600)}`)
                .join("\n\n"),
            },
          ],
          max_tokens: 1024,
          temperature: 0,
        }),
      });
      if (!res.ok) { lastError = new Error(`HTTP ${res.status}`); continue; }
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = (j.choices?.[0]?.message?.content ?? "").trim();
      const jsonText = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
      let parsed: Array<{ value?: string; type?: string; confidence?: number }>;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        lastError = new Error("unparseable extraction response");
        continue;
      }
      for (const item of parsed) {
        const value = (item.value ?? "").trim();
        if (value.length < 10 || value.length > 400) continue;
        const confidence = Math.max(0, Math.min(1, Number(item.confidence ?? 0.6)));
        if (confidence < 0.5) continue;
        const memoryType = classifyMemoryType(value);
        const factKey = generateTopicKey(value);
        if (coveredKeys.has(factKey)) continue; // heuristics already own this topic
        coveredKeys.add(factKey);
        const anchor = batch.find((e) => value.split(/\s+/).slice(0, 4).some((w) => e.content.includes(w)));
        base.push({
          factKey,
          value,
          memoryType,
          eventId: anchor?.eventId ?? `llm_${i}_${base.length}`,
          sessionId: anchor?.sessionId ?? "llm_extract",
          occurredAt: anchor?.occurredAt ?? new Date().toISOString(),
          confidence: Math.min(0.9, confidence),
          extractionMethod: "heuristic",
          evidenceIds: anchor ? [anchor.eventId] : [],
          isCorrection: memoryType === "correction",
        });
      }
    } catch (e) {
      lastError = e;
    }
  }
  if (lastError) {
    console.warn(`lorex: LLM extraction partially failed (${(lastError as Error).message}); heuristic facts kept.`);
  }
  return base;
}

interface FactSignal {
  isDurable: boolean;
  strength: "strong" | "medium" | "weak";
  reason: string;
}

/** Multilingual durable-signal markers, loaded from language-packs.ts (data,
 * contributor-extensible). English patterns live inline in detectFactSignal. */
import { PACKED } from "./language-packs.js";

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((m) => text.includes(m));
}

function anyMatch(regexes: RegExp[], text: string): boolean {
  return regexes.some((r) => r.test(text));
}

function detectFactSignal(text: string): FactSignal {
  const lower = text.toLowerCase();

  if (/\b(decided?|chose|selected|going with|switch(?:ed|ing)?\s+to|migrat(?:ed|ing)\s+to|mov(?:ed|ing)\s+to|replaced\s+with|now\s+us(?:e|ing)|using|adopting|upgraded\s+to|downgraded\s+to)\b/.test(lower) ||
      anyMatch(PACKED.decisionRegexes, text) ||
      containsAny(text, PACKED.decisionSubstrings)) {
    return { isDurable: true, strength: "strong", reason: "decision" };
  }
  if (/\b(prefer|like to|want to|enjoy|favorite|always use)\b/.test(lower) ||
      anyMatch(PACKED.preferenceRegexes, text)) {
    return { isDurable: true, strength: "strong", reason: "preference" };
  }
  if (/\b(must|cannot|can't|never|always|required|mandatory|forbidden)\b/.test(lower) ||
      anyMatch(PACKED.constraintRegexes, text)) {
    return { isDurable: true, strength: "strong", reason: "constraint" };
  }
  if (/\b(the|our|we)\s+(project|codebase|system|app|api|database|server)\s+(is|uses?|has|requires?|needs?)\b/.test(lower)) {
    return { isDurable: true, strength: "medium", reason: "project-fact" };
  }
  if (/\b(version|release|deploy|launch)\s+(is|was|will be)\b/.test(lower)) {
    return { isDurable: true, strength: "medium", reason: "version" };
  }
  if (/\b(actually|wrong|incorrect|changed to|switched from|instead of|no longer|not .* but)\b/.test(lower) ||
      containsAny(text, PACKED.correctionSubstrings)) {
    return { isDurable: true, strength: "strong", reason: "correction" };
  }
  if (/\b(is|are|uses?|has|have|requires?)\b/.test(lower) && text.length > 50) {
    if (!isQuestion(text) && !isMetaTalk(text)) {
      return { isDurable: true, strength: "weak", reason: "general-statement" };
    }
  }

  return { isDurable: false, strength: "weak", reason: "no-signal" };
}

function calculateConfidence(signal: FactSignal, text: string, role: string): number {
  let confidence = 0.5;
  if (signal.strength === "strong") confidence += 0.3;
  else if (signal.strength === "medium") confidence += 0.2;
  else confidence += 0.1;

  if (text.length > 100) confidence += 0.1;
  else if (text.length > 50) confidence += 0.05;

  if (role === "user") confidence += 0.05;

  return Math.min(0.95, confidence);
}

function isNoise(text: string): boolean {
  const lower = text.toLowerCase();
  if (/^(hi|hello|hey|good morning|good afternoon|good evening)\b/.test(lower)) return true;
  if (/^(thanks|thank you|thx|ty)\b/.test(lower)) return true;
  if (/^(yes|no|ok|okay|sure|got it|makes sense)\b/.test(lower)) return true;
  if (text.length < 20) return true;
  return false;
}

function isQuestion(text: string): boolean {
  const t = text.trim();
  // Full-width ？ (CJK) and Arabic/Devanagari-question marks included.
  return t.endsWith("?") || t.endsWith("？") || /\b(what|when|where|why|how|who|which)\b.*[?？]/.test(t);
}

function isMetaTalk(text: string): boolean {
  const lower = text.toLowerCase();
  return /\b(I (see|understand|agree|disagree)|that makes sense|good point|interesting|let me think)\b/.test(lower);
}

function isLikelyHallucination(text: string): boolean {
  const lower = text.toLowerCase();

  if (/\b(as an ai|as a language model|i don't have access|i'm not able to)\b/.test(lower)) {
    return true;
  }

  const hedges = lower.match(/\b(might|maybe|could|perhaps|possibly|generally|usually|typically)\b/g)?.length ?? 0;
  if (hedges < 3) return false;

  const hasConcreteDetail = /\d/.test(text) || /\b[A-Z][a-z]{2,}\b/.test(text);
  return !hasConcreteDetail;
}
