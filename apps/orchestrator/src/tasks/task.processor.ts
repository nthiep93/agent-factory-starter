import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, type OnApplicationBootstrap } from "@nestjs/common";
import type { Job } from "bullmq";
import { APP_CONFIG, type OrchestratorConfig } from "../config/config.js";
import { TaskPipeline } from "./task-pipeline.js";
import { TASK_QUEUE_NAME, type RunRecord, type TaskJobData } from "./task.types.js";

/**
 * BullMQ worker: one job = one issue run. A thrown error marks the job failed.
 * maxStalledCount 0: if the process dies mid-run the job fails instead of
 * silently starting a second paid agent run (attempts is 1 for the same reason).
 */
@Processor(TASK_QUEUE_NAME, { maxStalledCount: 0 })
export class TaskProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly pipeline: TaskPipeline,
    @Inject(APP_CONFIG) private readonly config: OrchestratorConfig,
  ) {
    super();
  }

  /** The worker exists after BullModule's onModuleInit; concurrency comes from config. */
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.config.agentConcurrency;
  }

  process(job: Job<TaskJobData, RunRecord>): Promise<RunRecord> {
    return this.pipeline.execute(job.data);
  }
}
