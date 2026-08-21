/** Flat-window control arm construction. */

import { countTokens, truncateToTokenBudget } from "../ingestion/token-counter.js";

export type BaselineStrategy = "full-window" | "recent-window";

export interface BaselineSession {
  sessionId: string;
  occurredAt: string;
  turns: Array<{ role: string; content: string }>;
}

export interface BaselineContext {
  context: string;
  tokens: number;
  haystackTokens: number;
  truncated: boolean;
  sessionsIncluded: number;
  strategy: BaselineStrategy;
}

export interface BaselineOptions {
  windowTokens?: number;
  strategy?: BaselineStrategy;
}

export function buildBaselineContext(
  sessions: BaselineSession[],
  opts: BaselineOptions = {},
): BaselineContext {
  const windowTokens = opts.windowTokens ?? 115_000;
  const strategy = opts.strategy ?? "full-window";

  const rendered = sessions.map((s) => {
    const body = s.turns
      .map((t) => `${t.role === "assistant" ? "Assistant" : "User"}: ${t.content}`)
      .join("\n");
    const text = `--- Session ${s.sessionId} (${s.occurredAt}) ---\n${body}`;
    return { text, tokens: countTokens(text), occurredAt: s.occurredAt };
  });

  const haystackTokens = rendered.reduce((sum, r) => sum + r.tokens, 0);

  const kept: typeof rendered = [];
  let total = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const item = rendered[i]!;
    if (total + item.tokens > windowTokens) {
      const room = windowTokens - total;
      if (room > 200) {
        kept.push({ ...item, text: truncateToTokenBudget(item.text, room), tokens: room });
        total += room;
      }
      break;
    }
    kept.push(item);
    total += item.tokens;
  }

  if (strategy === "full-window") kept.reverse();

  const context = kept.map((k) => k.text).join("\n\n");
  return {
    context,
    tokens: countTokens(context),
    haystackTokens,
    truncated: kept.length < rendered.length,
    sessionsIncluded: kept.length,
    strategy,
  };
}
