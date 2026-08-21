/** Durable retry buffer and dead-letter log for failed writes. */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lorexHome } from "./paths.js";
import type {
  FeedbackInput,
  HydraDBLike,
  IngestKnowledgeInput,
  IngestMemoryInput,
} from "./hydradb-client.js";

export type QueueKind = "memory" | "knowledge" | "feedback";

export interface QueuedWrite {
  id: string;
  kind: QueueKind;
  memory?: IngestMemoryInput;
  knowledge?: IngestKnowledgeInput;
  feedback?: FeedbackInput;
  attempts: number;
  createdAt: number;
  lastError?: string;
}

const QUEUE_FILE = (): string => join(lorexHome(), "queue.jsonl");
const DEAD_LETTER_FILE = (): string => join(lorexHome(), "queue-dead.jsonl");
const MAX_ATTEMPTS = 5;
const FLUSH_INTERVAL_MS = 30_000;

export class WriteQueue {
  private items: QueuedWrite[] = [];
  private flushing = false;

  constructor(
    private readonly client: HydraDBLike,
    private readonly capacity = 500,
  ) {
    this.items = readQueueFile();
  }

  get length(): number {
    return this.items.length;
  }

  pending(): readonly QueuedWrite[] {
    return this.items;
  }

  enqueueMemory(input: IngestMemoryInput, lastError: string): void {
    this.add({ kind: "memory", memory: input, lastError });
  }

  enqueueKnowledge(input: IngestKnowledgeInput, lastError: string): void {
    this.add({ kind: "knowledge", knowledge: input, lastError });
  }

  enqueueFeedback(input: FeedbackInput, lastError?: string): void {
    const duplicate = this.items.some(
      (i) => i.kind === "feedback" && i.feedback?.request_id === input.request_id,
    );
    if (duplicate) return;
    this.add({ kind: "feedback", feedback: input, lastError });
  }

  async flush(): Promise<void> {
    if (this.flushing || this.items.length === 0) return;
    this.flushing = true;

    // Snapshot the batch so items enqueued during a flush are never lost.
    const batch = this.items;
    this.items = [];
    writeQueueFile(this.items);
    const survivors: QueuedWrite[] = [];

    try {
      for (const item of batch) {
        try {
          await this.send(item);
        } catch (error) {
          item.attempts++;
          item.lastError = error instanceof Error ? error.message : String(error);
          if (item.attempts < MAX_ATTEMPTS && !isPermanent(error)) {
            survivors.push(item);
          } else {
            deadLetter(item, isPermanent(error) ? "permanent failure" : "retries exhausted");
          }
        }
      }
      // Keep anything enqueued while we were flushing.
      this.items = [...survivors, ...this.items];
      writeQueueFile(this.items);
    } catch (e) {
      this.items = [...survivors, ...batch.filter((i) => !survivors.includes(i)), ...this.items];
      writeQueueFile(this.items);
      throw e;
    } finally {
      this.flushing = false;
    }
  }

  startAutoFlush(intervalMs = FLUSH_INTERVAL_MS): void {
    setInterval(() => void this.flush().catch(() => {}), intervalMs).unref();
  }

  private add(partial: Omit<QueuedWrite, "id" | "attempts" | "createdAt">): void {
    if (this.items.length >= this.capacity) {
      const evicted = this.items.shift();
      if (evicted) deadLetter(evicted, "queue capacity reached");
    }
    this.items.push({
      ...partial,
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      attempts: 0,
      createdAt: Date.now(),
    });
    writeQueueFile(this.items);
  }

  private async send(item: QueuedWrite): Promise<void> {
    if (item.kind === "memory" && item.memory) return void (await this.client.ingestMemory(item.memory));
    if (item.kind === "knowledge" && item.knowledge) return void (await this.client.ingestKnowledge(item.knowledge));
    if (item.kind === "feedback" && item.feedback) return void (await this.client.feedback(item.feedback));
  }
}

function deadLetter(item: QueuedWrite, reason: string): void {
  try {
    mkdirSync(lorexHome(), { recursive: true });
    appendFileSync(
      DEAD_LETTER_FILE(),
      `${JSON.stringify({ ...item, droppedAt: new Date().toISOString(), reason })}
`,
      { mode: 0o600 },
    );
  } catch {
  }
  process.stderr.write(
    `lorex: dropped a queued ${item.kind} write (${reason}) — see ${DEAD_LETTER_FILE()}
`,
  );
}

function isPermanent(error: unknown): boolean {
  const kind = (error as { kind?: string })?.kind;
  return kind === "auth" || kind === "client";
}

function readQueueFile(): QueuedWrite[] {
  const file = QUEUE_FILE();
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as QueuedWrite];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function writeQueueFile(items: QueuedWrite[]): void {
  try {
    mkdirSync(lorexHome(), { recursive: true });
    const body = items.map((i) => JSON.stringify(i)).join("\n");
    writeFileSync(QUEUE_FILE(), items.length ? `${body}\n` : "", { mode: 0o600 });
  } catch {
  }
}
