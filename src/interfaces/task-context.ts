/** Small local task journal shared by independent agent processes. */

import type { SqliteStore } from "../infrastructure/sqlite-store.js";
import { redactSecrets } from "../infrastructure/secrets.js";

const TASK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
export const TASK_KINDS = ["progress", "decision", "blocker", "handoff"] as const;
export type TaskKind = typeof TASK_KINDS[number];

export function validateTaskId(id: string): string {
  if (!TASK_ID.test(id)) throw new Error("task id must be 1–80 letters, numbers, dots, dashes, or underscores");
  return id;
}

export function safeTaskText(text: string, max: number): string {
  const value = text.trim();
  if (!value || value.length > max) throw new Error(`task text must be 1–${max} characters`);
  return redactSecrets(value).text;
}

export function taskContext(store: SqliteStore, collection: string, taskId: string, maxChars = 3000): string {
  const task = store.getTask(collection, validateTaskId(taskId), 0, 30);
  if (!task) return `Lorex task ${taskId} is not registered in this workspace.`;
  const brief = task.brief.slice(0, Math.max(0, maxChars - 150));
  const header = `Shared task ${task.id}: ${brief}${brief.length < task.brief.length ? "…" : ""}\nLatest event: ${task.latestSeq}. Check for newer events before acting.`;
  let remaining = Math.max(0, maxChars - header.length - 2);
  const lines: string[] = [];
  for (const event of [...task.events].reverse()) {
    const line = `#${event.seq} [${event.agent}/${event.kind}] ${event.body}`;
    if (line.length + 1 > remaining) break;
    lines.unshift(line);
    remaining -= line.length + 1;
  }
  return [header, ...lines].join("\n");
}
