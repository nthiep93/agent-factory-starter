import { describe, expect, it } from "vitest";
import { buildHealth } from "./index";

describe("buildHealth", () => {
  it("returns ok with floored uptime", () => {
    expect(buildHealth("api", 12.9)).toEqual({ status: "ok", service: "api", uptimeSeconds: 12 });
  });

  it("returns degraded for invalid uptime", () => {
    expect(buildHealth("api", -1).status).toBe("degraded");
    expect(buildHealth("api", Number.NaN).status).toBe("degraded");
  });
});
