import type { RunRecord, TaskJobData } from "./task.types.js";

/** DI token for {@link TaskQueue}. */
export const TASK_QUEUE = Symbol("TASK_QUEUE");

export type TaskState =
  | "waiting"
  | "active"
  | "completed"
  | "failed"
  | "delayed"
  | "prioritized"
  | "waiting-children"
  | "unknown";

/** Job states that mean "already queued or running": a new trigger is a duplicate. */
export const PENDING_STATES: readonly TaskState[] = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
];

export interface TaskSnapshot {
  id: string;
  state: TaskState;
  data: TaskJobData;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  record: RunRecord | null;
  failedReason: string | null;
}

export type ListedState = "waiting" | "active" | "completed" | "failed";

export interface EnqueueResult {
  jobId: string;
  /** False when a job with this id was already queued or running. */
  created: boolean;
}

/**
 * The slice of the queue the HTTP side needs. The BullMQ adapter implements
 * it; tests use an in-memory fake.
 */
export interface TaskQueue {
  enqueue(data: TaskJobData): Promise<EnqueueResult>;
  list(states: readonly ListedState[], limit: number): Promise<TaskSnapshot[]>;
}
