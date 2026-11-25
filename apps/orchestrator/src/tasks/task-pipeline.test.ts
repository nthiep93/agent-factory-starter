import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_RUNNER } from "../agent/agent-runner.js";
import { APP_CONFIG } from "../config/config.js";
import { GITHUB_CLIENT } from "../github/github-client.js";
import {
  FAKE_HEAD_SHA,
  FakeAgentRunner,
  FakeGitHubClient,
  FakeWorkspace,
  testConfig,
} from "../testing/fakes.js";
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
const TOKEN = "ghp_test_token";
const ANTHROPIC_KEY = "sk-ant-api03-test-key-value";

describe("TaskPipeline", () => {
  let runner: FakeAgentRunner;
  let workspace: FakeWorkspace;
  let github: FakeGitHubClient;
  let pipeline: TaskPipeline;

  beforeEach(async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", ANTHROPIC_KEY);
    runner = new FakeAgentRunner();
    workspace = new FakeWorkspace();
    github = new FakeGitHubClient();
    const moduleRef = await Test.createTestingModule({
      providers: [
        TaskPipeline,
        {
          provide: APP_CONFIG,
          useValue: testConfig({ githubToken: TOKEN, agentMaxTurns: 12, agentMaxBudgetUsd: 1.5 }),
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

  afterEach(() => vi.unstubAllEnvs());

  const pushed = (): boolean => workspace.events.some((e) => e.startsWith("push:"));

  it("success: runs the agent, checks, verifies, pushes, opens a PR and links it", async () => {
    const record = await pipeline.execute(job);

    expect(github.comments[0]?.body).toMatch(/picked up/i);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ cwd: DIR, maxTurns: 12, maxBudgetUsd: 1.5 });
    expect(runner.calls[0]?.prompt).toContain("Add a /ping endpoint");
    expect(runner.calls[0]?.prompt).toMatch(/<untrusted-issue-[0-9a-f]+>/);

    expect(workspace.events).toEqual([
      "prepare:7",
      `isClean:${DIR}`,
      `headSha:${DIR}`,
      `changedFiles:${DIR}@${FAKE_HEAD_SHA}`,
      `commitsAhead:${DIR}@${FAKE_HEAD_SHA}`,
      `verify:${DIR}`,
      `push:${DIR}:agent/issue-7@${FAKE_HEAD_SHA}`,
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
      headSha: FAKE_HEAD_SHA,
      blockedPaths: [],
      verify: { passed: true, summary: "Tasks:    6 successful, 6 total" },
      agent: { ok: true, subtype: "success", costUsd: 0.42, numTurns: 9 },
      pullRequest: { number: 101, url: "https://github.com/acme/widgets/pull/101" },
    });
    expect(Date.parse(record.startedAt)).not.toBeNaN();
    expect(Date.parse(record.finishedAt)).not.toBeNaN();
  });

  it("redacts secrets from comments, the PR body, the record and the failure reason", async () => {
    runner.result = {
      ...runner.result,
      summary: `Done. Debug: token=${TOKEN} key=${ANTHROPIC_KEY} other=ghp_abcdefghijklmnopqrstuvwxyz012345`,
    };
    workspace.verifyResult = { passed: true, summary: `Tasks: ok ${TOKEN}` };

    const record = await pipeline.execute(job);

    const outbound = [
      ...github.comments.map((c) => c.body),
      ...github.pullRequests.map((p) => p.body),
      JSON.stringify(record),
    ].join("\n");
    expect(outbound).not.toContain(TOKEN);
    expect(outbound).not.toContain(ANTHROPIC_KEY);
    expect(outbound).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz012345");
    expect(github.pullRequests[0]?.body).toContain("[REDACTED]");

    runner.error = new Error(`spawn failed with GITHUB_TOKEN=${TOKEN}`);
    const error = await pipeline.execute(job).then(
      () => new Error("expected a failure"),
      (e: unknown) => e as Error,
    );
    expect(error.message).toBe("spawn failed with GITHUB_TOKEN=[REDACTED]");
    expect(github.comments.at(-1)?.body).not.toContain(TOKEN);
  });

  it("redacts before truncating: secrets straddling the summary, quote and title cuts", async () => {
    // PR body keeps 10 000 summary characters, quote() 1 500, the title 200.
    runner.result = { ...runner.result, summary: `${"s".repeat(9_995)}${TOKEN} tail` };
    await pipeline.execute({ ...job, title: `${"t".repeat(195)}${TOKEN}` });
    const body = github.pullRequests[0]?.body ?? "";
    expect(body).not.toContain(TOKEN.slice(0, 5));
    expect(github.pullRequests[0]?.title).not.toContain(TOKEN.slice(0, 5));

    runner.result = {
      ok: false,
      subtype: "error_during_execution",
      costUsd: 0,
      numTurns: 1,
      summary: `${"q".repeat(1_495)}${TOKEN}`,
    };
    await pipeline.execute(job);
    expect(github.comments.at(-1)?.body).not.toContain(TOKEN.slice(0, 5));
  });

  it("a blocked path containing a secret is redacted in the record and the comment", async () => {
    workspace.changed = [`.github/${TOKEN}.yml`];
    const record = await pipeline.execute(job);
    expect(record.blockedPaths).toEqual([".github/[REDACTED].yml"]);
    expect(github.comments.at(-1)?.body).not.toContain(TOKEN);
  });

  it("HEAD not descending from the base fails the run before any push", async () => {
    workspace.headError = new Error("HEAD x does not descend from the fetched base y");
    await expect(pipeline.execute(job)).rejects.toThrow(/does not descend/);
    expect(workspace.events.some((e) => e.startsWith("push:"))).toBe(false);
    expect(workspace.events.at(-1)).toBe(`cleanup:${DIR}`);
  });

  it("verify failure: no push, no PR, comments the failing line", async () => {
    workspace.verifyResult = { passed: false, summary: "error TS2322: nope" };

    const record = await pipeline.execute(job);

    expect(pushed()).toBe(false);
    expect(github.pullRequests).toHaveLength(0);
    expect(github.comments.at(-1)?.body).toContain("error TS2322: nope");
    expect(github.comments.at(-1)?.body).toContain("agent/issue-7");
    expect(record.outcome).toBe("verify_failed");
    expect(workspace.events.at(-1)).toBe(`cleanup:${DIR}`);
  });

  it("zero commits: no verify, no push, no PR, comments why", async () => {
    workspace.commits = 0;

    const record = await pipeline.execute(job);

    expect(workspace.events.some((e) => e.startsWith("verify:"))).toBe(false);
    expect(pushed()).toBe(false);
    expect(github.pullRequests).toHaveLength(0);
    expect(github.comments.at(-1)?.body).toMatch(/no commits/i);
    expect(record).toMatchObject({ outcome: "no_commits", commits: 0, pullRequest: null });
    expect(workspace.events.at(-1)).toBe(`cleanup:${DIR}`);
  });

  it("dirty tree: no verify, no push, outcome dirty_tree", async () => {
    workspace.clean = false;

    const record = await pipeline.execute(job);

    expect(record.outcome).toBe("dirty_tree");
    expect(workspace.events).toEqual(["prepare:7", `isClean:${DIR}`, `cleanup:${DIR}`]);
    expect(github.comments.at(-1)?.body).toMatch(/uncommitted changes/);
    expect(github.pullRequests).toHaveLength(0);
  });

  it("protected paths: refuses and lists them", async () => {
    workspace.changed = [
      "apps/api/src/x.ts",
      ".github/workflows/ci.yml",
      "holdout/a.md",
      "apps/web/AGENTS.md",
    ];

    const record = await pipeline.execute(job);

    expect(record).toMatchObject({
      outcome: "protected_paths",
      blockedPaths: [".github/workflows/ci.yml", "holdout/a.md", "apps/web/AGENTS.md"],
    });
    const comment = github.comments.at(-1)?.body ?? "";
    expect(comment).toContain("`.github/workflows/ci.yml`");
    expect(comment).toContain("`holdout/a.md`");
    expect(comment).toContain("`apps/web/AGENTS.md`");
    expect(comment).not.toContain("apps/api/src/x.ts");
    expect(workspace.events.some((e) => e.startsWith("verify:"))).toBe(false);
    expect(pushed()).toBe(false);
  });

  it("verify config changed: refuses before running verify", async () => {
    workspace.changed = ["apps/api/src/x.ts", "apps/api/package.json", "eslint.config.mjs"];

    const record = await pipeline.execute(job);

    expect(record).toMatchObject({
      outcome: "verify_config_changed",
      blockedPaths: ["apps/api/package.json", "eslint.config.mjs"],
    });
    expect(github.comments.at(-1)?.body).toContain("`apps/api/package.json`");
    expect(workspace.events.some((e) => e.startsWith("verify:"))).toBe(false);
    expect(pushed()).toBe(false);
  });

  it("agent error result: no checks, no push, comments the subtype", async () => {
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

  it("push fails: no PR, failure comment, cleanup, rethrow", async () => {
    workspace.pushError = new Error("git push failed (exit 1): stale info");

    await expect(pipeline.execute(job)).rejects.toThrow("stale info");

    expect(github.pullRequests).toHaveLength(0);
    expect(github.lookups).toHaveLength(0);
    expect(github.comments.at(-1)?.body).toContain("stale info");
    expect(workspace.events.at(-1)).toBe(`cleanup:${DIR}`);
  });

  it("PR creation fails: failure comment, cleanup, rethrow", async () => {
    github.createError = new Error("GitHub API POST /repos/acme/widgets/pulls failed with 500");

    await expect(pipeline.execute(job)).rejects.toThrow("failed with 500");

    expect(pushed()).toBe(true);
    expect(github.lookups).toHaveLength(0);
    expect(github.comments.at(-1)?.body).toContain("failed with 500");
    expect(workspace.events.at(-1)).toBe(`cleanup:${DIR}`);
  });

  it("PR already exists (422): links the open PR, outcome pr_updated", async () => {
    github.createError = FakeGitHubClient.alreadyExists();
    github.openPullRequest = { number: 55, url: "https://github.com/acme/widgets/pull/55" };

    const record = await pipeline.execute(job);

    expect(github.lookups).toEqual(["agent/issue-7"]);
    expect(record).toMatchObject({
      outcome: "pr_updated",
      pullRequest: { number: 55, url: "https://github.com/acme/widgets/pull/55" },
    });
    expect(github.comments.at(-1)?.body).toContain("https://github.com/acme/widgets/pull/55");
    expect(github.comments.at(-1)?.body).toMatch(/Updated the existing pull request #55/);
  });

  it("422 without an open PR still fails the run", async () => {
    github.createError = FakeGitHubClient.alreadyExists();

    await expect(pipeline.execute(job)).rejects.toThrow(/422/);
    expect(github.lookups).toEqual(["agent/issue-7"]);
  });

  it("a failing PR-link comment does not fail a run whose PR was opened", async () => {
    github.failCommentsMatching = /^Opened #/;

    const record = await pipeline.execute(job);

    expect(record.outcome).toBe("pr_opened");
    expect(github.pullRequests).toHaveLength(1);
    expect(github.comments.some((c) => /run failed/.test(c.body))).toBe(false);
    expect(workspace.events.at(-1)).toBe(`cleanup:${DIR}`);
  });

  it("falls back to a generic PR title when the issue title is blank", async () => {
    await pipeline.execute({ ...job, title: "   " });
    expect(github.pullRequests[0]?.title).toBe("Resolve issue #7");
  });
});
