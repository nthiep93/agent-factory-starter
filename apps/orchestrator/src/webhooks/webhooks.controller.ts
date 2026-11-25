import type { IncomingMessage } from "node:http";
import { Controller, Headers, Post, Req, Res, type RawBodyRequest } from "@nestjs/common";
import { WebhooksService } from "./webhooks.service.js";

/** The one response method the controller needs from Express. */
interface StatusResponse {
  status(code: number): unknown;
}

@Controller("webhooks")
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /** Needs `NestFactory.create(..., { rawBody: true })`: the HMAC covers the exact bytes. */
  @Post("github")
  async github(
    @Req() req: RawBodyRequest<IncomingMessage>,
    @Res({ passthrough: true }) res: StatusResponse,
    @Headers("x-hub-signature-256") signature: string | undefined,
    @Headers("x-github-event") event: string | undefined,
    @Headers("x-github-delivery") deliveryId: string | undefined,
  ): Promise<Record<string, unknown>> {
    const result = await this.webhooks.handle({
      rawBody: req.rawBody,
      signature,
      event,
      deliveryId,
    });
    res.status(result.status);
    return result.body;
  }
}
