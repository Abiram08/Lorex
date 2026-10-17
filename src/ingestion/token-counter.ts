/** Token counting, truncation, and splitting via the cl100k_base tokenizer. */

import { getEncoding, type Tiktoken } from "js-tiktoken";

export const TOKENIZER_ENCODING = "cl100k_base" as const;

let encoder: Tiktoken | null = null;
function enc(): Tiktoken {
  if (!encoder) encoder = getEncoding(TOKENIZER_ENCODING);
  return encoder;
}

const CACHE_LIMIT = 4_000;
const cache = new Map<string, number>();

export function countTokens(text: string): number {
  if (!text) return 0;

  if (text.length <= 2_000) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const n = enc().encode(text).length;
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(text, n);
    return n;
  }

  return enc().encode(text).length;
}

export function countTokensMultiple(texts: string[]): number {
  return texts.reduce((sum, text) => sum + countTokens(text), 0);
}

export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  const e = enc();
  const tokens = e.encode(text);
  if (tokens.length <= maxTokens) return text;
  return e.decode(tokens.slice(0, Math.max(0, maxTokens - 1))) + "…";
}

export function splitIntoTokenChunks(text: string, tokensPerChunk: number): string[] {
  if (tokensPerChunk <= 0) return [text];
  const e = enc();
  const tokens = e.encode(text);
  const chunks: string[] = [];
  for (let i = 0; i < tokens.length; i += tokensPerChunk) {
    chunks.push(e.decode(tokens.slice(i, i + tokensPerChunk)));
  }
  return chunks.length ? chunks : [text];
}
