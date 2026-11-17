import { Injectable } from "@nestjs/common";
import { buildHealth, type HealthResponse } from "@repo/shared";

@Injectable()
export class HealthService {
  check(): HealthResponse {
    return buildHealth("api", process.uptime());
  }
}
