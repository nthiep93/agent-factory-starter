import { describe, expect, it } from "vitest";
import { FACTORY_PACKAGE } from "./index";

describe("@repo/factory", () => {
  it("exposes its package name", () => {
    expect(FACTORY_PACKAGE).toBe("@repo/factory");
  });
});
