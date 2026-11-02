/**
 * Session-start context pack: turn recalled sources into a small, typed,
 * deterministic block of text an agent harness can inject.
 *
 * Everything here is pure retrieval plus formatting — no model calls, no
 * network, no API key. Ordering is whatever retrieval already decided; this
 * module groups by memory type, drops near-duplicates, and stops at the token
 * budget.
 */

import type { ReceiptSource } from "../domain/receipts.js";
import { countTokens } from "../ingestion/token-counter.js";

/** Display order and labels for known memory types; unknown types fall to the end. */
const SECTIONS: Array<{ type: string; label: string }> = [
  { type: "decision", label: "Decisions" },
  { type: "constraint", label: "Constraints" },
  { type: "preference", label: "Preferences" },
  { type: "correction", label: "Corrections" },
  { type: "episode", label: "Recent agent-reported outcomes" },
  { type: "handoff", label: "Handoffs" },
  { type: "task", label: "Open tasks" },
  { type: "fact", label: "Facts" },
];

const KNOWN_TYPES = new Set(SECTIONS.map((s) => s.type));

export interface BuiltPack {
  /** The block of text to inject; empty when nothing was packed. */
  text: string;
  tokens: number;
  usedSources: ReceiptSource[];
  sections: Array<{ memoryType: string; label: string; count: number }>;
  memoryCount: number;
  knowledgeCount: number;
  truncated: boolean;
}

export interface BuildContextPackInput {
  label: string;
  query?: string;
  header?: string;
  sources: ReceiptSource[];
  maxTokens: number;
}

/** Deduplicate by normalized prefix — the pack should never repeat itself. */
function dedupeKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 160);
}

function describe(source: ReceiptSource): string {
  const bits: string[] = [];
  if (source.valid_from) bits.push(String(source.valid_from).slice(0, 10));
  if (source.agent && source.agent !== "unknown") bits.push(`via ${source.agent}`);
  if (source.trust === "assistant_report") bits.push("agent report; verify if critical");
  if (source.trust === "inferred_pattern") bits.push("inferred pattern");
  if (source.source_ref) bits.push(String(source.source_ref).slice(0, 60));
  return bits.length ? ` _(${bits.join(" · ")})_` : "";
}

/**
 * Build the injectable pack. Memories are grouped by type and always precede
 * raw knowledge, which is appended as reference material only while budget
 * remains — a distilled fact is worth more of the window than the transcript
 * it came from.
 */
export function buildContextPack(input: BuildContextPackInput): BuiltPack {
  const { label, query, header, sources, maxTokens } = input;

  const memoryGroups = new Map<string, ReceiptSource[]>();
  const knowledge: ReceiptSource[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    const text = (source.content || source.excerpt || "").trim();
    if (!text) continue;
    const key = dedupeKey(text);
    if (seen.has(key)) continue;
    seen.add(key);

    if (source.corpus === "knowledge") {
      knowledge.push(source);
      continue;
    }
    const type = source.memory_type && KNOWN_TYPES.has(source.memory_type)
      ? source.memory_type
      : source.memory_type && source.memory_type !== "conversation_chunk"
        ? source.memory_type
        : "fact";
    const group = memoryGroups.get(type) ?? [];
    group.push(source);
    memoryGroups.set(type, group);
  }

  const heading = [`# Project memory (Lorex · ${label})`];
  if (header) heading.push(header);
  if (query) heading.push(`Relevant to: ${query}`);
  const preamble = heading.join("\n") + "\n";

  const preambleTokens = countTokens(preamble);
  let usedTokens = preambleTokens;
  let body = "";
  let truncated = false;
  const used: ReceiptSource[] = [];
  const sections: Array<{ memoryType: string; label: string; count: number }> = [];
  let memoryCount = 0;
  let knowledgeCount = 0;

  const orderedTypes = [
    ...SECTIONS.map((s) => s.type).filter((t) => memoryGroups.has(t)),
    ...[...memoryGroups.keys()].filter((t) => !KNOWN_TYPES.has(t)).sort(),
  ];

  for (const type of orderedTypes) {
    const label_ = SECTIONS.find((s) => s.type === type)?.label ?? type;
    let block = "";
    let blockTokens = 0;
    let count = 0;

    for (const source of memoryGroups.get(type) ?? []) {
      const line = `- ${(source.content || source.excerpt).trim()}${describe(source)}\n`;
      const cost = countTokens(line);
      if (usedTokens + countTokens(`\n## ${label_}\n`) + blockTokens + cost > maxTokens) {
        truncated = true;
        break;
      }
      block += line;
      blockTokens += cost;
      count++;
      used.push(source);
      memoryCount++;
    }

    if (count > 0) {
      body += `\n## ${label_}\n${block}`;
      usedTokens += countTokens(`\n## ${label_}\n`) + blockTokens;
      sections.push({ memoryType: type, label: label_, count });
    }
  }

  // Reference material last, and only what still fits.
  if (knowledge.length && usedTokens < maxTokens) {
    let block = "";
    let blockTokens = 0;
    let count = 0;
    for (const source of knowledge) {
      const excerpt = (source.content || source.excerpt).trim().slice(0, 600);
      const line = `- ${excerpt}${describe(source)}\n`;
      const cost = countTokens(line);
      if (usedTokens + countTokens("\n## Reference\n") + blockTokens + cost > maxTokens) {
        truncated = true;
        break;
      }
      block += line;
      blockTokens += cost;
      count++;
      used.push(source);
      knowledgeCount++;
    }
    if (count > 0) {
      body += `\n## Reference\n${block}`;
      usedTokens += countTokens("\n## Reference\n") + blockTokens;
      sections.push({ memoryType: "knowledge", label: "Reference", count });
    }
  }

  if (used.length === 0) {
    return {
      text: "",
      tokens: 0,
      usedSources: [],
      sections: [],
      memoryCount: 0,
      knowledgeCount: 0,
      truncated: false,
    };
  }

  const text = preamble + body;
  return {
    text,
    tokens: countTokens(text),
    usedSources: used,
    sections,
    memoryCount,
    knowledgeCount,
    truncated,
  };
}
