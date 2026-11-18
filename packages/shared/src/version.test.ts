import { describe, expect, it } from "vitest";
import { buildVersion } from "./version";

describe("buildVersion", () => {
  it("shortens the Vercel commit SHA and reads the branch", () => {
    expect(
      buildVersion("api", {
        VERCEL_GIT_COMMIT_SHA: "bfa1df8e51ab10ae1c819a5f358a4f30e36f8b5b",
        VERCEL_GIT_COMMIT_REF: "main",
      }),
    ).toEqual({ service: "api", commit: "bfa1df8", branch: "main" });
  });

  it("returns nulls outside Vercel", () => {
    expect(buildVersion("web", {})).toEqual({ service: "web", commit: null, branch: null });
  });

  it("treats empty or blank values as missing", () => {
    expect(buildVersion("api", { VERCEL_GIT_COMMIT_SHA: " ", VERCEL_GIT_COMMIT_REF: "" })).toEqual({
      service: "api",
      commit: null,
      branch: null,
    });
  });
});
