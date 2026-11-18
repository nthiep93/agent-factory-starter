import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { HealthController } from "./health.controller.js";
import { HealthService } from "./health.service.js";

describe("HealthController", () => {
  it("resolves through Nest DI and reports ok", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [HealthService],
    }).compile();

    const result = moduleRef.get(HealthController).check();

    expect(result.status).toBe("ok");
    expect(result.service).toBe("api");
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
