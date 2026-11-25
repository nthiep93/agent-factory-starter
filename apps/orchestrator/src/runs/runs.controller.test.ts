import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { APP_CONFIG } from "../config/config.js";
import { TASK_QUEUE } from "../tasks/task-queue.js";
import { FakeTaskQueue, testConfig } from "../testing/fakes.js";
import { RunsController } from "./runs.controller.js";
import { RunsService } from "./runs.service.js";

const data = (n: number) => ({
  issueNumber: n,
  title: `Issue ${n}`,
  body: "",
  labels: ["agent"],
  deliveryId: `d-${n}`,
});

describe("RunsController", () => {
  let queue: FakeTaskQueue;
  let controller: RunsController;

  beforeEach(async () => {
    queue = new FakeTaskQueue();
    const moduleRef = await Test.createTestingModule({
      controllers: [RunsController],
      providers: [
        RunsService,
        { provide: TASK_QUEUE, useValue: queue },
        { provide: APP_CONFIG, useValue: testConfig({ githubToken: "ghp_test_token" }) },
      ],
    }).compile();
    controller = moduleRef.get(RunsController);
  });

  it("maps queue snapshots to runs with ISO timestamps", async () => {
    queue.snapshots = [
      {
        id: "issue-2",
        state: "failed",
        data: data(2),
        createdAt: Date.UTC(2026, 0, 1, 10),
        startedAt: Date.UTC(2026, 0, 1, 10, 1),
        finishedAt: Date.UTC(2026, 0, 1, 10, 5),
        record: null,
        failedReason: "git fetch failed for ghp_test_token",
      },
      {
        id: "issue-1",
        state: "waiting",
        data: data(1),
        createdAt: Date.UTC(2026, 0, 1, 9),
        startedAt: null,
        finishedAt: null,
        record: null,
        failedReason: null,
      },
    ];

    const { runs } = await controller.list();

    expect(runs).toEqual([
      {
        id: "issue-2",
        issueNumber: 2,
        title: "Issue 2",
        state: "failed",
        createdAt: "2026-01-01T10:00:00.000Z",
        startedAt: "2026-01-01T10:01:00.000Z",
        finishedAt: "2026-01-01T10:05:00.000Z",
        record: null,
        failedReason: "git fetch failed for [REDACTED]",
      },
      {
        id: "issue-1",
        issueNumber: 1,
        title: "Issue 1",
        state: "waiting",
        createdAt: "2026-01-01T09:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        record: null,
        failedReason: null,
      },
    ]);
  });

  it("redacts the whole run record, including blocked paths and verify summary", async () => {
    queue.snapshots = [
      {
        id: "issue-3",
        state: "completed",
        data: { ...data(3), title: "leak ghp_test_token" },
        createdAt: 1,
        startedAt: 1,
        finishedAt: 2,
        record: {
          issueNumber: 3,
          branch: "agent/issue-3",
          outcome: "protected_paths",
          agent: { ok: true, subtype: "success", costUsd: 0, numTurns: 1 },
          verify: { passed: false, summary: "ghp_test_token" },
          commits: 1,
          headSha: "a".repeat(40),
          blockedPaths: [".github/ghp_test_token.yml"],
          pullRequest: null,
          startedAt: "x",
          finishedAt: "y",
        },
        failedReason: null,
      },
    ];
    const [run] = (await controller.list()).runs;
    expect(JSON.stringify(run)).not.toContain("ghp_test_token");
    expect(run?.record?.blockedPaths).toEqual([".github/[REDACTED].yml"]);
    expect(run?.title).toBe("leak [REDACTED]");
  });

  it("applies the limit and validates it", async () => {
    queue.snapshots = [1, 2, 3].map((n) => ({
      id: `issue-${n}`,
      state: "completed" as const,
      data: data(n),
      createdAt: n,
      startedAt: n,
      finishedAt: n,
      record: null,
      failedReason: null,
    }));
    expect((await controller.list("2")).runs).toHaveLength(2);
    expect((await controller.list()).runs).toHaveLength(3);
    await expect(controller.list("0")).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.list("abc")).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.list("101")).rejects.toBeInstanceOf(BadRequestException);
  });
});
