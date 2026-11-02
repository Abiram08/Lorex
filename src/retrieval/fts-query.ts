/** Pure FTS5 query planning: scoped, synonym-aware, conjunctive first. */

import type { StoreType } from "../infrastructure/store.js";

const SYNONYMS: Record<string, string> = {
  db: "database",
  postgres: "postgresql",
  psql: "postgresql",
  mongo: "mongodb",
  k8s: "kubernetes",
  js: "javascript",
  ts: "typescript",
  golang: "go",
  repo: "repository",
  auth: "authentication",
  config: "configuration",
  docs: "documentation",
  perf: "performance",
  deploy: "deployment",
};

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "for",
  "from", "had", "has", "have", "how", "i", "in", "is", "it", "of", "on", "or",
  "our", "the", "to", "was", "we", "were", "what", "when", "where", "which", "who",
  "why", "with", "you", "your",
]);

function termGroups(query: string): string[][] {
  const words = query
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
  return [...new Set(words)].map((word) => {
    const synonym = SYNONYMS[word];
    return synonym && synonym !== word ? [`${word}*`, `${synonym}*`] : [`${word}*`];
  });
}

function joinGroups(groups: string[][], operator: "AND" | "OR"): string {
  return groups
    .map((group) => group.length > 1 ? `(${group.join(" OR ")})` : group[0]!)
    .join(` ${operator} `);
}

function phrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Returns a precise plan followed by a recall-oriented fallback. */
export function planFtsQueries(
  query: string,
  collections: string[],
  type: StoreType | undefined,
): string[] {
  const groups = termGroups(query);
  if (!groups.length || !collections.length) return [];
  const collectionScope = collections.map((collection) => `collection:${phrase(collection)}`).join(" OR ");
  const corpusScope = type && type !== "all" ? ` AND corpus:${phrase(type)}` : "";
  const scoped = (terms: string) => `(${collectionScope})${corpusScope} AND (${terms})`;
  const precise = scoped(joinGroups(groups, "AND"));
  const fallback = scoped(joinGroups(groups, "OR"));
  return precise === fallback ? [precise] : [precise, fallback];
}
