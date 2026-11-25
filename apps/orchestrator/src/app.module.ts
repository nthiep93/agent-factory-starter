import { BullModule } from "@nestjs/bullmq";
import { Module, type DynamicModule } from "@nestjs/common";
import { AGENT_RUNNER } from "./agent/agent-runner.js";
import { ClaudeAgentRunner } from "./agent/claude-agent-runner.js";
import { resolveEnvScrub } from "./agent/env-scrub.js";
import { APP_CONFIG, type OrchestratorConfig } from "./config/config.js";
import { GITHUB_CLIENT } from "./github/github-client.js";
import { RestGitHubClient } from "./github/rest-github-client.js";
import { HealthController } from "./health/health.controller.js";
import { RunsAuthGuard } from "./runs/runs-auth.guard.js";
import { RunsController } from "./runs/runs.controller.js";
import { RunsService } from "./runs/runs.service.js";
import { BullTaskQueue, TASK_JOB_OPTIONS } from "./tasks/bull-task-queue.js";
import { TaskPipeline } from "./tasks/task-pipeline.js";
import { TASK_QUEUE } from "./tasks/task-queue.js";
import { TASK_QUEUE_NAME } from "./tasks/task.types.js";
import { TaskProcessor } from "./tasks/task.processor.js";
import { WebhooksController } from "./webhooks/webhooks.controller.js";
import { WebhooksService } from "./webhooks/webhooks.service.js";
import { GitWorkspace } from "./workspace/git-workspace.js";
import { WORKSPACE } from "./workspace/workspace.js";

/**
 * Built from an already validated config, so a bad environment fails in
 * main.ts before Nest or Redis start. Ports are bound to their real adapters
 * here; tests override AGENT_RUNNER, WORKSPACE and GITHUB_CLIENT with fakes.
 */
@Module({})
export class AppModule {
  static forRoot(config: OrchestratorConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        BullModule.forRoot({ connection: { url: config.redisUrl } }),
        BullModule.registerQueue({ name: TASK_QUEUE_NAME, defaultJobOptions: TASK_JOB_OPTIONS }),
      ],
      controllers: [HealthController, WebhooksController, RunsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        WebhooksService,
        RunsService,
        RunsAuthGuard,
        TaskPipeline,
        TaskProcessor,
        { provide: TASK_QUEUE, useClass: BullTaskQueue },
        {
          provide: AGENT_RUNNER,
          useFactory: (c: OrchestratorConfig) =>
            new ClaudeAgentRunner(undefined, process.env, resolveEnvScrub(c.agentEnvScrub)),
          inject: [APP_CONFIG],
        },
        {
          provide: WORKSPACE,
          useFactory: (c: OrchestratorConfig) =>
            new GitWorkspace({
              repoDir: c.repoDir,
              worktreesDir: c.worktreesDir,
              // Built from the validated owner/repo; never the clone's remote config.
              pushUrl: `https://github.com/${c.repository.owner}/${c.repository.repo}.git`,
              pushToken: c.githubToken,
            }),
          inject: [APP_CONFIG],
        },
        {
          provide: GITHUB_CLIENT,
          useFactory: (c: OrchestratorConfig) =>
            new RestGitHubClient({
              token: c.githubToken,
              owner: c.repository.owner,
              repo: c.repository.repo,
            }),
          inject: [APP_CONFIG],
        },
      ],
    };
  }
}
