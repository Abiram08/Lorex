/** Session and turn types. */

export interface Session {
  sessionId: string;
  database: string;
  collection: string;
  sequence: number;
  startedAt: string;
  endedAt?: string;
  agent?: string;
  source?: string;
  tokenCount: number;
}

export interface SessionTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  occurredAt?: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
}

export interface NormalizedSession extends Session {
  turns: SessionTurn[];
  isDuplicate?: boolean;
  duplicatesOf?: string[];
}
