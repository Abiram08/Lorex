/** Fact identity: topic keys, version ids, memory-type classification. */

import { createHash } from "node:crypto";

export type MemoryType =
  | "fact"
  | "decision"
  | "preference"
  | "constraint"
  | "task"
  | "correction";

export type FactStatus = "current" | "superseded" | "disputed" | "forgotten";

export interface FactVersion {
  factKey: string;
  versionId: string;
  value: string;
  memoryType: MemoryType;
  validFrom: string;
  validTo?: string;
  recordedAt: string;
  supersedes?: string;
  evidenceIds: string[];
  status: FactStatus;
  sourceRef?: string;
  confidence: number;
}

export interface FactChain {
  factKey: string;
  versions: FactVersion[];
  currentVersion?: FactVersion;
  isDisputed: boolean;
  timeline: FactVersion[];
}

const STOP_TOPIC = new Set([
  "to", "the", "a", "an", "our", "my", "we", "i", "for", "with", "from", "into",
  "on", "in", "at", "of", "and", "or", "as", "be", "is", "are", "was", "were",
  "this", "that", "it", "now", "then", "also", "just", "only", "very", "more",
]);

const SUBJECT_NOUNS: string[] = [
  "session storage", "state management", "package manager", "cloud provider",
  "message queue", "job queue", "ci pipeline", "build system", "error tracking",
  "session store", "object storage", "search engine", "feature flags",
  "database", "language", "framework", "frontend", "backend", "runtime",
  "hosting", "deployment", "monitoring", "logging", "testing", "styling",
  "payments", "billing", "email", "analytics", "storage", "caching", "cache",
  "queue", "auth", "authentication", "editor", "linter", "orm", "cdn",
];

const VALUE_PATTERNS: RegExp[] = [
  /\b(?:switch(?:ing|ed)?|migrat(?:ing|ed)|mov(?:ing|ed)|chang(?:ing|ed))\s+to\s+([a-z0-9][\w.+#-]{1,40})/i,
  /\b(?:decided?|chose|selected|adopting|using|use)\s+(?:to\s+use\s+)?([a-z0-9][\w.+#-]{1,40})/i,
  /\b(?:going with|prefer|always use)\s+([a-z0-9][\w.+#-]{1,40})/i,
];

export function generateTopicKey(text: string, explicitId?: string): string {
  if (explicitId?.trim()) {
    return sanitizeKey(explicitId.trim());
  }

  const lower = text.toLowerCase();

  for (const re of SUBJECT_PATTERNS) {
    const phrase = lower.match(re)?.[1];
    const key = phraseToKey(phrase);
    if (key) return key;
  }

  if (hasDecisionSignal(lower)) {
    for (const subject of SUBJECT_NOUNS) {
      if (new RegExp(`\\b${subject.replace(/\s+/g, "\\s+")}\\b`).test(lower)) {
        return sanitizeKey(`topic_${subject.replace(/\s+/g, "_")}`);
      }
    }
  }

  for (const re of VALUE_PATTERNS) {
    const raw = lower.match(re)?.[1];
    if (!raw) continue;
    const topic = raw.replace(/[^a-z0-9.+#-]/gi, "").slice(0, 40);
    if (topic.length >= 2 && !STOP_TOPIC.has(topic)) {
      return sanitizeKey(`topic_${normalizeTopicAlias(topic)}`);
    }
  }

  return generateContentKey(text);
}

const NOUN_PHRASE = "[a-z][a-z-]{2,20}(?:\\s+[a-z][a-z-]{2,20}){0,2}";

const SUBJECT_PATTERNS: RegExp[] = [
  new RegExp(
    `\\b(?:switch(?:ed|ing)?|migrat(?:ed|ing)|mov(?:ed|ing)|chang(?:ed|ing))\\s+(?:our|the|my)\\s+(${NOUN_PHRASE})\\s+to\\b`,
  ),
  new RegExp(`\\b(?:for|as)\\s+(?:our|the|my|its)\\s+(${NOUN_PHRASE})\\b`),
  /\b(?:for|as)\s+([a-z][a-z-]{2,20}(?:\s+[a-z][a-z-]{2,20}){1,2})\b/,
  new RegExp(`\\b(?:our|the|my)\\s+(${NOUN_PHRASE})\\s+(?:is|are|was|were|will\\s+be|remains|stays)\\b`),
];

const CLAUSE_BREAK = new Set([
  "because", "since", "due", "so", "when", "while", "after", "before", "until",
  "though", "although", "unless", "whereas", "and", "but", "or", "then", "now",
  "instead", "rather", "which", "that", "who", "where",
]);

function phraseToKey(phrase?: string): string | undefined {
  if (!phrase) return undefined;

  const words: string[] = [];
  for (const word of phrase.split(/\s+/)) {
    if (!word) continue;
    if (CLAUSE_BREAK.has(word)) break;
    if (STOP_TOPIC.has(word)) continue;
    words.push(word);
  }

  if (words.length === 0) return undefined;
  if (words.length === 1 && words[0]!.length < 4) return undefined;
  return sanitizeKey(`topic_${words.join("_")}`);
}

function hasDecisionSignal(lower: string): boolean {
  return /\b(decided?|chose|selected|going with|switch(?:ed|ing)?\s+to|migrat(?:ed|ing)\s+to|mov(?:ed|ing)\s+to|replaced\s+with|now\s+us(?:e|ing)|adopting|prefer|always use|must|required)\b/.test(
    lower,
  );
}

function normalizeTopicAlias(topic: string): string {
  const t = topic.toLowerCase();
  if (t === "postgresql" || t === "psql") return "postgres";
  if (t === "js") return "javascript";
  if (t === "ts") return "typescript";
  if (t === "golang") return "go";
  if (t === "k8s") return "kubernetes";
  if (t === "mongo") return "mongodb";
  return t;
}

export function generateContentKey(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  const slug = normalized
    .split(/\s+/)
    .slice(0, 3)
    .join("_")
    .replace(/[^\w]/g, "")
    .slice(0, 24);
  return sanitizeKey(`fact_${slug || "x"}_${hash}`);
}

let versionCounter = 0;

export function makeVersionId(factKey: string, at = Date.now()): string {
  versionCounter = (versionCounter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${factKey}_v${at}_${versionCounter.toString(36)}${rand}`;
}

export function sanitizeKey(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9_.:-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 120) || "fact_unknown"
  );
}

export function classifyMemoryType(text: string): MemoryType {
  const lower = text.toLowerCase();
  if (/\b(decided?|chose|selected|going with|switch(?:ed|ing)?\s+to|migrat(?:ed|ing)\s+to|mov(?:ed|ing)\s+to|replaced\s+with|now\s+us(?:e|ing)|using|adopting|upgraded\s+to|downgraded\s+to)\b/.test(lower)) {
    return "decision";
  }
  if (/\b(prefer|like to|want to|enjoy|favorite|always use)\b/.test(lower)) {
    return "preference";
  }
  if (/\b(must|cannot|can't|never|always|required|mandatory|forbidden)\b/.test(lower)) {
    return "constraint";
  }
  if (/\b(need to|should|will|going to|todo|fix|implement|build|create)\b/.test(lower)) {
    return "task";
  }
  if (/\b(actually|wrong|incorrect|changed to|instead of|not .* but)\b/.test(lower)) {
    return "correction";
  }
  return "fact";
}

export function extractAtomicValue(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 280) return trimmed;

  const sentences = trimmed.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (detectDurableSentence(s)) return s.trim().slice(0, 400);
  }
  return trimmed.slice(0, 400);
}

function detectDurableSentence(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    /\b(decided?|chose|selected|using|prefer|must|cannot|switch(?:ed|ing)|migrated|replaced|required)\b/.test(lower) &&
    text.length >= 20
  );
}
