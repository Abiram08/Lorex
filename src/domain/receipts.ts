/** The Receipt contract returned by every operation, and the metadata schema version. */

export const METADATA_SCHEMA_VERSION = 2;

import type { CompressionStats } from "./compression.js";

export type Corpus = "memory" | "knowledge";
export type ModeUsed = "fast" | "thinking";

export type AbstentionReason =
  | "no_evidence"
  | "low_confidence"
  | "outside_time_window"
  | "unavailable"
  | "contradictory_evidence"
  | "ambiguous_entity"
  | "evidence_not_relevant";

export interface ReceiptSource {
  id: string;
  corpus: Corpus;
  excerpt: string;
  content: string;
  score?: number;
  valid_from?: string;
  valid_to?: string;
  source_ref?: string;
  fact_key?: string;
  status?: string;
  agent?: string;
  memory_type?: string;
  reason?: string;
}

export interface Receipt<T = unknown> {
  op: "recall" | "ingest" | "feedback" | "history" | "list" | "forget" | "usage";
  result?: T;
  sources: ReceiptSource[];
  mode_used: ModeUsed;
  request_id?: string;
  token_cost: number;
  abstained: boolean;
  abstention_reason?: AbstentionReason;
  confidence?: number;
  relevance?: number;
  unavailable?: boolean;
  queued?: boolean;
  as_of?: string;
  summary: string;
  answer?: string;
  context?: string;
  compression?: CompressionStats;
  disputes?: Array<{ factKey: string; versionIds: string[]; values: string[] }>;
}
