import "reflect-metadata";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getQueueToken } from "@nestjs/bullmq";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import type { Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_RUNNER } from "./agent/agent-runner.js";
import { AppModule } from "./app.module.js";
import { APP_OPTIONS, setupApp } from "./app.setup.js";
import { GITHUB_CLIENT } from "./github/github-client.js";
import type { RunView } from "./runs/runs.service.js";
import { TASK_QUEUE_NAME } from "./tasks/task.types.js";
import { TaskProcessor } from "./tasks/task.processor.js";
import { FakeAgentRunner, FakeGitHubClient, FakeWorkspace, testConfig } from "./testing/fakes.js";
import { signPayload } from "./webhooks/signature.js";
import { WORKSPACE } from "./workspace/workspace.js";

const REDIS_URL = process.env.REDIS_URL;
const SECRET = "integration-secret";

// Needs a real Redis: REDIS_URL=redis://localhost:6390 pnpm --filter orchestrator test
describe.skipIf(!REDIS_URL)("orchestrator with real Redis and BullMQ", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  let queue: Queue;
  const runner = new FakeAgentRunner();
  const workspace = new FakeWorkspace();
  const github = new FakeGitHubClient();
  let releaseAgent: () => void = () => undefined;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.forRoot(
          testConfig({ redisUrl: REDIS_URL ?? "", webhookSecret: SECRET, agentConcurrency: 3 }),
        ),
      ],
    })
      .overrideProvider(AGENT_RUNNER)
      .useValue(runner)
      .overrideProvider(WORKSPACE)
      .useValue(workspace)
      .overrideProvider(GITHUB_CLIENT)
      .useValue(github)
      .compile();

    queue = moduleRef.get<Queue>(getQueueToken(TASK_QUEUE_NAME));
    await queue.obliterate({ force: true });

    app = setupApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
    app.useLogger(false);
    await app.listen(0, "127.0.0.1");
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    releaseAgent();
    await queue?.obliterate({ force: true });
    await app?.close();
  });

  const labelIssue = async (number: number): Promise<Record<string, unknown>> => {
    const raw = JSON.stringify({
      action: "labeled",
      label: { name: "agent" },
      issue: { number, title: `Issue ${number}`, body: "Do it", state: "open", labels: [] },
      repository: { full_name: "acme/widgets" },
    });
    const response = await fetch(`${baseUrl}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issues",
        "x-github-delivery": `delivery-${number}`,
        "x-hub-signature-256": signPayload(SECRET, Buffer.from(raw)),
      },
      body: raw,
    });
    expect(response.status).toBe(202);
    return (await response.json()) as Record<string, unknown>;
  };

  const runs = async (): Promise<RunView[]> => {
    const response = await fetch(`${baseUrl}/runs?limit=20`);
    expect(response.status).toBe(200);
    return ((await response.json()) as { runs: RunView[] }).runs;
  };

  const waitForRun = async (id: string, state: string): Promise<RunView> => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const run = (await runs()).find((r) => r.id === id);
      if (run?.state === state) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`run ${id} never reached ${state}: ${JSON.stringify(await runs())}`);
  };

  it("applies AGENT_CONCURRENCY and never re-runs a stalled job", () => {
    const worker = app.get(TaskProcessor).worker;
    expect(worker.concurrency).toBe(3);
    expect(worker.opts.maxStalledCount).toBe(0);
  });

  it("enqueues, deduplicates while running, completes and shows the run", async () => {
    let started!: () => void;
    const agentStarted = new Promise<void>((resolve) => (started = resolve));
    const gate = new Promise<void>((resolve) => (releaseAgent = resolve));
    runner.onRun = async () => {
      started();
      await gate;
    };

    expect(await labelIssue(7)).toEqual({ jobId: "issue-7", deduplicated: false });
    await agentStarted;
    expect((await waitForRun("issue-7", "active")).startedAt).not.toBeNull();
    expect(await labelIssue(7)).toEqual({ jobId: "issue-7", deduplicated: true });

    releaseAgent();
    const run = await waitForRun("issue-7", "completed");

    expect(run).toMatchObject({ issueNumber: 7, title: "Issue 7", failedReason: null });
    expect(run.finishedAt).not.toBeNull();
    expect(run.record).toMatchObject({
      outcome: "pr_opened",
      branch: "agent/issue-7",
      pullRequest: { number: 101 },
    });
    expect(github.pullRequests).toHaveLength(1);
    expect(runner.calls).toHaveLength(1);
  });

  it("starts a fresh run when a finished issue is labeled again", async () => {
    runner.onRun = null;
    expect(await labelIssue(7)).toEqual({ jobId: "issue-7", deduplicated: false });
    await waitForRun("issue-7", "completed");
    expect(runner.calls).toHaveLength(2);
  });

  it("marks the job failed without retrying when the runner throws", async () => {
    runner.error = new Error("agent crashed");
    try {
      await labelIssue(8);
      const run = await waitForRun("issue-8", "failed");
      expect(run.failedReason).toBe("agent crashed");
      expect(run.record).toBeNull();
      const job = await queue.getJob("issue-8");
      expect(job?.attemptsMade).toBe(1);
      expect(workspace.events).toContain("cleanup:/srv/worktrees/issue-8");
    } finally {
      runner.error = null;
    }
  });
});
