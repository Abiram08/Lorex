/**
 * Memory lifecycle engine.
 *
 * Manages how memories evolve over time:
 * - Time-decay scoring (90-day half-life)
 * - Type-based lifecycle (episodes decay, preferences strengthen, facts persist)
 * - Confidence reinforcement (recalled facts gain strength)
 * - TTL/expiry enforcement (expired memories filtered)
 * - Staleness tagging (age-based labels for display)
 *
 * Inspired by:
 * - Memoria: time-decay scoring (90-day half-life)
 * - pi-memory: staleness tags (30d = old, 90d = warning)
 * - agent-memory: lessons with confidence decay
 * - Supermemory: episodic decay, preference strengthening
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Half-life in days for time-decay scoring. */
export const HALF_LIFE_DAYS = 90;

/** Minimum strength before a memory is considered stale. */
export const STALE_THRESHOLD = 0.15;

/** Strength below which memories are pruned during consolidation. */
export const PRUNE_THRESHOLD = 0.05;

/** Strength boost when a memory is recalled or reinforced. */
export const REINFORCEMENT_BOOST = 0.3;

/** Maximum strength cap. */
export const MAX_STRENGTH = 1.0;

/** Episode decay rate: episodes lose strength faster than generic decay. */
export const EPISODE_DECAY_MULTIPLIER = 2.0;

/** Preference boost rate: preferences gain strength when repeated. */
export const PREFERENCE_BOOST_RATE = 0.1;

/** TTL defaults per memory type (in days). null = no expiry. */
export const TTL_DAYS: Record<string, number | null> = {
  fact: null,        // facts persist until updated
  decision: null,    // decisions persist (historical record)
  preference: null,  // preferences persist (strengthen with use)
  constraint: null,  // constraints persist
  task: 30,          // tasks expire after 30 days
  correction: 180,   // corrections last 180 days
  episode: 30,       // episodes expire after 30 days
  lesson: null,      // lessons persist (decay via confidence, not TTL)
};

// ── Scoring ──────────────────────────────────────────────────────────────────

/**
 * Calculate time-decay strength based on age.
 * Uses exponential decay with configurable half-life.
 *
 * @param createdAt ISO timestamp of when the memory was created
 * @param halfLifeDays number of days before strength halves (default: 90)
 * @returns strength between 0 and 1
 */
export function timeDecayStrength(createdAt: string, halfLifeDays: number = HALF_LIFE_DAYS): number {
  const ageMs = Date.now() - Date.parse(createdAt);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * Calculate strength for a specific memory type.
 * Applies type-specific decay/boost modifiers on top of base time decay.
 *
 * @param createdAt ISO timestamp
 * @param memoryType the type of memory
 * @param accessCount how many times the memory has been accessed
 * @param lastAccessed ISO timestamp of last access (null = never accessed)
 * @returns strength between 0 and 1
 */
export function memoryStrength(
  createdAt: string,
  memoryType: string | null,
  accessCount: number = 0,
  _lastAccessed: string | null = null,
): number {
  const base = timeDecayStrength(createdAt);

  switch (memoryType) {
    case "episode":
      // Episodes decay faster than base rate
      return Math.min(MAX_STRENGTH, base * EPISODE_DECAY_MULTIPLIER > 1 ? 1 : base * (1 / EPISODE_DECAY_MULTIPLIER));

    case "preference":
      // Preferences strengthen with repetition, never fully decay
      return Math.min(MAX_STRENGTH, base + (accessCount * PREFERENCE_BOOST_RATE));

    case "lesson":
      // Lessons decay via confidence, but base time decay is gentle
      return Math.min(MAX_STRENGTH, Math.pow(base, 0.5));

    case "fact":
    case "decision":
    case "constraint":
      // Facts, decisions, constraints: standard decay
      return base;

    case "correction":
      // Corrections decay slower than episodes but faster than facts
      return Math.pow(base, 0.7);

    case "task":
      // Tasks decay fast (ephemeral)
      return Math.pow(base, 1.5);

    default:
      return base;
  }
}

/**
 * Calculate reinforced strength: base strength + reinforcement boost,
 * capped at MAX_STRENGTH.
 *
 * Called when a memory is recalled, repeated, or explicitly reinforced.
 */
export function reinforcedStrength(currentStrength: number): number {
  return Math.min(MAX_STRENGTH, currentStrength + REINFORCEMENT_BOOST);
}

// ── Staleness Tags ───────────────────────────────────────────────────────────

export type StalenessTag = "fresh" | "recent" | "aging" | "stale" | "expired";

/**
 * Determine staleness tag based on age.
 * Used for display in CLI/dashboard.
 *
 * - fresh: < 7 days
 * - recent: 7-30 days
 * - aging: 30-90 days
 * - stale: 90-180 days
 * - expired: > 180 days
 */
export function stalenessTag(createdAt: string): StalenessTag {
  const ageMs = Date.now() - Date.parse(createdAt);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays < 7) return "fresh";
  if (ageDays < 30) return "recent";
  if (ageDays < 90) return "aging";
  if (ageDays < 180) return "stale";
  return "expired";
}

/**
 * Format staleness as a human-readable string.
 * e.g., "3d ago", "90d ago — warning"
 */
export function stalenessLabel(createdAt: string): string {
  const ageMs = Date.now() - Date.parse(createdAt);
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
  const tag = stalenessTag(createdAt);

  if (ageDays === 0) return "today";
  const label = ageDays === 1 ? "1d ago" : `${ageDays}d ago`;

  if (tag === "stale") return `${label} — warning`;
  if (tag === "expired") return `${label} — expired`;
  return label;
}

// ── TTL / Expiry ─────────────────────────────────────────────────────────────

/**
 * Check if a memory has expired based on its type-specific TTL.
 *
 * @param createdAt ISO timestamp
 * @param memoryType type of memory
 * @param ttlOverrides optional override for TTL days per type
 * @returns true if the memory should be considered expired
 */
export function isExpired(
  createdAt: string,
  memoryType: string | null,
  ttlOverrides?: Record<string, number | null>,
): boolean {
  const ttl = (ttlOverrides ?? TTL_DAYS)[memoryType ?? "fact"];
  if (ttl === null || ttl === undefined) return false;

  const ageMs = Date.now() - Date.parse(createdAt);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return ageDays > ttl;
}

/**
 * Get TTL remaining in days for a memory. Returns null if no TTL.
 */
export function ttlRemaining(
  createdAt: string,
  memoryType: string | null,
  ttlOverrides?: Record<string, number | null>,
): number | null {
  const ttl = (ttlOverrides ?? TTL_DAYS)[memoryType ?? "fact"];
  if (ttl === null || ttl === undefined) return null;

  const ageMs = Date.now() - Date.parse(createdAt);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.max(0, ttl - ageDays);
}

// ── Consolidation ────────────────────────────────────────────────────────────

export interface ConsolidationCandidate {
  id: string;
  factKey: string;
  text: string;
  memoryType: string | null;
  createdAt: string;
  strength: number;
  accessCount: number;
}

export interface ConsolidationResult {
  pruned: string[];           // IDs of memories pruned (too weak)
  merged: Array<{ keep: string; drop: string[] }>; // merged groups
  reinforced: string[];       // IDs of memories reinforced
  expired: string[];          // IDs of memories expired
}

/**
 * Determine which memories should be pruned, merged, or reinforced.
 *
 * This is the "consolidation" step that runs periodically or on demand.
 * It does NOT modify the database — it returns a plan for the caller to execute.
 */
export function planConsolidation(candidates: ConsolidationCandidate[]): ConsolidationResult {
  const result: ConsolidationResult = { pruned: [], merged: [], reinforced: [], expired: [] };

  // Group by fact_key for potential merging
  const byFactKey = new Map<string, ConsolidationCandidate[]>();
  for (const c of candidates) {
    const key = c.factKey ?? `_no_key_${c.id}`;
    const group = byFactKey.get(key) ?? [];
    group.push(c);
    byFactKey.set(key, group);
  }

  for (const [, group] of byFactKey) {
    if (group.length <= 1) continue;

    // Sort by strength descending
    group.sort((a, b) => b.strength - a.strength);

    // Keep the strongest, mark others for merging
    const keep = group[0];
    const drop = group.slice(1);

    // Only merge if texts are similar enough (simple prefix match)
    const mergeable = drop.filter((d) => {
      const shorter = Math.min(d.text.length, keep.text.length);
      const prefix = d.text.slice(0, Math.min(shorter, 80));
      return keep.text.includes(prefix) || d.text.includes(keep.text.slice(0, 80));
    });

    if (mergeable.length > 0) {
      result.merged.push({
        keep: keep.id,
        drop: mergeable.map((d) => d.id),
      });
    }
  }

  // Prune expired and too-weak memories
  for (const c of candidates) {
    if (isExpired(c.createdAt, c.memoryType)) {
      result.expired.push(c.id);
    } else if (c.strength < PRUNE_THRESHOLD) {
      result.pruned.push(c.id);
    }
  }

  return result;
}

// ── Score Modifier for Retrieval ─────────────────────────────────────────────

/**
 * Calculate the lifecycle-aware score modifier for a memory during retrieval.
 * Combines time-decay, type lifecycle, and access patterns into a single multiplier.
 *
 * This is applied on top of the FTS5 relevance score during query.
 */
export function lifecycleScoreModifier(
  createdAt: string,
  memoryType: string | null,
  accessCount: number = 0,
  lastAccessed: string | null = null,
  currentStatus: string | null = null,
): number {
  // Base lifecycle strength
  let strength = memoryStrength(createdAt, memoryType, accessCount, lastAccessed);

  // Boost current memories, penalize superseded
  if (currentStatus === "current") strength = Math.min(MAX_STRENGTH, strength + 0.1);
  if (currentStatus === "superseded") strength *= 0.3;
  if (currentStatus === "forgotten") strength = 0;

  // Floor at 0
  return Math.max(0, strength);
}
