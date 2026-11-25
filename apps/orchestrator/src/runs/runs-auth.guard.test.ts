import "reflect-metadata";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { APP_OPTIONS, setupApp } from "../app.setup.js";
import { APP_CONFIG } from "../config/config.js";
import { TASK_QUEUE } from "../tasks/task-queue.js";
import { FakeTaskQueue, testConfig } from "../testing/fakes.js";
import { checkRunsAccess } from "./runs-auth.guard.js";
import { RunsController } from "./runs.controller.js";
import { RunsService } from "./runs.service.js";

describe("checkRunsAccess", () => {
  it("without a token, allows only loopback peers", () => {
    expect(checkRunsAccess(undefined, "127.0.0.1", null)).toBe("ok");
    expect(checkRunsAccess(undefined, "::1", null)).toBe("ok");
    expect(checkRunsAccess(undefined, "::ffff:127.0.0.1", null)).toBe("ok");
    expect(checkRunsAccess(undefined, "10.0.0.5", null)).toBe("forbidden");
    expect(checkRunsAccess(undefined, "::ffff:203.0.113.9", null)).toBe("forbidden");
    expect(checkRunsAccess(undefined, undefined, null)).toBe("forbidden");
  });

  it("with a token, requires the exact bearer token from any address, loopback included", () => {
    expect(checkRunsAccess("Bearer s3cret-token", "10.0.0.5", "s3cret-token")).toBe("ok");
    expect(checkRunsAccess("bearer s3cret-token", "10.0.0.5", "s3cret-token")).toBe("ok");
    expect(checkRunsAccess(undefined, "127.0.0.1", "s3cret-token")).toBe("unauthorized");
    expect(checkRunsAccess("Bearer wrong", "127.0.0.1", "s3cret-token")).toBe("unauthorized");
    expect(checkRunsAccess("Bearer s3cret-token-x", "::1", "s3cret-token")).toBe("unauthorized");
    expect(checkRunsAccess("Basic s3cret-token", "::1", "s3cret-token")).toBe("unauthorized");
  });
});

describe("GET /runs over HTTP", () => {
  let app: NestExpressApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(runsApiToken: string | null): Promise<string> {
    const moduleRef = await Test.createTestingModule({
      controllers: [RunsController],
      providers: [
        RunsService,
        { provide: TASK_QUEUE, useValue: new FakeTaskQueue() },
        { provide: APP_CONFIG, useValue: testConfig({ runsApiToken }) },
      ],
    }).compile();
    app = setupApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
    app.useLogger(false);
    await app.listen(0, "127.0.0.1");
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    return `http://127.0.0.1:${port}/runs`;
  }

  it("answers loopback requests when no token is configured", async () => {
    const url = await start(null);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runs: [] });
  });

  it("requires the bearer token when RUNS_API_TOKEN is set", async () => {
    const url = await start("runs-token-123");
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const ok = await fetch(url, { headers: { authorization: "Bearer runs-token-123" } });
    expect(ok.status).toBe(200);
  });
});
