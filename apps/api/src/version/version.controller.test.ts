import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VersionController } from "./version.controller.js";
import { VersionService } from "./version.service.js";

describe("VersionController", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("resolves through Nest DI and reports the deployed commit", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0123456789abcdef");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "feat/x");

    const moduleRef = await Test.createTestingModule({
      controllers: [VersionController],
      providers: [VersionService],
    }).compile();

    expect(moduleRef.get(VersionController).get()).toEqual({
      service: "api",
      commit: "0123456",
      branch: "feat/x",
    });
  });
});
