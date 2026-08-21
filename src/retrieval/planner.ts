/** Query intent classification and retrieval planning. */

export type QueryIntent =
  | "current_fact"
  | "temporal"
  | "multi_session"
  | "preference"
  | "knowledge_update"
  | "profile";

export interface RetrievalPlan {
  intent: QueryIntent;
  mode: "fast" | "thinking";
  type: "memory" | "knowledge" | "all";
  asOf?: string;
  requireChronology: boolean;
  query: string;
}

export function classifyAndPlan(
  query: string,
  opts: {
    asOf?: string;
    mode?: "fast" | "thinking";
    type?: "memory" | "knowledge" | "all";
  } = {},
): RetrievalPlan {
  const base = autoPlan(query, opts);
  return {
    ...base,
    mode: opts.mode ?? base.mode,
    type: opts.type ?? base.type,
    asOf: opts.asOf ?? base.asOf,
    requireChronology: opts.asOf ? true : base.requireChronology,
  };
}

function autoPlan(
  query: string,
  opts: { asOf?: string; mode?: "fast" | "thinking"; type?: "memory" | "knowledge" | "all" },
): RetrievalPlan {
  const intent = classifyIntent(query, opts);

  switch (intent) {
    case "temporal": {
      const asOf = opts.asOf ?? extractDate(query);
      return {
        intent,
        mode: asOf ? "fast" : "thinking",
        type: "all",
        asOf,
        requireChronology: !!asOf,
        query,
      };
    }

    case "multi_session":
      return {
        intent,
        mode: "thinking",
        type: "all",
        requireChronology: true,
        query,
      };

    case "preference":
      return {
        intent,
        mode: "thinking",
        type: "all",
        requireChronology: false,
        query,
      };

    case "knowledge_update":
      return {
        intent,
        mode: "thinking",
        type: "all",
        requireChronology: false,
        query,
      };

    case "profile":
      return {
        intent,
        mode: "thinking",
        type: "memory",
        requireChronology: false,
        query,
      };

    default:
      return {
        intent: "current_fact",
        mode: "fast",
        type: "all",
        requireChronology: false,
        query,
      };
  }
}

function classifyIntent(
  query: string,
  opts: { asOf?: string; mode?: string; type?: string },
): QueryIntent {
  const lowerQuery = query.toLowerCase();

  if (opts.asOf) return "temporal";
  if (containsTemporalKeywords(lowerQuery)) return "temporal";

  if (containsMultiSessionKeywords(lowerQuery)) return "multi_session";

  if (containsPreferenceKeywords(lowerQuery)) return "preference";

  if (containsUpdateKeywords(lowerQuery)) return "knowledge_update";

  if (!query || query.trim() === "") return "profile";

  return "current_fact";
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function extractDate(query: string): string | undefined {
  const iso = query.match(/\b(\d{4})[-/](\d{2})[-/](\d{2})\b/);
  if (iso) return utcDate(+iso[1]!, +iso[2]!, +iso[3]!);

  const named = query.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i,
  );
  if (named) {
    const month = MONTHS.indexOf(named[1]!.toLowerCase()) + 1;
    if (month > 0) return utcDate(+named[3]!, month, +named[2]!);
  }

  return undefined;
}

function utcDate(year: number, month: number, day: number): string | undefined {
  const t = Date.UTC(year, month - 1, day, 12, 0, 0);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function containsTemporalKeywords(text: string): boolean {
  const keywords = [
    "on date", "at that time", "back then", "previously", "before",
    "when did", "what was", "as of", "in january", "in february", "in march",
    "on monday", "on tuesday", "last week", "last month", "last year"
  ];
  return keywords.some(k => text.includes(k));
}

function containsMultiSessionKeywords(text: string): boolean {
  const keywords = [
    "across sessions", "in all", "everything", "all discussions",
    "history", "timeline", "progress", "over time", "throughout"
  ];
  return keywords.some(k => text.includes(k));
}

function containsPreferenceKeywords(text: string): boolean {
  const keywords = [
    "prefer", "like", "want", "favorite", "usually", "always use",
    "tend to", "habit", "routine"
  ];
  return keywords.some(k => text.includes(k));
}

function containsUpdateKeywords(text: string): boolean {
  const keywords = [
    "changed", "updated", "new", "latest", "current",
    "replaced", "superseded", "now use", "switched to"
  ];
  return keywords.some(k => text.includes(k));
}
