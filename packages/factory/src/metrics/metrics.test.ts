import { describe, expect, it } from "vitest";
import {
  computeFactoryMetrics,
  isAgentPr,
  isReworked,
  median,
  percentile,
  riskOf,
  type GhPullRequest,
} from "./index";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");
const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString();
const NOW = new Date(T0 + 30 * 24 * HOUR);

const BOT_COMMIT = { committedDate: at(0.5), authors: [{ login: "", name: "claude[bot]" }] };

let seq = 1;
const pr = (overrides: Partial<GhPullRequest> = {}): GhPullRequest => ({
  number: seq++,
  headRefName: "claude/issue-1-20261101",
  state: "MERGED",
  createdAt: at(0),
  mergedAt: at(2),
  closedAt: at(2),
  author: { login: "nthiep93" },
  commits: [BOT_COMMIT],
  reviews: [],
  labels: [{ name: "risk:low" }],
  additions: 10,
  deletions: 2,
  ...overrides,
});

describe("median and percentile", () => {
  it("return null for no values", () => {
    expect(median([])).toBeNull();
    expect(percentile([], 90)).toBeNull();
  });

  it("median averages the two middle values of an even list", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
  });

  it("percentile uses nearest rank", () => {
    const values = [10, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(percentile(values, 90)).toBe(9);
    expect(percentile(values, 100)).toBe(10);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([1, 2], 90)).toBe(2);
  });
});

describe("isAgentPr", () => {
  it("matches claude/ and agent/ branches only", () => {
    expect(isAgentPr(pr({ headRefName: "claude/issue-4" }))).toBe(true);
    expect(isAgentPr(pr({ headRefName: "agent/login-form" }))).toBe(true);
    expect(isAgentPr(pr({ headRefName: "feat/claude-thing" }))).toBe(false);
    expect(isAgentPr(pr({ headRefName: "Claude/x" }))).toBe(false);
    expect(isAgentPr(pr({ headRefName: "" }))).toBe(false);
  });
});

describe("riskOf", () => {
  it("reads risk:* labels, picks the highest when several, else unlabeled", () => {
    expect(riskOf(pr({ labels: [{ name: "agent" }, { name: "risk:medium" }] }))).toBe("medium");
    expect(riskOf(pr({ labels: [{ name: "risk:low" }, { name: "risk:high" }] }))).toBe("high");
    expect(riskOf(pr({ labels: [{ name: "risk:weird" }] }))).toBe("unlabeled");
    expect(riskOf(pr({ labels: undefined }))).toBe("unlabeled");
  });
});

describe("isReworked", () => {
  it("is false for an untouched merged agent PR", () => {
    expect(isReworked(pr())).toBe(false);
  });

  it("is false for PRs that are not merged", () => {
    const changes = [{ state: "CHANGES_REQUESTED", submittedAt: at(1), author: { login: "a" } }];
    expect(isReworked(pr({ state: "OPEN", mergedAt: null, reviews: changes }))).toBe(false);
  });

  it("is true when a review requested changes", () => {
    const reviews = [{ state: "CHANGES_REQUESTED", submittedAt: at(1), author: { login: "a" } }];
    expect(isReworked(pr({ reviews }))).toBe(true);
  });

  it("is true when a commit lands after the first review", () => {
    const reviews = [{ state: "COMMENTED", submittedAt: at(1), author: { login: "a" } }];
    const commits = [BOT_COMMIT, { committedDate: at(1.5), authors: [{ login: "" }] }];
    expect(isReworked(pr({ reviews, commits }))).toBe(true);
  });

  it("ignores pending reviews and commits before the first review", () => {
    const reviews = [
      { state: "PENDING", submittedAt: null, author: { login: "a" } },
      { state: "APPROVED", submittedAt: at(1.9), author: { login: "a" } },
    ];
    expect(isReworked(pr({ reviews }))).toBe(false);
  });

  it("is true on a claude/ branch when a commit is authored only by humans", () => {
    const commits = [BOT_COMMIT, { committedDate: at(0.6), authors: [{ login: "nthiep93" }] }];
    expect(isReworked(pr({ commits }))).toBe(true);
  });

  it("does not count a bot commit with a human co-author", () => {
    const commits = [{ committedDate: at(0.6), authors: [{ login: "" }, { login: "nthiep93" }] }];
    expect(isReworked(pr({ commits }))).toBe(false);
  });

  it("treats [bot] logins and configured logins as bots", () => {
    const commits = [
      { committedDate: at(0.6), authors: [{ login: "github-actions[bot]" }] },
      { committedDate: at(0.7), authors: [{ login: "My-Runner" }] },
    ];
    expect(isReworked(pr({ commits }), ["my-runner"])).toBe(false);
    expect(isReworked(pr({ commits }))).toBe(true);
  });

  it("does not apply the human-commit rule to agent/ branches (local runs commit as the human)", () => {
    const commits = [{ committedDate: at(0.6), authors: [{ login: "nthiep93" }] }];
    expect(isReworked(pr({ headRefName: "agent/x", commits }))).toBe(false);
  });
});

describe("computeFactoryMetrics", () => {
  it("handles empty input", () => {
    const zero = {
      total: 0,
      merged: 0,
      closedUnmerged: 0,
      open: 0,
      mergeRate: null,
      reworked: 0,
      reworkRate: null,
    };
    expect(computeFactoryMetrics([], NOW)).toEqual({
      ...zero,
      generatedAt: NOW.toISOString(),
      sinceDays: null,
      timeToMerge: { count: 0, medianMs: null, p90Ms: null },
      timeToFirstReview: { count: 0, medianMs: null },
      reworkedPrs: [],
      byRisk: { low: zero, medium: zero, high: zero, unlabeled: zero },
    });
  });

  it("ignores PRs that are not from agent branches", () => {
    const metrics = computeFactoryMetrics([pr({ headRefName: "feat/x" })], NOW);
    expect(metrics.total).toBe(0);
  });

  it("counts outcomes, rates, times and the per-risk breakdown", () => {
    const changes = [{ state: "CHANGES_REQUESTED", submittedAt: at(3), author: { login: "r" } }];
    const comment = (h: number) => [
      { state: "COMMENTED", submittedAt: at(h), author: { login: "r" } },
    ];
    const prs: GhPullRequest[] = [
      // merged after 2h, first review after 1h
      pr({ number: 1, mergedAt: at(2), reviews: comment(1) }),
      // merged after 4h, reworked (changes requested), first review after 3h
      pr({
        number: 2,
        mergedAt: at(4),
        reviews: changes,
        labels: [{ name: "risk:medium" }, { name: "agent" }],
      }),
      // merged after 10h, agent/ branch, unlabeled, no review
      pr({ number: 3, headRefName: "agent/foo", mergedAt: at(10), labels: [] }),
      // closed without merge
      pr({ number: 4, state: "CLOSED", mergedAt: null, closedAt: at(5) }),
      // open, reviewed after 6h
      pr({ number: 5, state: "OPEN", mergedAt: null, closedAt: null, reviews: comment(6) }),
      // not an agent PR
      pr({ number: 6, headRefName: "main-fix" }),
    ];
    const metrics = computeFactoryMetrics(prs, NOW);

    expect(metrics).toMatchObject({
      total: 5,
      merged: 3,
      closedUnmerged: 1,
      open: 1,
      mergeRate: 0.75,
      reworked: 1,
      reworkRate: 1 / 3,
      reworkedPrs: [2],
      timeToMerge: { count: 3, medianMs: 4 * HOUR, p90Ms: 10 * HOUR },
      timeToFirstReview: { count: 3, medianMs: 3 * HOUR },
    });
    expect(metrics.byRisk).toEqual({
      low: {
        total: 3,
        merged: 1,
        closedUnmerged: 1,
        open: 1,
        mergeRate: 0.5,
        reworked: 0,
        reworkRate: 0,
      },
      medium: {
        total: 1,
        merged: 1,
        closedUnmerged: 0,
        open: 0,
        mergeRate: 1,
        reworked: 1,
        reworkRate: 1,
      },
      high: {
        total: 0,
        merged: 0,
        closedUnmerged: 0,
        open: 0,
        mergeRate: null,
        reworked: 0,
        reworkRate: null,
      },
      unlabeled: {
        total: 1,
        merged: 1,
        closedUnmerged: 0,
        open: 0,
        mergeRate: 1,
        reworked: 0,
        reworkRate: 0,
      },
    });
  });

  it("treats a PR with mergedAt as merged even if state says CLOSED", () => {
    const metrics = computeFactoryMetrics([pr({ state: "CLOSED", mergedAt: at(1) })], NOW);
    expect(metrics).toMatchObject({ merged: 1, closedUnmerged: 0 });
  });

  it("filters by sinceDays relative to now", () => {
    const prs = [
      pr({ number: 1, createdAt: new Date(NOW.getTime() - 2 * 24 * HOUR).toISOString() }),
      pr({ number: 2, createdAt: new Date(NOW.getTime() - 9 * 24 * HOUR).toISOString() }),
    ];
    const metrics = computeFactoryMetrics(prs, NOW, { sinceDays: 7 });
    expect(metrics.total).toBe(1);
    expect(metrics.sinceDays).toBe(7);
  });

  it("skips timings it cannot compute from bad or missing dates", () => {
    const prs = [
      pr({ createdAt: "not a date", mergedAt: at(1) }),
      pr({ mergedAt: "garbage", reviews: [{ state: "COMMENTED", submittedAt: "nope" }] }),
      pr({ reviews: undefined, commits: undefined, labels: undefined }),
    ];
    const metrics = computeFactoryMetrics(prs, NOW);
    expect(metrics.total).toBe(3);
    expect(metrics.timeToMerge.count).toBe(1);
    expect(metrics.timeToFirstReview.count).toBe(0);
  });

  it("does not mutate its input", () => {
    const prs = [pr({ labels: [{ name: "risk:high" }] })];
    const copy: unknown = JSON.parse(JSON.stringify(prs));
    computeFactoryMetrics(prs, NOW);
    expect(prs).toEqual(copy);
  });
});
