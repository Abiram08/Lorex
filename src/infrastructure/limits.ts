/** Payload and safety limits shared by the engine, CLI, and MCP server. */

import {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  HARD_CONTEXT_TOKEN_CAP,
  HAYSTACK_TOKEN_BASELINE,
} from "../domain/compression.js";

export const LIMITS = {
  maxFactChars: 8_000,
  maxContentChars: 200_000,
  maxSessionTurns: 2_000,
  maxTurnChars: 50_000,
  maxQueryChars: 4_000,
  maxResults: 50,
  haystackTokenBaseline: HAYSTACK_TOKEN_BASELINE,
  defaultContextTokens: DEFAULT_CONTEXT_TOKEN_BUDGET,
  maxContextTokens: HARD_CONTEXT_TOKEN_CAP,
  maxTokensBudget: HARD_CONTEXT_TOKEN_CAP,
  maxIdChars: 200,
  maxSourceRefChars: 500,
  databaseReadyMaxAttempts: 15,
  databaseReadyIntervalMs: 1_000,
  indexMaxAttempts: 60,
  indexIntervalMs: 1_000,
  indexWaitMsCap: 60_000,
} as const;

export function assertMaxLength(label: string, value: string, max: number): void {
  if (value.length > max) {
    throw new Error(`${label} exceeds max length (${value.length} > ${max})`);
  }
}

export function clampInt(n: number | undefined, fallback: number, min: number, max: number): number {
  if (n === undefined || Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
