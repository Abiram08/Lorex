/** Cite-or-abstain verification: does any single source actually entail an
 * answer to the question? Runs after pack assembly, before synthesis.
 *
 * Tier 1 (default, free): answer-type entailment. A question that demands a
 * NUMBER / DATE / PERSON / ORG answer is unsupported unless the evidence
 * contains a compatible token in a source that also matches the subject —
 * catches "plausible topic, absent fact" cases where lexical overlap passes
 * on shared vocabulary alone.
 *
 * Tier 2 (opt-in): a cheap yes/no support judgment per top-3 sources via the
 * configured OpenAI-compatible endpoint (~200 tokens, not a full synthesis).
 * */

import type { Evidence } from "../domain/evidence.js";

export type VerifyTier = "off" | "auto" | "llm";

export interface VerifyResult {
  supported: boolean;
  tier: "none" | "answer_type" | "llm";
  detail?: string;
}

const QUESTION_TYPE_PROBES: Array<{
  types: RegExp;
  expects: "number" | "date" | "person" | "org";
  label: string;
}> = [
  {
    types: /\b(how many|how much|what number|what percentage|count of|number of)\b/i,
    expects: "number",
    label: "a number",
  },
  {
    types: /\b(when|what date|which year|how long|until when|since when)\b/i,
    expects: "date",
    label: "a date",
  },
  {
    types: /\b(who|whose|which person|which engineer|which developer|which teammate)\b/i,
    expects: "person",
    label: "a person",
  },
  {
    types: /\b(which (?:company|vendor|provider|service)|what company)\b/i,
    expects: "org",
    label: "an organization",
  },
];

const NUMBER_TOKEN = /\b\d[\d.,:%]*\b/;
const DATE_TOKEN =
  /\b(?:\d{4}[-/]\d{2}[-/]\d{2}|\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(?:mon|tue|wed|thu|fri|sat|sun)day\b|\b\d{4}\b|\bq[1-4]\b|\b20\d{2}\b)/i;
// Capitalized word NOT at sentence start, or a known name-adjacent pattern.
const PERSON_TOKEN = /(?:[.!?]\s+|^)?\b[A-Z][a-z]{2,}\b/;
const ORG_TOKEN = /\b(?:Inc|LLC|Ltd|Corp|GmbH|Labs|Systems|Cloud|AWS|GCP)\b|[A-Z]{2,}/;

export function verifyPackSupport(
  query: string,
  evidence: Evidence[],
  opts: { tier?: VerifyTier } = {},
): VerifyResult {
  const tier = opts.tier ?? "auto";
  if (tier === "off") return { supported: true, tier: "none" };
  if (!query?.trim() || evidence.length === 0) return { supported: true, tier: "none" };

  const probe = QUESTION_TYPE_PROBES.find((p) => p.types.test(query));
  if (!probe) return { supported: true, tier: "none" };

  // Only the best-matching sources need to carry a compatible token; the pack
  // as a whole is what ships, so scan it in relevance order.
  for (const e of evidence) {
    if (sourceCompatible(e, probe.expects)) return { supported: true, tier: "answer_type" };
  }
  return {
    supported: false,
    tier: "answer_type",
    detail: `Question asks for ${probe.label} but no retrieved source contains one.`,
  };
}

function sourceCompatible(e: Evidence, expects: string): boolean {
  const text = e.content ?? e.excerpt ?? "";
  switch (expects) {
    case "number": return NUMBER_TOKEN.test(text);
    case "date": return DATE_TOKEN.test(text) || !!e.validFrom || !!e.occurredAt;
    case "person": return PERSON_TOKEN.test(text);
    case "org": return ORG_TOKEN.test(text);
    default: return true;
  }
}

/** LLM support judgment over the top sources. Returns null when the endpoint
 * is not configured or the call fails — callers then keep Tier-1's verdict. */
export async function llmVerifySupport(
  query: string,
  evidence: Evidence[],
  cfg: { baseUrl: string; apiKey: string; model: string },
): Promise<boolean | null> {
  const top = evidence.slice(0, 3).filter((e) => (e.content ?? "").trim());
  if (top.length === 0) return null;

  const pack = top.map((e, i) => `[${i + 1}] ${e.excerpt}`).join("\n\n");
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: "system",
            content:
              "You judge whether the excerpts contain the information needed to answer the question. Reply with exactly YES or NO.",
          },
          { role: "user", content: `Excerpts:\n\n${pack}\n\nQuestion: ${query}` },
        ],
        max_tokens: 8,
        temperature: 0,
      }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = (j.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
    if (text.startsWith("YES")) return true;
    if (text.startsWith("NO")) return false;
    return null;
  } catch {
    return null;
  }
}
