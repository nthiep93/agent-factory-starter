import { describe, expect, it } from "vitest";
import { classifyRisk, type PullRequestFile, type RiskLevel } from "./index";

const mod = (filename: string, additions = 5, deletions = 1): PullRequestFile => ({
  filename,
  status: "modified",
  additions,
  deletions,
});
const add = (filename: string, additions = 5): PullRequestFile => ({
  filename,
  status: "added",
  additions,
  deletions: 0,
});
const del = (filename: string, deletions = 5): PullRequestFile => ({
  filename,
  status: "removed",
  additions: 0,
  deletions,
});

interface Case {
  name: string;
  files: PullRequestFile[];
  level: RiskLevel;
  /** Substring that must appear in at least one reason. */
  reason: string;
}

const cases: Case[] = [
  // high: guardrails
  {
    name: "workflow change",
    files: [mod(".github/workflows/ci.yml")],
    level: "high",
    reason: "guardrail",
  },
  {
    name: "agent settings",
    files: [mod(".claude/settings.json")],
    level: "high",
    reason: "guardrail",
  },
  {
    name: "agent rule markdown",
    files: [mod(".claude/rules/api.md")],
    level: "high",
    reason: "guardrail",
  },
  {
    name: "holdout scenario",
    files: [add("holdout/new.test.mjs")],
    level: "high",
    reason: "holdout/new.test.mjs",
  },
  { name: "CODEOWNERS at root", files: [mod("CODEOWNERS")], level: "high", reason: "guardrail" },
  {
    name: "CODEOWNERS in docs/",
    files: [mod("docs/CODEOWNERS")],
    level: "high",
    reason: "guardrail",
  },
  { name: "root AGENTS.md", files: [mod("AGENTS.md")], level: "high", reason: "guardrail" },
  { name: "root CLAUDE.md", files: [mod("CLAUDE.md")], level: "high", reason: "guardrail" },
  {
    name: "root package.json",
    files: [mod("package.json")],
    level: "high",
    reason: "verification gate",
  },
  {
    name: "eslint config",
    files: [mod("eslint.config.mjs")],
    level: "high",
    reason: "verification gate",
  },
  {
    name: "vitest config",
    files: [mod("apps/api/vitest.config.mts")],
    level: "high",
    reason: "verification gate",
  },
  { name: "turbo config", files: [mod("turbo.json")], level: "high", reason: "verification gate" },
  { name: ".env file", files: [add(".env.production")], level: "high", reason: "secret" },
  {
    name: "rename out of holdout",
    files: [
      { ...mod("tmp/x.test.mjs"), status: "renamed", previous_filename: "holdout/x.test.mjs" },
    ],
    level: "high",
    reason: "holdout/x.test.mjs",
  },
  // high: sensitive areas
  {
    name: "auth folder",
    files: [mod("apps/api/src/auth/auth.service.ts")],
    level: "high",
    reason: "sensitive",
  },
  {
    name: "camelCase segment",
    files: [mod("apps/web/lib/authGuard.ts")],
    level: "high",
    reason: "sensitive",
  },
  { name: "security doc", files: [mod("docs/security.md")], level: "high", reason: "sensitive" },
  { name: "secrets folder", files: [add("secrets/key.txt")], level: "high", reason: "sensitive" },
  {
    name: "payments plural",
    files: [mod("apps/api/src/payments/x.ts")],
    level: "high",
    reason: "sensitive",
  },
  {
    name: "billing kebab",
    files: [mod("apps/web/app/user-billing/page.tsx")],
    level: "high",
    reason: "sensitive",
  },
  {
    name: "crypto util",
    files: [mod("packages/shared/src/crypto.ts")],
    level: "high",
    reason: "sensitive",
  },
  // high: weakened tests, size
  {
    name: "test deleted",
    files: [del("apps/web/lib/api.test.ts")],
    level: "high",
    reason: "test file deleted",
  },
  {
    name: "test renamed to non-test",
    files: [
      {
        ...mod("apps/web/lib/api.ts"),
        status: "renamed",
        previous_filename: "apps/web/lib/api.test.ts",
      },
    ],
    level: "high",
    reason: "test file deleted",
  },
  {
    name: "more than 800 lines",
    files: [mod("apps/web/lib/a.ts", 500, 301)],
    level: "high",
    reason: "801",
  },
  {
    name: "801 lines across files",
    files: [mod("docs/a.md", 400, 0), mod("docs/b.md", 400, 1)],
    level: "high",
    reason: "801",
  },
  // medium
  { name: "empty list", files: [], level: "medium", reason: "no changed files" },
  {
    name: "workspace package.json",
    files: [mod("apps/web/package.json")],
    level: "medium",
    reason: "dependencies",
  },
  { name: "lockfile", files: [mod("pnpm-lock.yaml")], level: "medium", reason: "dependencies" },
  {
    name: "shared contract",
    files: [mod("packages/shared/src/version.ts")],
    level: "medium",
    reason: "shared",
  },
  {
    name: "api source",
    files: [mod("apps/api/src/health/health.service.ts")],
    level: "medium",
    reason: "source",
  },
  { name: "web page", files: [mod("apps/web/app/page.tsx")], level: "medium", reason: "source" },
  {
    name: "unknown file",
    files: [mod("scripts/dev.sh")],
    level: "medium",
    reason: "not docs or tests",
  },
  {
    name: "tests plus source",
    files: [mod("apps/web/lib/format.ts"), mod("apps/web/lib/format.test.ts")],
    level: "medium",
    reason: "source",
  },
  { name: "docs over 300 lines", files: [add("docs/big.md", 301)], level: "medium", reason: "301" },
  {
    name: "800 lines exactly is not high",
    files: [mod("apps/web/lib/a.ts", 400, 400)],
    level: "medium",
    reason: "source",
  },
  // low
  { name: "one doc", files: [mod("docs/architecture.md")], level: "low", reason: "docs or tests" },
  { name: "spec file", files: [add("specs/login.yaml")], level: "low", reason: "docs or tests" },
  {
    name: "nested readme",
    files: [mod("apps/web/README.md")],
    level: "low",
    reason: "docs or tests",
  },
  {
    name: "new test",
    files: [add("apps/web/lib/format.test.ts")],
    level: "low",
    reason: "docs or tests",
  },
  {
    name: "tsx test",
    files: [mod("apps/web/app/page.test.tsx")],
    level: "low",
    reason: "docs or tests",
  },
  { name: "doc deleted", files: [del("docs/old.md")], level: "low", reason: "docs or tests" },
  {
    name: "docs and tests, 300 lines",
    files: [add("docs/a.md", 150), add("apps/web/lib/x.test.ts", 150)],
    level: "low",
    reason: "300",
  },
  {
    name: "leading ./ is normalised",
    files: [mod("./docs/a.md")],
    level: "low",
    reason: "docs or tests",
  },
];

describe("classifyRisk", () => {
  it.each(cases)("$name -> $level", ({ files, level, reason }) => {
    const result = classifyRisk(files);
    expect(result.level).toBe(level);
    expect(result.reasons.some((r) => r.includes(reason))).toBe(true);
  });

  it("reports the highest level and lists every reason, highest first", () => {
    const result = classifyRisk([
      mod("docs/a.md"),
      mod("apps/api/src/main.ts"),
      mod(".github/workflows/ci.yml"),
      del("apps/api/src/health/health.controller.test.ts"),
    ]);
    expect(result.level).toBe("high");
    expect(result.reasons[0]).toMatch(/^high: /);
    expect(result.reasons.some((r) => r.startsWith("high: test file deleted"))).toBe(true);
    expect(result.reasons.some((r) => r.startsWith("medium: "))).toBe(true);
    const levels = result.reasons.map((r) => r.split(":")[0] ?? "");
    expect(levels).toEqual([...levels].sort((a, b) => rank(b) - rank(a)));
  });

  it("does not treat words that only contain a sensitive word as sensitive", () => {
    expect(classifyRisk([mod("docs/author-guide.md")]).level).toBe("low");
    expect(classifyRisk([mod("apps/web/lib/cryptocurrency-prices.ts")]).level).toBe("medium");
  });

  it("caps the file list in one reason", () => {
    const files = Array.from({ length: 12 }, (_, i) => mod(`.github/f${i}.yml`, 1, 0));
    const reason = classifyRisk(files).reasons.find((r) => r.includes("guardrail")) ?? "";
    expect(reason).toContain("(+7 more)");
  });

  it("ignores missing or negative line counts instead of crashing", () => {
    const odd = { filename: "docs/a.md", status: "modified", additions: -3, deletions: Number.NaN };
    expect(classifyRisk([odd]).level).toBe("low");
  });
});

function rank(level: string): number {
  return level === "high" ? 2 : level === "medium" ? 1 : 0;
}
