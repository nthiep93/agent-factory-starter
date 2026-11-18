import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller.js";
import { HealthService } from "./health/health.service.js";
import { VersionController } from "./version/version.controller.js";
import { VersionService } from "./version/version.service.js";

@Module({
  controllers: [HealthController, VersionController],
  providers: [HealthService, VersionService],
})
export class AppModule {}
