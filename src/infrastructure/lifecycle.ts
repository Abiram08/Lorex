/** Memory lifecycle: time-decay scoring, type-based expiry, consolidation planning. */

export const HALF_LIFE_DAYS = 90;
export const STALE_THRESHOLD = 0.15;
export const PRUNE_THRESHOLD = 0.05;
export const REINFORCEMENT_BOOST = 0.3;
export const MAX_STRENGTH = 1.0;
export const EPISODE_DECAY_MULTIPLIER = 2.0;
export const PREFERENCE_BOOST_RATE = 0.1;

export const TTL_DAYS: Record<string, number | null> = {
  fact: null,
  decision: null,
  preference: null,
  constraint: null,
  task: 30,
  correction: 180,
  episode: 30,
  lesson: null,
  handoff: null,
  conversation_chunk: null,
};

export function timeDecayStrength(createdAt: string, halfLifeDays: number = HALF_LIFE_DAYS): number {
  const ageMs = Date.now() - Date.parse(createdAt);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

export function memoryStrength(
  createdAt: string,
  memoryType: string | null,
  accessCount: number = 0,
  _lastAccessed: string | null = null,
): number {
  const base = timeDecayStrength(createdAt);

  switch (memoryType) {
    case "episode":
      return Math.min(MAX_STRENGTH, base * (1 / EPISODE_DECAY_MULTIPLIER));
    case "preference":
      return Math.min(MAX_STRENGTH, base + (accessCount * PREFERENCE_BOOST_RATE));
    case "lesson":
      return Math.min(MAX_STRENGTH, Math.pow(base, 0.5));
    case "correction":
      return Math.pow(base, 0.7);
    case "task":
      return Math.pow(base, 1.5);
    default:
      return base;
  }
}

export function reinforcedStrength(currentStrength: number): number {
  return Math.min(MAX_STRENGTH, currentStrength + REINFORCEMENT_BOOST);
}

export type StalenessTag = "fresh" | "recent" | "aging" | "stale" | "expired";

export function stalenessTag(createdAt: string): StalenessTag {
  const ageMs = Date.now() - Date.parse(createdAt);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays < 7) return "fresh";
  if (ageDays < 30) return "recent";
  if (ageDays < 90) return "aging";
  if (ageDays < 180) return "stale";
  return "expired";
}

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
  pruned: string[];
  merged: Array<{ keep: string; drop: string[] }>;
  reinforced: string[];
  expired: string[];
}

/** Proposes prune/merge/expire actions. Pure — the caller applies the plan. */
export function planConsolidation(candidates: ConsolidationCandidate[]): ConsolidationResult {
  const result: ConsolidationResult = { pruned: [], merged: [], reinforced: [], expired: [] };

  const byFactKey = new Map<string, ConsolidationCandidate[]>();
  for (const c of candidates) {
    const key = c.factKey ?? `_no_key_${c.id}`;
    const group = byFactKey.get(key) ?? [];
    group.push(c);
    byFactKey.set(key, group);
  }

  for (const [, group] of byFactKey) {
    if (group.length <= 1) continue;
    group.sort((a, b) => b.strength - a.strength);

    const keep = group[0];
    const mergeable = group.slice(1).filter((d) => {
      const prefix = d.text.slice(0, 80);
      return keep.text.includes(prefix) || d.text.includes(keep.text.slice(0, 80));
    });

    if (mergeable.length > 0) {
      result.merged.push({ keep: keep.id, drop: mergeable.map((d) => d.id) });
    }
  }

  for (const c of candidates) {
    if (isExpired(c.createdAt, c.memoryType)) {
      result.expired.push(c.id);
    } else if (c.strength < PRUNE_THRESHOLD) {
      result.pruned.push(c.id);
    }
  }

  return result;
}

/** Lifecycle-aware score multiplier for retrieval ranking. */
export function lifecycleScoreModifier(
  createdAt: string,
  memoryType: string | null,
  accessCount: number = 0,
  lastAccessed: string | null = null,
  currentStatus: string | null = null,
): number {
  void lastAccessed;
  let strength = memoryStrength(createdAt, memoryType, accessCount);

  if (currentStatus === "current") strength = Math.min(MAX_STRENGTH, strength + 0.1);
  if (currentStatus === "superseded") strength *= 0.3;
  if (currentStatus === "forgotten") strength = 0;

  return Math.max(0, strength);
}
