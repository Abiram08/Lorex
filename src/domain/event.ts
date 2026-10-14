/** Conversation event types, produced from session turns. */

export interface ConversationEvent {
  eventId: string;
  sessionId: string;
  sequence: number;
  role: "user" | "assistant" | "tool";
  content: string;
  occurredAt: string;
  ingestedAt: string;
  tokenCount: number;
  toolName?: string;
  sourceRef?: string;
}

export type EventBatch = ConversationEvent[];
