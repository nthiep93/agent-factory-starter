import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";
import { APP_OPTIONS, setupApp } from "./app.setup.js";
import { ConfigError, loadConfig, redactConfig } from "./config/config.js";

async function bootstrap(): Promise<void> {
  const logger = new Logger("Orchestrator");
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const app = setupApp(
    await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), APP_OPTIONS),
  );
  await app.listen(config.port);
  logger.log(`listening on port ${config.port}: ${JSON.stringify(redactConfig(config))}`);
}

void bootstrap();
