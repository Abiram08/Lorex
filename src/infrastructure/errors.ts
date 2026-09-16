/**
 * Domain error types for Lorex.
 *
 * Using typed errors instead of string messages makes catch blocks
 * more precise and diagnostics clearer.
 */

export class LorexError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LorexError";
  }
}

export class ConfigError extends LorexError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "CONFIG_ERROR", details);
    this.name = "ConfigError";
  }
}

export class StoreError extends LorexError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "STORE_ERROR", details);
    this.name = "StoreError";
  }
}

export class IngestionError extends LorexError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "INGESTION_ERROR", details);
    this.name = "IngestionError";
  }
}

export class QueryError extends LorexError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "QUERY_ERROR", details);
    this.name = "QueryError";
  }
}

export class NetworkError extends LorexError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "NETWORK_ERROR", details);
    this.name = "NetworkError";
  }
}
