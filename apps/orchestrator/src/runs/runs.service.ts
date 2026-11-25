import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { makeRedactor, redactDeep, type Redact } from "../common/redact.js";
import { APP_CONFIG, secretValues, type OrchestratorConfig } from "../config/config.js";
import { TASK_QUEUE, type ListedState, type TaskQueue } from "../tasks/task-queue.js";
import type { RunRecord } from "../tasks/task.types.js";

export interface RunView {
  id: string;
  issueNumber: number;
  title: string;
  state: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  record: RunRecord | null;
  failedReason: string | null;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
const STATES: readonly ListedState[] = ["waiting", "active", "completed", "failed"];

const iso = (ms: number | null): string | null => (ms ? new Date(ms).toISOString() : null);

/** Recent runs read straight from BullMQ: the queue is the only store. */
@Injectable()
export class RunsService {
  private readonly redact: Redact;

  constructor(
    @Inject(TASK_QUEUE) private readonly queue: TaskQueue,
    @Inject(APP_CONFIG) config: OrchestratorConfig,
  ) {
    this.redact = makeRedactor(secretValues(config));
  }

  async recent(limitParam?: string): Promise<RunView[]> {
    const limit = parseLimit(limitParam);
    const snapshots = await this.queue.list(STATES, limit);
    // The whole view is redacted: title, record (summaries, blocked paths) and failure reason.
    return snapshots.map((s) =>
      redactDeep<RunView>(
        {
          id: s.id,
          issueNumber: s.data.issueNumber,
          title: s.data.title,
          state: s.state,
          createdAt: iso(s.createdAt) ?? "",
          startedAt: iso(s.startedAt),
          finishedAt: iso(s.finishedAt),
          record: s.record,
          failedReason: s.failedReason,
        },
        this.redact,
      ),
    );
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new BadRequestException(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return value;
}
