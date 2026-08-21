/** Session normalization into ordered, token-counted events. */

import type { SessionTurn, NormalizedSession } from "../domain/session.js";
import type { ConversationEvent } from "../domain/event.js";
import { countTokens } from "./token-counter.js";

export function normalizeSession(
  sessionId: string,
  database: string,
  collection: string,
  turns: SessionTurn[],
  opts: { startedAt?: string; agent?: string; source?: string; sequence?: number } = {},
): NormalizedSession {
  if (!sessionId.trim()) throw new Error("sessionId is required");
  if (!database.trim() || !collection.trim()) throw new Error("database and collection are required");
  if (turns.length === 0) {
    return {
      sessionId,
      database,
      collection,
      sequence: opts.sequence ?? 0,
      startedAt: opts.startedAt ?? new Date().toISOString(),
      endedAt: opts.startedAt ?? new Date().toISOString(),
      agent: opts.agent,
      source: opts.source,
      turns: [],
      tokenCount: 0,
    };
  }
  if (turns.some((turn) => !turn.content.trim())) throw new Error("session turns must contain content");

  const startedAt = opts.startedAt ?? turns[0]?.occurredAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(startedAt))) throw new Error("startedAt must be a valid ISO date");

  validateTimestampOrder(turns);

  const lastTurn = turns[turns.length - 1];
  const endedAt = lastTurn?.occurredAt ?? startedAt;

  return {
    sessionId,
    database,
    collection,
    sequence: opts.sequence ?? 0,
    startedAt,
    endedAt,
    agent: opts.agent,
    source: opts.source,
    turns,
    tokenCount: turns.reduce((sum, turn) => sum + estimateTurnTokens(turn), 0),
  };
}

export function sessionToEvents(session: NormalizedSession): ConversationEvent[] {
  return session.turns.map((turn, index) => ({
    eventId: `${session.sessionId}_event_${index}`,
    sessionId: session.sessionId,
    sequence: index,
    role: turn.role,
    content: turn.content,
    occurredAt: turn.occurredAt ?? session.startedAt,
    ingestedAt: new Date().toISOString(),
    tokenCount: estimateTurnTokens(turn),
    toolName: turn.toolName,
    sourceRef: session.sessionId,
  }));
}

function validateTimestampOrder(turns: SessionTurn[]): void {
  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1]?.occurredAt;
    const curr = turns[i]?.occurredAt;
    if (prev && curr) {
      const prevTime = Date.parse(prev);
      const currTime = Date.parse(curr);
      if (!Number.isNaN(prevTime) && !Number.isNaN(currTime) && currTime < prevTime) {
        throw new Error(`turn ${i} timestamp is before turn ${i - 1}`);
      }
    }
  }
}

function estimateTurnTokens(turn: SessionTurn): number {
  const total =
    countTokens(turn.content) +
    (turn.toolInput ? countTokens(turn.toolInput) : 0) +
    (turn.toolOutput ? countTokens(turn.toolOutput) : 0);
  return Math.max(1, total);
}
