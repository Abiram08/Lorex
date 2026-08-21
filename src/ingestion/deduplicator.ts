/** Duplicate event removal before ingestion. */

import type { ConversationEvent } from "../domain/event.js";

export interface DeduplicationResult {
  events: ConversationEvent[];
  removedCount: number;
  removedTokenCount: number;
}

export function deduplicateEvents(events: ConversationEvent[]): DeduplicationResult {
  const seen = new Set<string>();
  const unique: ConversationEvent[] = [];
  let removedCount = 0;
  let removedTokenCount = 0;

  for (const event of events) {
    const fingerprint = createFingerprint(event);

    if (seen.has(fingerprint)) {
      removedCount++;
      removedTokenCount += event.tokenCount;
      continue;
    }

    seen.add(fingerprint);
    unique.push(event);
  }

  return {
    events: unique,
    removedCount,
    removedTokenCount,
  };
}

function createFingerprint(event: ConversationEvent): string {
  const normalized = event.content
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();

  return `${event.role}:${normalized}`;
}
