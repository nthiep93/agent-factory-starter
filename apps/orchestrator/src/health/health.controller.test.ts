import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { HealthController } from "./health.controller.js";

describe("HealthController", () => {
  it("resolves through Nest DI and reports ok for the orchestrator", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();

    const result = moduleRef.get(HealthController).check();

    expect(result.status).toBe("ok");
    expect(result.service).toBe("orchestrator");
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
