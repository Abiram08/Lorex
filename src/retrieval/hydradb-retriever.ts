/** HydraDB query wrapper with error classification. */

import type { HydraDBLike, QueryInput, QueryResult, QueryChunk } from "../infrastructure/hydradb-client.js";
import { HydraDBError } from "../infrastructure/hydradb-client.js";

export interface RetrieveOptions {
  database: string;
  collection: string;
  query: string;
  mode?: "fast" | "thinking";
  type?: "memory" | "knowledge" | "all";
  maxResults?: number;
  asOf?: string;
  recencyBias?: number;
}

export interface RetrieveResult {
  chunks: QueryChunk[];
  requestId: string;
  latencyMs: number;
  totalFound: number;
  graphContext?: QueryResult["graphContext"];
  unavailable?: boolean;
  error?: { kind: string; message: string };
}

export async function retrieve(
  client: HydraDBLike,
  options: RetrieveOptions,
): Promise<RetrieveResult> {
  const input: QueryInput = {
    database: options.database,
    collection: options.collection,
    query: options.query,
    mode: options.mode ?? "fast",
    type: options.type ?? "all",
    max_results: options.maxResults ?? 15,
    recency_bias: options.recencyBias ?? 0.2,
    graph_context: options.mode === "thinking",
    query_forceful_relations: options.mode === "thinking",
  };

  if (options.asOf) {
    input.metadata_filters = { as_of: options.asOf };
    input.recency_bias = 0;
  }

  try {
    const result = await client.query(input);

    return {
      chunks: result.chunks,
      requestId: result.requestId,
      latencyMs: result.latencyMs,
      totalFound: result.chunks.length,
      graphContext: result.graphContext,
    };
  } catch (error) {
    if (error instanceof HydraDBError) {
      if (error.kind === "network") {
        return {
          chunks: [],
          requestId: "",
          latencyMs: 0,
          totalFound: 0,
          unavailable: true,
          error: { kind: error.kind, message: error.message },
        };
      }
      if (error.kind === "auth") {
        throw error;
      }
      if (error.kind === "rate_limit") {
        throw error;
      }
      if (error.kind === "client") {
        throw error;
      }
      if (error.kind === "server") {
        return {
          chunks: [],
          requestId: error.code ?? "",
          latencyMs: 0,
          totalFound: 0,
          unavailable: true,
          error: { kind: error.kind, message: error.message },
        };
      }
    }

    throw error;
  }
}
