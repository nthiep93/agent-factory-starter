import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { APP_CONFIG, type OrchestratorConfig } from "../config/config.js";
import { TASK_QUEUE, type TaskQueue } from "../tasks/task-queue.js";
import type { TaskJobData } from "../tasks/task.types.js";
import { verifySignature } from "./signature.js";

export interface WebhookDelivery {
  rawBody: Buffer | undefined;
  signature: string | undefined;
  event: string | undefined;
  deliveryId: string | undefined;
}

export interface WebhookResponse {
  status: 200 | 202;
  body: Record<string, unknown>;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Turns a verified GitHub delivery into at most one queued task. Issue text is
 * copied as data only; nothing in the payload is executed or interpreted.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: OrchestratorConfig,
    @Inject(TASK_QUEUE) private readonly queue: TaskQueue,
  ) {}

  async handle(delivery: WebhookDelivery): Promise<WebhookResponse> {
    if (
      !delivery.rawBody ||
      !verifySignature(this.config.webhookSecret, delivery.rawBody, delivery.signature)
    ) {
      throw new UnauthorizedException("Invalid or missing X-Hub-Signature-256");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(delivery.rawBody.toString("utf8"));
    } catch {
      throw new BadRequestException(
        "Body must be JSON (set the webhook content type to application/json)",
      );
    }
    if (!isObject(payload)) throw new BadRequestException("Body must be a JSON object");

    const event = delivery.event ?? "";
    if (event === "ping") return { status: 200, body: { ok: true, event: "ping" } };
    if (event !== "issues") return ignored(`event ${event || "(none)"} is not handled`);
    return this.handleIssues(payload, delivery.deliveryId ?? "");
  }

  private async handleIssues(payload: Json, deliveryId: string): Promise<WebhookResponse> {
    if (payload.action !== "labeled") return ignored(`issues action ${String(payload.action)}`);

    const label = isObject(payload.label) ? payload.label.name : undefined;
    if (label !== this.config.triggerLabel) {
      return ignored(`label ${String(label)} is not ${this.config.triggerLabel}`);
    }

    const expectedRepo = `${this.config.repository.owner}/${this.config.repository.repo}`;
    const repo = isObject(payload.repository) ? payload.repository.full_name : undefined;
    if (typeof repo !== "string" || repo.toLowerCase() !== expectedRepo.toLowerCase()) {
      return ignored(
        `repository ${typeof repo === "string" ? repo : "(missing)"} is not ${expectedRepo}`,
      );
    }

    const issue = payload.issue;
    if (!isObject(issue) || !Number.isInteger(issue.number) || (issue.number as number) <= 0) {
      throw new BadRequestException("issues payload without a valid issue.number");
    }
    if ("pull_request" in issue) return ignored("labeled item is a pull request");
    if (issue.state === "closed") return ignored("issue is closed");

    const data: TaskJobData = {
      issueNumber: issue.number as number,
      title: typeof issue.title === "string" ? issue.title : "",
      body: typeof issue.body === "string" ? issue.body : "",
      labels: Array.isArray(issue.labels)
        ? issue.labels
            .map((l: unknown) => (isObject(l) && typeof l.name === "string" ? l.name : null))
            .filter((name): name is string => name !== null)
        : [],
      deliveryId,
    };

    const { jobId, created } = await this.queue.enqueue(data);
    this.logger.log(
      `issue #${data.issueNumber}: ${created ? "enqueued" : "already queued or running"} as ${jobId} (delivery ${deliveryId})`,
    );
    return { status: 202, body: { jobId, deduplicated: !created } };
  }
}

const ignored = (reason: string): WebhookResponse => ({ status: 202, body: { ignored: reason } });
