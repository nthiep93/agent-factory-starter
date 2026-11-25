import { Controller, Get } from "@nestjs/common";
import { buildHealth, type HealthResponse } from "@repo/shared";

@Controller("health")
export class HealthController {
  @Get()
  check(): HealthResponse {
    return buildHealth("orchestrator", process.uptime());
  }
}
