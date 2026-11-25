// End-to-end tests for scripts/factory-metrics.mjs.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildFactory, fakeGh, runScript } from "../spec/script-test-helpers.mjs";

let distDir;
beforeAll(() => {
  distDir = buildFactory();
}, 120_000);

const run = (args, opts = {}) => runScript("factory-metrics.mjs", args, { distDir, ...opts });

const H = (hours) => new Date(Date.parse("2026-11-01T00:00:00Z") + hours * 3_600_000).toISOString();
const botCommit = { committedDate: H(0.2), authors: [{ login: "", name: "claude[bot]" }] };

// Field names as `gh pr list --json` returns them.
const FIXTURE = [
  {
    number: 11,
    headRefName: "claude/issue-3-20261101",
    state: "MERGED",
    createdAt: H(0),
    mergedAt: H(2),
    closedAt: H(2),
    author: { login: "nthiep93", is_bot: false },
    commits: [botCommit],
    reviews: [{ author: { login: "rev" }, state: "APPROVED", submittedAt: H(1) }],
    labels: [{ name: "agent" }, { name: "risk:low" }],
    additions: 40,
    deletions: 3,
  },
  {
    number: 12,
    headRefName: "claude/issue-4-20261101",
    state: "MERGED",
    createdAt: H(0),
    mergedAt: H(30),
    closedAt: H(30),
    author: { login: "nthiep93" },
    commits: [botCommit, { committedDate: H(5), authors: [{ login: "nthiep93" }] }],
    reviews: [{ author: { login: "rev" }, state: "CHANGES_REQUESTED", submittedAt: H(4) }],
    labels: [{ name: "risk:medium" }],
    additions: 120,
    deletions: 30,
  },
  {
    number: 13,
    headRefName: "agent/login-form",
    state: "CLOSED",
    createdAt: H(1),
    mergedAt: null,
    closedAt: H(3),
    author: { login: "nthiep93" },
    commits: [],
    reviews: [],
    labels: [{ name: "risk:low" }],
    additions: 5,
    deletions: 0,
  },
  {
    number: 14,
    headRefName: "feat/manual-work",
    state: "MERGED",
    createdAt: H(0),
    mergedAt: H(1),
    closedAt: H(1),
    author: { login: "nthiep93" },
    commits: [],
    reviews: [],
    labels: [],
    additions: 1,
    deletions: 1,
  },
];

const writeJson = (value) => {
  const file = join(mkdtempSync(join(tmpdir(), "metrics-")), "prs.json");
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
};

describe("factory-metrics --input", () => {
  it("prints a compact report", () => {
    const { status, stdout, stderr } = run(["--input", writeJson(FIXTURE)]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("Agent PRs (claude/*, agent/*), all fetched: 3");
    expect(stdout).toMatch(/merged +2\n/);
    expect(stdout).toMatch(/closed unmerged +1\n/);
    expect(stdout).toMatch(/open +0\n/);
    expect(stdout).toContain("Merge rate:     67%");
    expect(stdout).toContain("Rework rate:    50% (1 of 2 merged: #12)");
    expect(stdout).toContain("Time to merge:  median 16.0h, p90 30.0h (n=2)");
    expect(stdout).toContain("First review:   median 2.5h (n=2)");
    expect(stdout).toMatch(/ {2}low +2 +1 +1 +0 +50% +0%\n/);
    expect(stdout).toMatch(/ {2}medium +1 +1 +0 +0 +100% +100%\n/);
    expect(stdout).not.toMatch(/ {2}high /);
  });

  it("prints raw metrics with --json and applies --days relative to --now", () => {
    const { status, stdout } = run([
      "--input",
      writeJson(FIXTURE),
      "--json",
      "--days",
      "1",
      "--now",
      H(24.5),
    ]);
    expect(status).toBe(0);
    const metrics = JSON.parse(stdout);
    // Only #13 (created at hour 1) falls inside the 24h window ending at hour 24.5.
    expect(metrics).toMatchObject({ total: 1, closedUnmerged: 1, sinceDays: 1 });
    expect(metrics.generatedAt).toBe(H(24.5));
  });

  it("handles an empty list", () => {
    const { status, stdout } = run(["--input", writeJson([])]);
    expect(status).toBe(0);
    expect(stdout).toContain("all fetched: 0");
    expect(stdout).toContain("Merge rate:     n/a");
    expect(stdout).toContain("(no agent PRs)");
  });

  it("rejects invalid input and arguments", () => {
    expect(run(["--input", writeJson("{not json")]).stderr).toContain("Input is not valid JSON");
    expect(run(["--input", writeJson({ a: 1 })]).stderr).toContain("must be a JSON array");
    expect(run(["--input", "/nonexistent.json"]).status).toBe(1);
    expect(run(["--days", "-3", "--input", writeJson([])]).status).toBe(2);
    expect(run(["--now", "yesterday", "--input", writeJson([])]).status).toBe(2);
    expect(run(["--bogus"]).status).toBe(2);
    expect(run(["--input"]).status).toBe(2);
  });
});

const FIELDS =
  "number,headRefName,state,createdAt,mergedAt,closedAt,author,commits,reviews,labels,closingIssuesReferences,additions,deletions";

describe("factory-metrics --issues", () => {
  it("takes the per-risk breakdown from the linked issues' labels", () => {
    // #11 is on claude/issue-3-..., and issue 3 is risk:high; its PR label says risk:low.
    const issues = writeJson([{ number: 3, labels: [{ name: "risk:high" }] }]);
    const { status, stdout } = run(["--input", writeJson(FIXTURE), "--issues", issues]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/ {2}high +1 +1 +0 +0 +100% +0%\n/);
    expect(stdout).toMatch(/ {2}low +1 +0 +1 +0 +0% +n\/a\n/);
  });
});

describe("factory-metrics without --input", () => {
  it("asks gh for all PRs and issue labels with the documented fields", () => {
    const gh = fakeGh();
    const env = { FAKE_GH_PRS: writeJson(FIXTURE), FAKE_GH_ISSUES: writeJson([]) };
    const { status, stdout, stderr } = run([], { gh, env });
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("all fetched: 3");
    expect(gh.readCalls().map((c) => c.args)).toEqual([
      ["pr", "list", "--state", "all", "--limit", "200", "--json", FIELDS],
      ["issue", "list", "--state", "all", "--limit", "500", "--json", "number,labels"],
    ]);
  });

  it("narrows the gh search with --days and warns when the limit is hit", () => {
    const gh = fakeGh();
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...FIXTURE[0],
      number: 1000 + i,
      createdAt: H(10),
    }));
    const env = { FAKE_GH_PRS: writeJson(many), FAKE_GH_ISSUES: writeJson([]) };
    const { status, stdout, stderr } = run(["--days", "3", "--now", H(48)], { gh, env });
    expect(status).toBe(0);
    expect(stdout).toContain("last 3 days: 200");
    expect(gh.readCalls()[0].args).toEqual([
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      "200",
      "--search",
      "created:>=2026-10-31",
      "--json",
      FIELDS,
    ]);
    expect(stderr).toContain(
      "Warning: gh returned exactly 200 PRs (the --limit); older PRs may be missing. Use a smaller --days.",
    );
  });
});
