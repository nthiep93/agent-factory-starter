import { describe, expect, it, vi } from "vitest";
import { fetchApiHealth } from "./api";

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
