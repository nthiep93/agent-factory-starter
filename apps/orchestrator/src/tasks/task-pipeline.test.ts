import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_RUNNER } from "../agent/agent-runner.js";
import { APP_CONFIG } from "../config/config.js";
import { GITHUB_CLIENT } from "../github/github-client.js";
import { FakeAgentRunner, FakeGitHubClient, FakeWorkspace, testConfig } from "../testing/fakes.js";
import { WORKSPACE } from "../workspace/workspace.js";
import { TaskPipeline } from "./task-pipeline.js";
import type { TaskJobData } from "./task.types.js";

const job: TaskJobData = {
  issueNumber: 7,
  title: "Add a /ping endpoint",
  body: "It should return pong.",
  labels: ["agent"],
  deliveryId: "d-1",
};
const DIR = "/srv/worktrees/issue-7";

describe("TaskPipeline", () => {
  let runner: FakeAgentRunner;
  let workspace: FakeWorkspace;
  let github: FakeGitHubClient;
  let pipeline: TaskPipeline;

  beforeEach(async () => {
    runner = new FakeAgentRunner();
    workspace = new FakeWorkspace();
    github = new FakeGitHubClient();
    const moduleRef = await Test.createTestingModule({
      providers: [
        TaskPipeline,
        {
          provide: APP_CONFIG,
          useValue: testConfig({ agentMaxTurns: 12, agentMaxBudgetUsd: 1.5 }),
        },
        { provide: AGENT_RUNNER, useValue: runner },
        { provide: WORKSPACE, useValue: workspace },
        { provide: GITHUB_CLIENT, useValue: github },
      ],
    }).compile();
    // The failure paths log errors on purpose; keep the test output readable.
    moduleRef.useLogger(false);
    pipeline = moduleRef.get(TaskPipeline);
  });

  it("success: runs the agent, verifies, pushes, opens a PR and links it", async () => {
    const record = await pipeline.execute(job);

    expect(github.comments[0]?.body).toMatch(/picked up/i);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ cwd: DIR, maxTurns: 12, maxBudgetUsd: 1.5 });
    expect(runner.calls[0]?.prompt).toContain("Add a /ping endpoint");
    expect(runner.calls[0]?.prompt).toMatch(/<untrusted-issue-[0-9a-f]+>/);

    expect(workspace.events).toEqual([
      "prepare:7",
      `verify:${DIR}`,
      `commitsAhead:${DIR}`,
      `push:${DIR}:agent/issue-7`,
      `cleanup:${DIR}`,
    ]);

    expect(github.pullRequests).toHaveLength(1);
    const pr = github.pullRequests[0];
    expect(pr?.title).toBe("Add a /ping endpoint");
    expect(pr?.head).toBe("agent/issue-7");
    expect(pr?.base).toBe("main");
    expect(pr?.body).toContain("Closes #7");
    expect(pr?.body).toContain("Implemented the change with tests.");
    expect(pr?.body).toContain("Tasks: 6 successful, 6 total");
    expect(pr?.body).toContain("$0.42");
    expect(pr?.body).toContain("9 turns");

    expect(github.comments.at(-1)?.body).toContain("https://github.com/acme/widgets/pull/101");
    expect(record).toMatchObject({
      issueNumber: 7,
      branch: "agent/issue-7",
      outcome: "pr_opened",
      commits: 1,
      verify: { passed: true, summary: "Tasks:    6 successful, 6 total" },
      agent: { ok: true, subtype: "success", costUsd: 0.42, numTurns: 9 },
      pullRequest: { number: 101, url: "https://github.com/acme/widgets/pull/101" },
    });
    expect(Date.parse(record.startedAt)).not.toBeNaN();
    expect(Date.parse(record.finishedAt)).not.toBeNaN();
  });

  it("verify failure: no push, no PR, comments the failing line", async () => {
    workspace.verifyResult = { passed: false, summary: "error TS2322: nope" };

    const record = await pipeline.execute(job);

    expect(workspace.events.some((e) => e.startsWith("push:"))).toBe(false);
    expect(github.pullRequests).toHaveLength(0);
    expect(github.comments.at(-1)?.body).toContain("error TS2322: nope");
    expect(github.comments.at(-1)?.body).toContain("agent/issue-7");
    expect(record.outcome).toBe("verify_failed");
    expect(workspace.events.at(-1)).toBe(`cleanup:${DIR}`);
  });

  it("zero commits: no push, no PR, comments why", async () => {
    workspace.commits = 0;

    const record = await pipeline.execute(job);

    expect(workspace.events.some((e) => e.startsWith("push:"))).toBe(false);
    expect(github.pullRequests).toHaveLength(0);
    expect(github.comments.at(-1)?.body).toMatch(/no commits/i);
    expect(record).toMatchObject({ outcome: "no_commits", commits: 0, pullRequest: null });
    expect(workspace.events.at(-1)).toBe(`cleanup:${DIR}`);
  });

  it("agent error result: no verify, no push, comments the subtype", async () => {
    runner.result = {
      ok: false,
      subtype: "error_max_turns",
      costUsd: 2.5,
      numTurns: 12,
      summary: "",
    };

    const record = await pipeline.execute(job);

    expect(workspace.events).toEqual(["prepare:7", `cleanup:${DIR}`]);
    expect(github.pullRequests).toHaveLength(0);
    expect(github.comments.at(-1)?.body).toContain("error_max_turns");
    expect(record).toMatchObject({ outcome: "agent_error", verify: null });
  });

  it("runner throws: comments the failure, cleans up, and rethrows to fail the job", async () => {
    runner.error = new Error("Claude Code process exited with code 1");

    await expect(pipeline.execute(job)).rejects.toThrow("exited with code 1");

    expect(github.comments.at(-1)?.body).toContain("exited with code 1");
    expect(workspace.events).toEqual(["prepare:7", `cleanup:${DIR}`]);
    expect(github.pullRequests).toHaveLength(0);
  });

  it("prepare throws: nothing to clean up, still reports and rethrows", async () => {
    workspace.prepareError = new Error("git fetch failed");

    await expect(pipeline.execute(job)).rejects.toThrow("git fetch failed");

    expect(workspace.events).toEqual(["prepare:7"]);
    expect(runner.calls).toHaveLength(0);
    expect(github.comments.at(-1)?.body).toContain("git fetch failed");
  });

  it("falls back to a generic PR title when the issue title is blank", async () => {
    await pipeline.execute({ ...job, title: "   " });
    expect(github.pullRequests[0]?.title).toBe("Resolve issue #7");
  });
});
