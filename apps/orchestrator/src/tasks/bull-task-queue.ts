import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import {
  PENDING_STATES,
  type EnqueueResult,
  type ListedState,
  type TaskQueue,
  type TaskSnapshot,
  type TaskState,
} from "./task-queue.js";
import {
  TASK_JOB_NAME,
  TASK_QUEUE_NAME,
  taskJobId,
  type RunRecord,
  type TaskJobData,
} from "./task.types.js";

/** Agent runs cost money: never retry automatically, a human re-labels instead. */
export const TASK_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { count: 500 },
  removeOnFail: { count: 500 },
} as const;

type TaskJob = Job<TaskJobData, RunRecord>;

@Injectable()
export class BullTaskQueue implements TaskQueue {
  constructor(
    @InjectQueue(TASK_QUEUE_NAME) private readonly queue: Queue<TaskJobData, RunRecord>,
  ) {}

  async enqueue(data: TaskJobData): Promise<EnqueueResult> {
    const jobId = taskJobId(data.issueNumber);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (PENDING_STATES.includes(state)) return { jobId, created: false };
      // A finished run of the same issue: drop it so the re-label starts a new run.
      await existing.remove();
    }
    // BullMQ also deduplicates by jobId atomically, which covers concurrent deliveries.
    const job = await this.queue.add(TASK_JOB_NAME, data, { ...TASK_JOB_OPTIONS, jobId });
    return { jobId: job.id ?? jobId, created: true };
  }

  async list(states: readonly ListedState[], limit: number): Promise<TaskSnapshot[]> {
    const perState = await Promise.all(
      states.map(async (state) => {
        const jobs = (await this.queue.getJobs([state], 0, limit - 1, false)) as TaskJob[];
        return jobs.map((job) => toSnapshot(job, state));
      }),
    );
    return perState
      .flat()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }
}

function toSnapshot(job: TaskJob, state: TaskState): TaskSnapshot {
  return {
    id: job.id ?? "",
    state,
    data: job.data,
    createdAt: job.timestamp,
    startedAt: job.processedOn ?? null,
    finishedAt: job.finishedOn ?? null,
    record: state === "completed" ? (job.returnvalue ?? null) : null,
    failedReason: job.failedReason || null,
  };
}
