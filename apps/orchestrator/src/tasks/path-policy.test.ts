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
  it("flags every file that defines what pnpm verify installs and checks", () => {
    const flagged = [
      "package.json",
      "apps/api/package.json",
      "turbo.json",
      "apps/web/turbo.json",
      "pnpm-workspace.yaml",
      // Intended behaviour change (integrator decision): lockfile-only changes stop the run too.
      "pnpm-lock.yaml",
      ".pnpmfile.cjs",
      "pnpmfile.cjs",
      ".npmrc",
      "apps/api/.npmrc",
      ".swcrc",
      "eslint.config.mjs",
      "apps/api/vitest.config.mts",
      "vitest.workspace.ts",
      "apps/web/next.config.ts",
      "tsconfig.base.json",
      "apps/api/tsconfig.build.json",
      ".prettierrc.json",
      ".prettierignore",
      ".gitattributes",
      "scripts/agent-run.sh",
      "packages/factory/scripts/gen.mjs",
    ];
    const allowed = [
      "apps/api/src/app.module.ts",
      "docs/scripts.md",
      "apps/web/lib/package-json.ts",
      "apps/web/lib/scripts.ts",
    ];
    expect(verifyConfigPaths([...flagged, ...allowed])).toEqual(flagged);
  });
});
