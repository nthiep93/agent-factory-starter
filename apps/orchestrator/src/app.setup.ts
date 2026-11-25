import type { NestApplicationOptions } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";

/** rawBody: the webhook HMAC is computed over the exact bytes GitHub sent. */
export const APP_OPTIONS: NestApplicationOptions = { rawBody: true };

/** Shared by main.ts and the HTTP tests so both exercise the same setup. */
export function setupApp(app: NestExpressApplication): NestExpressApplication {
  // GitHub caps payloads at 25 MB, issue events are far smaller; 1 MB leaves room for long bodies.
  app.useBodyParser("json", { limit: "1mb" });
  app.enableShutdownHooks();
  return app;
}
