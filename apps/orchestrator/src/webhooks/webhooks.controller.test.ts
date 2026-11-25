import "reflect-metadata";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APP_OPTIONS, setupApp } from "../app.setup.js";
import { APP_CONFIG } from "../config/config.js";
import { TASK_QUEUE } from "../tasks/task-queue.js";
import { FakeTaskQueue, testConfig } from "../testing/fakes.js";
import { signPayload } from "./signature.js";
import { WebhooksController } from "./webhooks.controller.js";
import { WebhooksService } from "./webhooks.service.js";

const SECRET = "test-webhook-secret";

const labeledPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: "labeled",
  label: { name: "agent" },
  issue: {
    number: 7,
    title: "Add /ping",
    body: "Return pong. $(rm -rf /) `whoami`",
    state: "open",
    labels: [{ name: "agent" }, { name: "api" }],
  },
  repository: { full_name: "acme/widgets" },
  ...overrides,
});

describe("WebhooksController over HTTP (raw body + signature)", () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  const queue = new FakeTaskQueue();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        WebhooksService,
        { provide: APP_CONFIG, useValue: testConfig({ webhookSecret: SECRET }) },
        { provide: TASK_QUEUE, useValue: queue },
      ],
    }).compile();
    app = setupApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
    app.useLogger(false);
    await app.listen(0, "127.0.0.1");
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => queue.reset());

  afterAll(async () => {
    await app.close();
  });

  async function send(
    event: string,
    payload: unknown,
    options: { secret?: string; signature?: string | null; rawBody?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const raw = options.rawBody ?? JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": "delivery-1",
    };
    const signature =
      options.signature === undefined
        ? signPayload(options.secret ?? SECRET, Buffer.from(raw))
        : options.signature;
    if (signature !== null) headers["x-hub-signature-256"] = signature;
    const response = await fetch(`${baseUrl}/webhooks/github`, {
      method: "POST",
      headers,
      body: raw,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("enqueues a labeled issue with jobId issue-<n> and answers 202", async () => {
    const res = await send("issues", labeledPayload());

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ jobId: "issue-7", deduplicated: false });
    expect(queue.enqueued).toEqual([
      {
        issueNumber: 7,
        title: "Add /ping",
        body: "Return pong. $(rm -rf /) `whoami`",
        labels: ["agent", "api"],
        deliveryId: "delivery-1",
      },
    ]);
  });

  it("deduplicates a re-label while the job is queued", async () => {
    await send("issues", labeledPayload());
    const again = await send("issues", labeledPayload());
    expect(again.status).toBe(202);
    expect(again.body).toEqual({ jobId: "issue-7", deduplicated: true });
    expect(queue.enqueued).toHaveLength(1);
  });

  it("verifies the exact bytes, not a re-serialised body", async () => {
    const raw = `{ "action":"labeled",  "label":{"name":"agent"},\n "issue":{"number":8,"title":"t","body":null,"labels":[]}}`;
    const res = await send("issues", null, { rawBody: raw });
    expect(res.status).toBe(202);
    expect(queue.enqueued[0]).toMatchObject({ issueNumber: 8, body: "" });
  });

  it("ignores another label", async () => {
    const res = await send("issues", labeledPayload({ label: { name: "bug" } }));
    expect(res.status).toBe(202);
    expect(res.body.ignored).toMatch(/label bug/);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("ignores another action", async () => {
    const res = await send("issues", labeledPayload({ action: "opened" }));
    expect(res.status).toBe(202);
    expect(res.body.ignored).toMatch(/opened/);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("ignores another event", async () => {
    const res = await send("push", { ref: "refs/heads/main" });
    expect(res.status).toBe(202);
    expect(res.body.ignored).toMatch(/push/);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("ignores a closed issue and another repository", async () => {
    const closed = labeledPayload();
    (closed.issue as Record<string, unknown>).state = "closed";
    expect((await send("issues", closed)).body.ignored).toMatch(/closed/);
    const other = await send("issues", labeledPayload({ repository: { full_name: "evil/repo" } }));
    expect(other.body.ignored).toMatch(/evil\/repo/);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("answers ping with 200", async () => {
    const res = await send("ping", { zen: "Keep it logically awesome.", hook_id: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, event: "ping" });
  });

  it("rejects a bad signature with 401 and enqueues nothing", async () => {
    const res = await send("issues", labeledPayload(), { secret: "wrong" });
    expect(res.status).toBe(401);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("rejects a missing signature with 401, even for ping", async () => {
    expect((await send("issues", labeledPayload(), { signature: null })).status).toBe(401);
    expect((await send("ping", {}, { signature: null })).status).toBe(401);
    expect((await send("ping", {}, { signature: "sha256=00" })).status).toBe(401);
  });

  it("rejects a labeled payload without an issue number with 400", async () => {
    const res = await send("issues", labeledPayload({ issue: { title: "no number" } }));
    expect(res.status).toBe(400);
  });
});
