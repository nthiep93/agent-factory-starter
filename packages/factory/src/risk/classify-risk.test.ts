import { describe, expect, it } from "vitest";
import { classifyRisk, type PullRequestFile, type RiskContext, type RiskLevel } from "./index";

const file = (
  status: string,
  filename: string,
  additions: number,
  deletions: number,
  previous_filename?: string,
): PullRequestFile => ({
  filename,
  status,
  additions,
  deletions,
  ...(previous_filename ? { previous_filename } : {}),
});
/** Modified, additions only. */
const mod = (filename: string, additions = 5, deletions = 0) =>
  file("modified", filename, additions, deletions);
const add = (filename: string, additions = 5) => file("added", filename, additions, 0);
const del = (filename: string, deletions = 5) => file("removed", filename, 0, deletions);

interface Case {
  name: string;
  files: PullRequestFile[];
  level: RiskLevel;
  /** Substring that must appear in at least one reason. */
  reason: string;
  context?: RiskContext;
}

// prettier-ignore
const cases: Case[] = [
  // high: guardrails and agent config
  { name: "workflow change", files: [mod(".github/workflows/ci.yml")], level: "high", reason: "guardrail" },
  { name: "agent settings", files: [mod(".claude/settings.json")], level: "high", reason: "guardrail" },
  { name: "agent rule markdown", files: [mod(".claude/rules/api.md")], level: "high", reason: "guardrail" },
  { name: "holdout scenario", files: [add("holdout/new.test.mjs")], level: "high", reason: "holdout/new.test.mjs" },
  { name: "CODEOWNERS at root", files: [mod("CODEOWNERS")], level: "high", reason: "guardrail" },
  { name: "CODEOWNERS in docs/", files: [mod("docs/CODEOWNERS")], level: "high", reason: "guardrail" },
  { name: "root AGENTS.md", files: [mod("AGENTS.md")], level: "high", reason: "guardrail" },
  { name: "nested AGENTS.md", files: [mod("apps/web/AGENTS.md")], level: "high", reason: "guardrail" },
  { name: "nested CLAUDE.md", files: [add("packages/shared/CLAUDE.md")], level: "high", reason: "guardrail" },
  { name: "CLAUDE.local.md", files: [add("apps/api/CLAUDE.local.md")], level: "high", reason: "guardrail" },
  { name: "root .mcp.json", files: [add(".mcp.json")], level: "high", reason: "guardrail" },
  { name: "nested .mcp.json", files: [add("apps/web/.mcp.json")], level: "high", reason: "guardrail" },
  // high: verification config at any depth
  { name: "root package.json", files: [mod("package.json")], level: "high", reason: "verification config" },
  { name: "workspace package.json", files: [mod("apps/web/package.json")], level: "high", reason: "verification config" },
  { name: "tsconfig", files: [mod("apps/api/tsconfig.json")], level: "high", reason: "verification config" },
  { name: "tsconfig variant", files: [mod("packages/shared/tsconfig.build.json")], level: "high", reason: "verification config" },
  { name: "prettierrc", files: [mod(".prettierrc.json")], level: "high", reason: "verification config" },
  { name: "prettier config", files: [add("prettier.config.mjs")], level: "high", reason: "verification config" },
  { name: "prettierignore", files: [mod(".prettierignore")], level: "high", reason: "verification config" },
  { name: "eslint config", files: [mod("eslint.config.mjs")], level: "high", reason: "verification config" },
  { name: "legacy eslintrc", files: [add("apps/web/.eslintrc.json")], level: "high", reason: "verification config" },
  { name: "vitest config", files: [mod("apps/api/vitest.config.mts")], level: "high", reason: "verification config" },
  { name: "turbo config", files: [mod("turbo.json")], level: "high", reason: "verification config" },
  { name: "workspace file", files: [mod("pnpm-workspace.yaml")], level: "high", reason: "verification config" },
  { name: "npmrc", files: [add(".npmrc")], level: "high", reason: "verification config" },
  { name: ".env file", files: [add(".env.production")], level: "high", reason: "secret" },
  { name: "rename out of holdout", files: [file("renamed", "tmp/x.test.mjs", 0, 0, "holdout/x.test.mjs")], level: "high", reason: "holdout/x.test.mjs" },
  // high: case is ignored
  { name: "upper-case .GITHUB", files: [mod(".GITHUB/workflows/x.yml")], level: "high", reason: "guardrail" },
  { name: "upper-case HOLDOUT", files: [add("Holdout/x.test.mjs")], level: "high", reason: "guardrail" },
  { name: "mixed-case Package.JSON", files: [mod("apps/web/Package.JSON")], level: "high", reason: "verification config" },
  { name: "upper-case AUTH", files: [mod("apps/api/src/AUTH/x.ts")], level: "high", reason: "sensitive" },
  // high: sensitive areas
  { name: "auth folder", files: [mod("apps/api/src/auth/auth.service.ts")], level: "high", reason: "sensitive" },
  { name: "camelCase segment", files: [mod("apps/web/lib/authGuard.ts")], level: "high", reason: "sensitive" },
  { name: "security doc", files: [mod("docs/security.md")], level: "high", reason: "sensitive" },
  { name: "secrets folder", files: [add("secrets/key.txt")], level: "high", reason: "sensitive" },
  { name: "payments plural", files: [mod("apps/api/src/payments/x.ts")], level: "high", reason: "sensitive" },
  { name: "billing kebab", files: [mod("apps/web/app/user-billing/page.tsx")], level: "high", reason: "sensitive" },
  { name: "crypto util", files: [mod("packages/shared/src/crypto.ts")], level: "high", reason: "sensitive" },
  // high: weakened tests, size, file modes, incomplete lists
  { name: "test deleted", files: [del("apps/web/lib/api.test.ts")], level: "high", reason: "test file deleted" },
  { name: "test renamed to non-test", files: [file("renamed", "apps/web/lib/api.ts", 0, 0, "apps/web/lib/api.test.ts")], level: "high", reason: "test file deleted" },
  { name: "more than 800 lines", files: [mod("apps/web/lib/a.ts", 500, 301)], level: "high", reason: "801" },
  { name: "801 lines across files", files: [mod("docs/a.md", 400), mod("docs/b.md", 401)], level: "high", reason: "801" },
  { name: "status changed (mode only)", files: [file("changed", "docs/a.md", 0, 0)], level: "high", reason: "mode" },
  { name: "symlink or mode change in diff", files: [mod("docs/a.md")], context: { modeOrSymlinkChange: true }, level: "high", reason: "symlink" },
  { name: "fewer files than GitHub reports", files: [mod("docs/a.md")], context: { expectedFileCount: 2 }, level: "high", reason: "incomplete" },
  { name: "more files than GitHub reports", files: [mod("docs/a.md"), mod("docs/b.md")], context: { expectedFileCount: 1 }, level: "high", reason: "incomplete" },
  { name: "3000 files (API cap)", files: Array.from({ length: 3000 }, (_, i) => mod(`docs/f${i}.md`, 0)), context: { expectedFileCount: 3000 }, level: "high", reason: "3000" },
  { name: "control character in a file name", files: [mod("docs/a.md\n::set-output name=level::low")], level: "high", reason: "control character" },
  // medium
  { name: "empty list", files: [], level: "medium", reason: "no changed files" },
  { name: "lockfile only", files: [mod("pnpm-lock.yaml")], level: "medium", reason: "lockfile" },
  { name: "shared contract", files: [mod("packages/shared/src/version.ts")], level: "medium", reason: "shared" },
  { name: "api source", files: [mod("apps/api/src/health/health.service.ts")], level: "medium", reason: "source" },
  { name: "web page", files: [mod("apps/web/app/page.tsx")], level: "medium", reason: "source" },
  { name: "unknown file", files: [mod("scripts/dev.sh")], level: "medium", reason: "not docs or tests" },
  { name: "tests plus source", files: [mod("apps/web/lib/format.ts"), mod("apps/web/lib/format.test.ts")], level: "medium", reason: "source" },
  { name: "docs over 300 lines", files: [add("docs/big.md", 301)], level: "medium", reason: "301" },
  { name: "800 lines exactly is not high", files: [mod("apps/web/lib/a.ts", 400, 400)], level: "medium", reason: "source" },
  { name: "test with deleted lines", files: [mod("apps/web/lib/format.test.ts", 2, 10)], level: "medium", reason: "lines removed from test" },
  { name: "renamed test with deleted lines", files: [file("renamed", "apps/web/lib/b.test.ts", 0, 3, "apps/web/lib/a.test.ts")], level: "medium", reason: "lines removed from test" },
  { name: "copied doc", files: [file("copied", "docs/b.md", 5, 0, "docs/a.md")], level: "medium", reason: "copied" },
  { name: "copy from a guardrail", files: [file("copied", "docs/ci.md", 5, 0, ".github/workflows/ci.yml")], level: "high", reason: "guardrail" },
  { name: "file count matches", files: [mod("apps/web/app/page.tsx")], context: { expectedFileCount: 1 }, level: "medium", reason: "source" },
  // low
  { name: "one doc", files: [mod("docs/architecture.md", 5, 3)], level: "low", reason: "docs or tests" },
  { name: "spec file", files: [add("specs/login.yaml")], level: "low", reason: "docs or tests" },
  { name: "nested readme", files: [mod("apps/web/README.md")], level: "low", reason: "docs or tests" },
  { name: "new test", files: [add("apps/web/lib/format.test.ts")], level: "low", reason: "docs or tests" },
  { name: "test with additions only", files: [mod("apps/web/app/page.test.tsx", 12, 0)], level: "low", reason: "docs or tests" },
  { name: "doc deleted", files: [del("docs/old.md")], level: "low", reason: "docs or tests" },
  { name: "docs and tests, 300 lines", files: [add("docs/a.md", 150), add("apps/web/lib/x.test.ts", 150)], level: "low", reason: "300" },
  { name: "leading ./ is normalised", files: [mod("./docs/a.md")], level: "low", reason: "docs or tests" },
  { name: "upper-case doc name", files: [mod("docs/GUIDE.MD")], level: "low", reason: "docs or tests" },
];

describe("classifyRisk", () => {
  it.each(cases)("$name -> $level", ({ files, level, reason, context }) => {
    const result = classifyRisk(files, context);
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

  it("quotes file names so control characters cannot start a new output line", () => {
    const evil = "docs/a.md\n::set-output name=level::low";
    const result = classifyRisk([mod(evil), mod(".github/x\r\n::error::y.yml")]);
    expect(result.level).toBe("high");
    for (const reason of result.reasons) expect(reason).not.toMatch(/[\r\n]/);
    expect(result.reasons.join(" ")).toContain(JSON.stringify(".github/x\r\n::error::y.yml"));
  });

  it("ignores missing or negative line counts instead of crashing", () => {
    const odd = { filename: "docs/a.md", status: "modified", additions: -3, deletions: Number.NaN };
    expect(classifyRisk([odd]).level).toBe("low");
  });
});

function rank(level: string): number {
  return level === "high" ? 2 : level === "medium" ? 1 : 0;
}
