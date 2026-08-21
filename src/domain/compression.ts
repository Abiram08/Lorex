/** Pack budget derivation and compression statistics. */

export const HAYSTACK_TOKEN_BASELINE = 115_000;

export const TARGET_COMPRESSION_RATIO = 46;

export const GUARANTEED_HAYSTACK_FLOOR = 80_000;

export const DEFAULT_CONTEXT_TOKEN_BUDGET = 1_700;

export const HARD_CONTEXT_TOKEN_CAP = 2_500;

export const MIN_CONTEXT_TOKEN_BUDGET = 384;

export const MIN_GUARANTEED_HAYSTACK = MIN_CONTEXT_TOKEN_BUDGET * TARGET_COMPRESSION_RATIO;

export const MAX_CONTEXT_PCT_OF_HAYSTACK = 5;

export interface CompressionStats {
  context_tokens: number;
  haystack_tokens: number;
  haystack_measured: boolean;
  context_pct: number;
  compression_ratio: number;
  target_ratio: number;
  meets_target: boolean;
  under_5_percent: boolean;
  summary: string;
}

export function budgetForHaystack(haystackTokens?: number): number {
  if (!haystackTokens || haystackTokens <= 0 || Number.isNaN(haystackTokens)) {
    return DEFAULT_CONTEXT_TOKEN_BUDGET;
  }
  const derived = Math.floor(haystackTokens / TARGET_COMPRESSION_RATIO);
  return Math.max(MIN_CONTEXT_TOKEN_BUDGET, Math.min(HARD_CONTEXT_TOKEN_CAP, derived));
}

export function computeCompression(
  contextTokens: number,
  haystackTokens?: number,
): CompressionStats {
  const measured = !!(haystackTokens && haystackTokens > 0);
  const ctx = Math.max(0, Math.round(contextTokens));
  const hay = Math.max(1, Math.round(measured ? haystackTokens! : HAYSTACK_TOKEN_BASELINE));
  const pct = (ctx / hay) * 100;
  const ratio = ctx > 0 ? hay / ctx : hay;
  const meets = ratio >= TARGET_COMPRESSION_RATIO - 1e-9;
  const under5 = pct <= MAX_CONTEXT_PCT_OF_HAYSTACK + 1e-9;

  const scale = measured ? "measured" : "assumed";
  return {
    context_tokens: ctx,
    haystack_tokens: hay,
    haystack_measured: measured,
    context_pct: Math.round(pct * 100) / 100,
    compression_ratio: Math.round(ratio * 10) / 10,
    target_ratio: TARGET_COMPRESSION_RATIO,
    meets_target: meets,
    under_5_percent: under5,
    summary: meets
      ? `Context pack ${ctx.toLocaleString()} tokens = ${pct.toFixed(2)}% of ${hay.toLocaleString()}-token ${scale} history (${ratio.toFixed(0)}× smaller, target ${TARGET_COMPRESSION_RATIO}×).`
      : `Context pack ${ctx.toLocaleString()} tokens = ${pct.toFixed(2)}% of ${hay.toLocaleString()}-token ${scale} history (${ratio.toFixed(1)}× — below ${TARGET_COMPRESSION_RATIO}× target).`,
  };
}

export function resolveContextBudget(
  requested?: number,
  haystackTokens?: number,
): number {
  const ceiling =
    haystackTokens && haystackTokens > 0
      ? Math.max(MIN_CONTEXT_TOKEN_BUDGET, budgetForHaystack(haystackTokens))
      : HARD_CONTEXT_TOKEN_CAP;

  if (requested === undefined || Number.isNaN(requested)) {
    return haystackTokens && haystackTokens > 0
      ? ceiling
      : Math.min(DEFAULT_CONTEXT_TOKEN_BUDGET, ceiling);
  }
  const n = Math.floor(requested);
  if (n < MIN_CONTEXT_TOKEN_BUDGET) return Math.min(MIN_CONTEXT_TOKEN_BUDGET, ceiling);
  return Math.min(n, ceiling);
}
