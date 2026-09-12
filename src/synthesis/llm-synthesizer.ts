/** Opt-in LLM synthesis: evidence pack -> grounded answer with citations.
 *
 * Uses any OpenAI-compatible chat endpoint (OpenRouter, Together, a local
 * Ollama, Gemini's OpenAI-compatible surface). Configured entirely via env:
 *   LOREX_LLM_BASE_URL  — e.g. https://openrouter.ai/api/v1  (required)
 *   LOREX_LLM_API_KEY   — bearer token (default "local" for Ollama)
 *   LOREX_SYNTH_MODEL   — model id (default "gpt-4o-mini")
 *
 * No SDK dependency: a plain fetch call. When unconfigured or failing,
 * callers silently fall back to deterministic synthesis. */

import type { Evidence } from "../domain/evidence.js";
import { countTokens } from "../ingestion/token-counter.js";

const SYNTH_TIMEOUT_MS = 30_000;

export interface SynthesisConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function resolveSynthesisConfig(): SynthesisConfig | null {
  const baseUrl = (process.env.LOREX_LLM_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) return null;
  const apiKey = (process.env.LOREX_LLM_API_KEY ?? "local").trim() || "local";
  const model = (process.env.LOREX_SYNTH_MODEL ?? "").trim() || "gpt-4o-mini";
  return { baseUrl, apiKey, model };
}

export interface SynthesisResult {
  answer: string;
  model: string;
  citedIds: string[];
  /** Sentences whose citations did not resolve to a returned source. */
  droppedClaims: string[];
}

const SYSTEM = `You answer questions using ONLY the numbered evidence excerpts provided.
Rules:
- Cite sources inline as [1], [2] matching the excerpt numbers.
- If the evidence does not contain the answer, reply exactly: NOT_IN_MEMORY
- Do not use outside knowledge. Do not speculate. Be concise (2-4 sentences).`;

export async function synthesizeGroundedAnswer(
  query: string,
  evidence: Evidence[],
  cfg: SynthesisConfig,
): Promise<SynthesisResult> {
  const usable = evidence.filter((e) => (e.content ?? "").trim().length > 0).slice(0, 10);
  if (!query?.trim() || usable.length === 0) throw new Error("nothing to synthesize from");

  const pack = usable
    .map((e, i) => {
      const date = e.validFrom ?? e.occurredAt ? `[${e.validFrom ?? e.occurredAt}] ` : "";
      const agent = e.agent ? `(via ${e.agent}) ` : "";
      const body = countTokens(e.content) > 400 ? e.excerpt : e.content;
      return `[${i + 1}] ${date}${agent}${body}`;
    })
    .join("\n\n");

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Evidence:\n\n${pack}\n\nQuestion: ${query}` },
      ],
      max_tokens: 512,
      temperature: 0,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`synthesis LLM ${res.status}: ${body.slice(0, 200)}`);
  }

  const j = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = (j.choices?.[0]?.message?.content ?? "").trim();
  if (!raw) throw new Error("synthesis returned no text");
  if (/^NOT_IN_MEMORY\b/i.test(raw)) {
    throw new Error("model judged the evidence insufficient");
  }

  // Per-sentence grounding post-check: every sentence must carry at least one
  // citation resolving to a returned source; ungrounded prose is dropped, and
  // an answer with nothing left to stand on fails entirely.
  const usableIds = new Set(usable.map((e) => e.id));
  const sentences = raw.match(/[^.!?\n]+[.!?]?/g)?.map((s) => s.trim()).filter(Boolean) ?? [raw];
  const kept: string[] = [];
  const droppedClaims: string[] = [];
  for (const sentence of sentences) {
    const refs = [...sentence.matchAll(/\[(\d+)\]/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n >= 1 && n <= usable.length && usableIds.has(usable[n - 1]!.id));
    if (refs.length > 0) kept.push(sentence);
    else droppedClaims.push(sentence);
  }
  if (kept.length === 0) {
    throw new Error("no sentence carried a resolvable citation");
  }

  const cited = [...kept.join(" ").matchAll(/\[(\d+)\]/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n >= 1 && n <= usable.length);

  return {
    answer: kept.join(" "),
    model: cfg.model,
    citedIds: [...new Set(cited)].map((n) => usable[n - 1]!.id),
    droppedClaims,
  };
}
