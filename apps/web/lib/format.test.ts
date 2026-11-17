import { describe, expect, it } from "vitest";
import { formatUptime } from "./format";

describe("formatUptime", () => {
  it("formats seconds only", () => {
    expect(formatUptime(7)).toBe("7s");
  });

  it("formats minutes and hours with padding", () => {
    expect(formatUptime(65)).toBe("1m 05s");
    expect(formatUptime(3723)).toBe("1h 02m 03s");
  });

  it("clamps negative input to zero", () => {
    expect(formatUptime(-5)).toBe("0s");
  });
});
