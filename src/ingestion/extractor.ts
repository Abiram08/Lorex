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

interface FactSignal {
  isDurable: boolean;
  strength: "strong" | "medium" | "weak";
  reason: string;
}

function detectFactSignal(text: string): FactSignal {
  const lower = text.toLowerCase();

  if (/\b(decided?|chose|selected|going with|switch(?:ed|ing)?\s+to|migrat(?:ed|ing)\s+to|mov(?:ed|ing)\s+to|replaced\s+with|now\s+us(?:e|ing)|using|adopting|upgraded\s+to|downgraded\s+to)\b/.test(lower)) {
    return { isDurable: true, strength: "strong", reason: "decision" };
  }
  if (/\b(prefer|like to|want to|enjoy|favorite|always use)\b/.test(lower)) {
    return { isDurable: true, strength: "strong", reason: "preference" };
  }
  if (/\b(must|cannot|can't|never|always|required|mandatory|forbidden)\b/.test(lower)) {
    return { isDurable: true, strength: "strong", reason: "constraint" };
  }
  if (/\b(the|our|we)\s+(project|codebase|system|app|api|database|server)\s+(is|uses?|has|requires?|needs?)\b/.test(lower)) {
    return { isDurable: true, strength: "medium", reason: "project-fact" };
  }
  if (/\b(version|release|deploy|launch)\s+(is|was|will be)\b/.test(lower)) {
    return { isDurable: true, strength: "medium", reason: "version" };
  }
  if (/\b(actually|wrong|incorrect|changed to|switched from|instead of|no longer|not .* but)\b/.test(lower)) {
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
  return text.trim().endsWith("?") || /\b(what|when|where|why|how|who|which)\b.*\?/.test(text);
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
