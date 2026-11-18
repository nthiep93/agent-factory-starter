import { describe, expect, it, vi } from "vitest";
import { describeVersion, fetchApiHealth, fetchApiVersion } from "./api";

const ok = { status: "ok", service: "api", uptimeSeconds: 3 };

describe("fetchApiHealth", () => {
  it("reports missing base URL without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const result = await fetchApiHealth(undefined, fetchImpl);
    expect(result.reachable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns data and strips a trailing slash", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(ok)));
    const result = await fetchApiHealth("https://api.example.com/", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.example.com/health", { cache: "no-store" });
    expect(result).toEqual({ reachable: true, data: ok });
  });

  it("reports non-2xx and network errors", async () => {
    const notOk = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    expect(await fetchApiHealth("https://x", notOk)).toEqual({
      reachable: false,
      reason: "API responded 503",
    });

    const boom = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await fetchApiHealth("https://x", boom)).toEqual({
      reachable: false,
      reason: "ECONNREFUSED",
    });
  });
});

describe("fetchApiVersion", () => {
  it("calls /version and returns the payload", async () => {
    const version = { service: "api", commit: "bfa1df8", branch: "main" };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(version)));
    const result = await fetchApiVersion("https://api.example.com", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("https://api.example.com/version", {
      cache: "no-store",
    });
    expect(result).toEqual({ reachable: true, data: version });
  });

  it("reports an unreachable API instead of throwing", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    expect(await fetchApiVersion("https://x", boom)).toEqual({
      reachable: false,
      reason: "ETIMEDOUT",
    });
  });
});

describe("describeVersion", () => {
  it("shows commit and branch", () => {
    expect(describeVersion({ service: "web", commit: "bfa1df8", branch: "main" })).toBe(
      "bfa1df8 (main)",
    );
  });

  it("shows the commit alone without a branch", () => {
    expect(describeVersion({ service: "web", commit: "bfa1df8", branch: null })).toBe("bfa1df8");
  });

  it("shows local outside Vercel", () => {
    expect(describeVersion({ service: "web", commit: null, branch: null })).toBe("local");
  });
});
