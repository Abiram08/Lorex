/** Causal reasons and transitions, and rendering of supersession chains. */

export type CausalSource = "explicit" | "extracted" | "unknown";

export interface CausalLink {
  versionId: string;
  supersedesVersionId?: string;
  reason?: string;
  reasonSource: CausalSource;
  at: string;
  fromValue?: string;
  toValue?: string;
}

export interface CausalChain {
  factKey: string;
  links: CausalLink[];
  hasReasons: boolean;
}

const REASON_PATTERNS: RegExp[] = [
  /\bbecause\s+(?:of\s+)?(.{4,180}?)(?:[.;!?]|$)/i,
  /\bdue\s+to\s+(.{4,180}?)(?:[.;!?]|$)/i,
  /\bsince\s+(.{4,180}?)(?:[.;!?]|$)/i,
  /\bin\s+order\s+to\s+(.{4,180}?)(?:[.;!?]|$)/i,
  /\bso\s+(?:that\s+)?(?:we\s+|I\s+)?(?:can|could|don'?t|wouldn'?t)\s+(.{4,180}?)(?:[.;!?]|$)/i,
  /\bto\s+(?:avoid|fix|prevent|reduce|improve|support)\s+(.{4,180}?)(?:[.;!?]|$)/i,
  /\b(?:it|that|this)\s+(?:was|is|kept)\s+(too\s+\w+|failing|broken|unreliable|slow|expensive)(.{0,120}?)(?:[.;!?]|$)/i,
];

export function extractReason(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length < 12) return undefined;

  for (const pattern of REASON_PATTERNS) {
    const match = trimmed.match(pattern);
    const captured = match?.slice(1).filter(Boolean).join(" ").trim();
    if (captured && captured.length >= 4) {
      return normalizeReason(captured);
    }
  }
  return undefined;
}

function normalizeReason(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^[,\-–—:\s]+/, "")
    .replace(/[,\s]+$/, "")
    .slice(0, 200);
}

export function extractTransition(text: string): { from?: string; to?: string } {
  const m = text.match(
    /\b(?:switch(?:ed|ing)?|migrat(?:ed|ing)|mov(?:ed|ing)|chang(?:ed|ing))\s+from\s+([\w.+#-]{2,40})\s+to\s+([\w.+#-]{2,40})/i,
  );
  if (m) return { from: m[1], to: m[2] };

  const to = text.match(
    /\b(?:switch(?:ed|ing)?\s+to|migrat(?:ed|ing)\s+to|now\s+us(?:e|ing)|replaced\s+with)\s+([\w.+#-]{2,40})/i,
  );
  if (to) return { to: to[1] };

  return {};
}

export function renderCausalChain(chain: CausalChain): string {
  if (chain.links.length === 0) return "No recorded changes for this topic.";

  const lines: string[] = [];
  const ordered = [...chain.links].sort(
    (a, b) => Date.parse(a.at || "0") - Date.parse(b.at || "0"),
  );

  for (const link of ordered) {
    const when = link.at ? link.at.slice(0, 10) : "unknown date";
    const transition =
      link.fromValue && link.toValue
        ? `${link.fromValue} → ${link.toValue}`
        : link.toValue ?? "(unchanged)";
    const why = link.reason
      ? ` — because ${link.reason}`
      : link.supersedesVersionId
        ? " — no reason recorded"
        : "";
    lines.push(`- ${when}: ${transition}${why}`);
  }

  if (!chain.hasReasons) {
    lines.push("");
    lines.push("No reason was ever stated in the history for these changes.");
  }
  return lines.join("\n");
}
