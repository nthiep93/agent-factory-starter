import { describe, expect, it } from "vitest";
import { protectedPaths, verifyConfigPaths } from "./path-policy.js";

describe("protectedPaths", () => {
  it("flags CI, agent config, holdout and agent instructions at any depth", () => {
    const files = [
      ".github/workflows/ci.yml",
      ".claude/settings.json",
      "holdout/scenario-1.md",
      "AGENTS.md",
      "CLAUDE.md",
      "apps/web/AGENTS.md",
      "packages/x/CLAUDE.md",
      "apps/api/src/health/health.service.ts",
      "docs/github.md",
      "src/holdout/x.ts",
    ];
    expect(protectedPaths(files)).toEqual(files.slice(0, 7));
  });
});

describe("verifyConfigPaths", () => {
  it("flags every file that defines what pnpm verify checks", () => {
    const flagged = [
      "package.json",
      "apps/api/package.json",
      "turbo.json",
      "pnpm-workspace.yaml",
      "eslint.config.mjs",
      "apps/api/vitest.config.mts",
      "tsconfig.base.json",
      "apps/api/tsconfig.build.json",
      ".prettierrc.json",
      ".prettierignore",
      "scripts/agent-run.sh",
    ];
    const allowed = [
      "apps/api/src/app.module.ts",
      "docs/scripts.md",
      "apps/web/lib/package-json.ts",
      "pnpm-lock.yaml",
    ];
    expect(verifyConfigPaths([...flagged, ...allowed])).toEqual(flagged);
  });
});
