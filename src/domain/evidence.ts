/** Evidence types returned in receipts, and excerpt truncation. */

import type { Corpus } from "./receipts.js";

export interface Evidence {
  id: string;
  corpus: Corpus;
  content: string;
  sessionId?: string;
  occurredAt?: string;
  validFrom?: string;
  validTo?: string;
  score?: number;
  sourceRef?: string;
  factKey?: string;
  agent?: string;
  memoryType?: string;
  reason?: string;
  status?: string;
  trust?: string;
  sourceSessionId?: string;
  rootSessionId?: string;
  sourceEventId?: string;
  evidenceIds?: string[];
  excerpt: string;
}

export const EXCERPT_LENGTH = 240;

export function excerpt(content: string): string {
  return content.length > EXCERPT_LENGTH
    ? `${content.slice(0, EXCERPT_LENGTH)}…`
    : content;
}
