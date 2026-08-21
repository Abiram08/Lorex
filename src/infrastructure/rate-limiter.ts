/** Persisted usage limiter: protects the HydraDB quota from runaway agents. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lorexHome } from "./paths.js";

export type OperationKind = "write" | "query" | "ingest_tokens";

export interface RateLimits {
  writesPerHour: number;
  writesPerDay: number;
  queriesPerHour: number;
  ingestTokensPerDay: number;
}

export const DEFAULT_LIMITS: RateLimits = {
  writesPerHour: 120,
  writesPerDay: 1_000,
  queriesPerHour: 240,
  ingestTokensPerDay: 2_000_000,
};

const USAGE_FILE = (): string => join(lorexHome(), "usage.json");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly kind: OperationKind,
    public readonly windowResetAt: number,
    public readonly limit: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }

  get resetInSeconds(): number {
    return Math.max(1, Math.ceil((this.windowResetAt - Date.now()) / 1000));
  }
}

export interface UsageState {
  hourStartedAt: number;
  dayStartedAt: number;
  writesThisHour: number;
  writesToday: number;
  queriesThisHour: number;
  ingestTokensToday: number;
}

function freshState(now: number): UsageState {
  return {
    hourStartedAt: now,
    dayStartedAt: now,
    writesThisHour: 0,
    writesToday: 0,
    queriesThisHour: 0,
    ingestTokensToday: 0,
  };
}

function isUnlimited(limits: RateLimits): boolean {
  return (
    limits.writesPerHour >= Number.MAX_SAFE_INTEGER ||
    limits.writesPerDay >= Number.MAX_SAFE_INTEGER ||
    limits.queriesPerHour >= Number.MAX_SAFE_INTEGER
  );
}

export class RateLimiter {
  private state: UsageState;

  constructor(
    public readonly limits: RateLimits = loadLimits(),
    private readonly persist = true,
    private readonly now: () => number = Date.now,
  ) {
    this.state = this.load();
  }

  /** Throws RateLimitError when the operation would exceed a configured cap. */
  check(kind: OperationKind, amount = 1): void {
    this.rollWindows(this.now());
    const s = this.state;

    if (kind === "write") {
      if (s.writesThisHour + amount > this.limits.writesPerHour) {
        throw new RateLimitError(
          `Lorex write limit reached (${this.limits.writesPerHour}/hour). ` +
            `Resets in ${this.resetIn(s.hourStartedAt + HOUR_MS)}s. ` +
            "Raise limits via LOREX_MAX_WRITES_PER_HOUR or wait before retrying.",
          kind,
          s.hourStartedAt + HOUR_MS,
          this.limits.writesPerHour,
        );
      }
      if (s.writesToday + amount > this.limits.writesPerDay) {
        throw new RateLimitError(
          `Lorex daily write budget reached (${this.limits.writesPerDay}/day). ` +
            `Resets in ${this.resetIn(s.dayStartedAt + DAY_MS)}s.`,
          kind,
          s.dayStartedAt + DAY_MS,
          this.limits.writesPerDay,
        );
      }
      return;
    }

    if (kind === "query") {
      if (s.queriesThisHour + amount > this.limits.queriesPerHour) {
        throw new RateLimitError(
          `Lorex query limit reached (${this.limits.queriesPerHour}/hour). ` +
            `Resets in ${this.resetIn(s.hourStartedAt + HOUR_MS)}s.`,
          kind,
          s.hourStartedAt + HOUR_MS,
          this.limits.queriesPerHour,
        );
      }
      return;
    }

    if (s.ingestTokensToday + amount > this.limits.ingestTokensPerDay) {
      throw new RateLimitError(
        `Lorex daily ingestion budget reached (${this.limits.ingestTokensPerDay} tokens/day). ` +
          `Resets in ${this.resetIn(s.dayStartedAt + DAY_MS)}s.`,
        kind,
        s.dayStartedAt + DAY_MS,
        this.limits.ingestTokensPerDay,
      );
    }
  }

  /** Consume quota after a successful check. */
  consume(kind: OperationKind, amount = 1): void {
    this.rollWindows(this.now());
    const s = this.state;
    if (kind === "write") {
      s.writesThisHour += amount;
      s.writesToday += amount;
    } else if (kind === "query") {
      s.queriesThisHour += amount;
    } else {
      s.ingestTokensToday += amount;
    }
    this.save();
  }

  /** Check-and-consume in one step. */
  acquire(kind: OperationKind, amount = 1): void {
    this.check(kind, amount);
    this.consume(kind, amount);
  }

  snapshot(): UsageState & { limits: RateLimits } {
    this.rollWindows(this.now());
    return { ...this.state, limits: this.limits };
  }

  private resetIn(resetAt: number): number {
    return Math.max(1, Math.ceil((resetAt - this.now()) / 1000));
  }

  private rollWindows(now: number): void {
    const s = this.state;
    if (now - s.hourStartedAt >= HOUR_MS) {
      s.hourStartedAt = now;
      s.writesThisHour = 0;
      s.queriesThisHour = 0;
    }
    if (now - s.dayStartedAt >= DAY_MS) {
      s.dayStartedAt = now;
      s.writesToday = 0;
      s.ingestTokensToday = 0;
    }
  }

  private load(): UsageState {
    if (!this.persist || isUnlimited(this.limits) || !existsSync(USAGE_FILE())) {
      return freshState(this.now());
    }
    try {
      const parsed = JSON.parse(readFileSync(USAGE_FILE(), "utf8")) as Partial<UsageState>;
      // Clamp to the configured caps: a persisted counter can exceed them when
      // limits were lowered (or a previous run had them disabled) — without
      // this, one poisoned file locks the tool until the window rolls.
      return {
        ...freshState(this.now()),
        ...parsed,
        writesThisHour: Math.min(parsed.writesThisHour ?? 0, this.limits.writesPerHour),
        writesToday: Math.min(parsed.writesToday ?? 0, this.limits.writesPerDay),
        queriesThisHour: Math.min(parsed.queriesThisHour ?? 0, this.limits.queriesPerHour),
        ingestTokensToday: Math.min(parsed.ingestTokensToday ?? 0, this.limits.ingestTokensPerDay),
      };
    } catch {
      return freshState(this.now());
    }
  }

  private save(): void {
    // Unlimited runs (tests, benchmarks) must not record consumption into the
    // shared usage file — it would throttle the next limited run.
    if (!this.persist || isUnlimited(this.limits)) return;
    try {
      mkdirSync(lorexHome(), { recursive: true });
      writeFileSync(USAGE_FILE(), JSON.stringify(this.state), { mode: 0o600 });
    } catch {
    }
  }
}

export function loadLimits(): RateLimits {
  if (process.env.LOREX_NO_LIMITS === "1") {
    return {
      writesPerHour: Number.MAX_SAFE_INTEGER,
      writesPerDay: Number.MAX_SAFE_INTEGER,
      queriesPerHour: Number.MAX_SAFE_INTEGER,
      ingestTokensPerDay: Number.MAX_SAFE_INTEGER,
    };
  }
  const num = (v: string | undefined, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    writesPerHour: num(process.env.LOREX_MAX_WRITES_PER_HOUR, DEFAULT_LIMITS.writesPerHour),
    writesPerDay: num(process.env.LOREX_MAX_WRITES_PER_DAY, DEFAULT_LIMITS.writesPerDay),
    queriesPerHour: num(process.env.LOREX_MAX_QUERIES_PER_HOUR, DEFAULT_LIMITS.queriesPerHour),
    ingestTokensPerDay: num(process.env.LOREX_MAX_INGEST_TOKENS_PER_DAY, DEFAULT_LIMITS.ingestTokensPerDay),
  };
}
