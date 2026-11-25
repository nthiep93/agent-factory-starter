// In-memory fakes of the ports, shared by the tests. Excluded from the build.
import type { AgentRunInput, AgentRunResult, AgentRunner } from "../agent/agent-runner.js";
import type { OrchestratorConfig } from "../config/config.js";
import {
  GitHubApiError,
  type CreatePullRequestInput,
  type GitHubClient,
  type PullRequestRef,
} from "../github/github-client.js";
import type { EnqueueResult, ListedState, TaskQueue, TaskSnapshot } from "../tasks/task-queue.js";
import { taskJobId, type TaskJobData } from "../tasks/task.types.js";
import type { PreparedWorkspace, VerifyResult, Workspace } from "../workspace/workspace.js";

export const testConfig = (overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig => ({
  webhookSecret: "test-webhook-secret",
  githubToken: "ghp_test_token",
  repository: { owner: "acme", repo: "widgets" },
  redisUrl: "redis://localhost:6390",
  repoDir: "/srv/repo",
  worktreesDir: "/srv/worktrees",
  triggerLabel: "agent",
  agentMaxTurns: 40,
  agentMaxBudgetUsd: 3,
  agentConcurrency: 2,
  port: 3100,
  runsApiToken: null,
  agentEnvScrub: "off",
  ...overrides,
});

export class FakeTaskQueue implements TaskQueue {
  readonly enqueued: TaskJobData[] = [];
  snapshots: TaskSnapshot[] = [];
  private readonly pending = new Set<string>();

  reset(): void {
    this.enqueued.length = 0;
    this.pending.clear();
    this.snapshots = [];
  }

  async enqueue(data: TaskJobData): Promise<EnqueueResult> {
    const jobId = taskJobId(data.issueNumber);
    if (this.pending.has(jobId)) return { jobId, created: false };
    this.pending.add(jobId);
    this.enqueued.push(data);
    return { jobId, created: true };
  }

  async list(states: readonly ListedState[], limit: number): Promise<TaskSnapshot[]> {
    return this.snapshots
      .filter((s) => (states as readonly string[]).includes(s.state))
      .slice(0, limit);
  }
}

export class FakeAgentRunner implements AgentRunner {
  readonly calls: AgentRunInput[] = [];
  result: AgentRunResult = {
    ok: true,
    subtype: "success",
    costUsd: 0.42,
    numTurns: 9,
    summary: "Implemented the change with tests.",
  };
  error: Error | null = null;
  /** Runs inside run(), e.g. to simulate the agent committing. */
  onRun: ((input: AgentRunInput) => void | Promise<void>) | null = null;

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.calls.push(input);
    if (this.onRun) await this.onRun(input);
    if (this.error) throw this.error;
    return this.result;
  }
}

export class FakeWorkspace implements Workspace {
  readonly events: string[] = [];
  verifyResult: VerifyResult = { passed: true, summary: "Tasks:    6 successful, 6 total" };
  commits = 1;
  clean = true;
  changed: string[] = ["apps/api/src/ping/ping.controller.ts"];
  prepareError: Error | null = null;
  pushError: Error | null = null;

  async prepare(issueNumber: number): Promise<PreparedWorkspace> {
    this.events.push(`prepare:${issueNumber}`);
    if (this.prepareError) throw this.prepareError;
    return { dir: `/srv/worktrees/issue-${issueNumber}`, branch: `agent/issue-${issueNumber}` };
  }

  async isClean(dir: string): Promise<boolean> {
    this.events.push(`isClean:${dir}`);
    return this.clean;
  }

  async changedFiles(dir: string): Promise<string[]> {
    this.events.push(`changedFiles:${dir}`);
    return this.changed;
  }

  async verify(dir: string): Promise<VerifyResult> {
    this.events.push(`verify:${dir}`);
    return this.verifyResult;
  }

  async commitsAhead(dir: string): Promise<number> {
    this.events.push(`commitsAhead:${dir}`);
    return this.commits;
  }

  async push(dir: string, branch: string): Promise<void> {
    this.events.push(`push:${dir}:${branch}`);
    if (this.pushError) throw this.pushError;
  }

  async cleanup(dir: string): Promise<void> {
    this.events.push(`cleanup:${dir}`);
  }
}

export class FakeGitHubClient implements GitHubClient {
  readonly pullRequests: CreatePullRequestInput[] = [];
  readonly comments: { issueNumber: number; body: string }[] = [];
  readonly lookups: string[] = [];
  commentError: Error | null = null;
  /** Comments whose body matches fail, the others are recorded. */
  failCommentsMatching: RegExp | null = null;
  createError: Error | null = null;
  openPullRequest: PullRequestRef | null = null;

  /** GitHub's answer when a PR for the head branch is already open. */
  static alreadyExists(): GitHubApiError {
    return new GitHubApiError(
      "GitHub API POST /repos/acme/widgets/pulls failed with 422: Validation Failed; A pull request already exists for acme:agent/issue-7.",
      422,
    );
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
    if (this.createError) throw this.createError;
    this.pullRequests.push(input);
    const number = 100 + this.pullRequests.length;
    return { number, url: `https://github.com/acme/widgets/pull/${number}` };
  }

  async findOpenPullRequest(branch: string): Promise<PullRequestRef | null> {
    this.lookups.push(branch);
    return this.openPullRequest;
  }

  async commentOnIssue(issueNumber: number, body: string): Promise<void> {
    if (this.commentError) throw this.commentError;
    if (this.failCommentsMatching?.test(body)) throw new Error("GitHub API comment failed");
    this.comments.push({ issueNumber, body });
  }
}
