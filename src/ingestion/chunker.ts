/** Token-bounded chunking of conversation events. */

import type { ConversationEvent } from "../domain/event.js";
import { countTokens, splitIntoTokenChunks } from "./token-counter.js";

export interface Chunk {
  chunkId: string;
  sessionId: string;
  content: string;
  tokenCount: number;
  eventStart: number;
  eventEnd: number;
  occurredAt: string;
  chunkSequence: number;
  totalChunks: number;
  previousChunkId?: string;
  nextChunkId?: string;
}

export interface ChunkerOptions {
  maxTokens?: number;
  minTokens?: number;
}

export const DEFAULT_CHUNK_TOKENS = 400;

export function chunkEvents(
  sessionId: string,
  events: ConversationEvent[],
  options: ChunkerOptions = {},
): Chunk[] {
  const maxTokens = options.maxTokens ?? DEFAULT_CHUNK_TOKENS;
  const minTokens = options.minTokens ?? Math.floor(maxTokens / 4);

  const chunks: Chunk[] = [];
  let currentContent = "";
  let currentTokens = 0;
  let eventStart = 0;
  let eventEnd = 0;
  let chunkSequence = 0;

  const makeChunk = (content: string, tokens: number, start: number, end: number, seq: number): Chunk => ({
    chunkId: `${sessionId}_chunk_${seq}`,
    sessionId,
    content,
    tokenCount: tokens,
    eventStart: start,
    eventEnd: end,
    occurredAt: events[start]?.occurredAt ?? new Date().toISOString(),
    chunkSequence: seq,
    totalChunks: 0,
  });

  const flush = (): void => {
    if (!currentContent) return;
    chunks.push(makeChunk(currentContent, currentTokens, eventStart, eventEnd, chunkSequence));
    chunkSequence++;
    currentContent = "";
    currentTokens = 0;
  };

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const rolePrefix = event.role === "user" ? "User" : event.role === "assistant" ? "Assistant" : "Tool";

    if (event.tokenCount > maxTokens) {
      flush();
      eventStart = i;
      eventEnd = i;
      const pieces = splitIntoTokenChunks(`${rolePrefix}: ${event.content}`, maxTokens);
      for (const piece of pieces) {
        currentContent = piece;
        currentTokens = countTokens(piece);
        flush();
      }
      eventStart = i + 1;
      continue;
    }

    if (currentTokens + event.tokenCount > maxTokens && currentTokens > 0) {
      flush();
      eventStart = i;
    }

    const separator = currentContent ? "\n\n" : "";
    const eventContent = `${rolePrefix}: ${event.content}`;
    currentContent = currentContent ? currentContent + separator + eventContent : eventContent;
    currentTokens += event.tokenCount;
    eventEnd = i;
  }

  flush();

  if (chunks.length > 1) {
    const tail = chunks[chunks.length - 1]!;
    const prev = chunks[chunks.length - 2]!;
    if (tail.tokenCount < minTokens && prev.tokenCount + tail.tokenCount <= maxTokens) {
      prev.content = `${prev.content}\n\n${tail.content}`;
      prev.tokenCount += tail.tokenCount;
      prev.eventEnd = tail.eventEnd;
      chunks.pop();
    }
  }

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) chunks[i].previousChunkId = chunks[i - 1].chunkId;
    if (i < chunks.length - 1) chunks[i].nextChunkId = chunks[i + 1].chunkId;
  }

  const total = chunks.length;
  chunks.forEach(c => c.totalChunks = total);

  return chunks;
}
