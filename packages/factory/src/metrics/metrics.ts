import {
  RISK_BUCKETS,
  type FactoryMetrics,
  type GhCommit,
  type GhCommitAuthor,
  type GhReview,
  type GhPullRequest,
  type MetricsOptions,
  type OutcomeCounts,
  type RiskBucket,
} from "./types";

const DAY_MS = 86_400_000;

/** Branch prefixes agents push to: claude/ from the GitHub workflow, agent/ from local runs. */
export const AGENT_BRANCH_PREFIXES = ["claude/", "agent/"] as const;

/** Commit-author logins that are automation even without a `[bot]` suffix. */
export const DEFAULT_BOT_LOGINS = [
  "claude",
  "github-actions",
  "dependabot",
  "copilot-swe-agent",
] as const;

const RISK_RANK: Readonly<Record<RiskBucket, number>> = {
  unlabeled: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const time = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** Median; the mean of the two middle values for an even count. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

/** Nearest-rank percentile: the smallest value with at least p% of values at or below it. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}

export const isAgentPr = (pr: GhPullRequest): boolean =>
  AGENT_BRANCH_PREFIXES.some((prefix) => (pr.headRefName ?? "").startsWith(prefix));

const isMerged = (pr: GhPullRequest): boolean => pr.state === "MERGED" || Boolean(pr.mergedAt);

const ISSUE_BRANCH = /^(?:claude|agent)\/issue-(\d+)(?:-|$)/;

/**
 * Issues the PR belongs to: its closing issue references (issues only, not
 * PRs) plus the number in a `claude/issue-<n>-...` or `agent/issue-<n>` branch.
 */
export function linkedIssueNumbers(pr: GhPullRequest): number[] {
  const numbers: number[] = [];
  const add = (n: number) => {
    if (Number.isSafeInteger(n) && n > 0 && !numbers.includes(n)) numbers.push(n);
  };
  const fromBranch = ISSUE_BRANCH.exec(pr.headRefName ?? "");
  if (fromBranch) add(Number(fromBranch[1]));
  for (const ref of pr.closingIssuesReferences ?? []) {
    if (ref.url === undefined || ref.url.includes("/issues/")) add(ref.number);
  }
  return numbers;
}

const highestRisk = (names: readonly string[]): RiskBucket => {
  let risk: RiskBucket = "unlabeled";
  for (const name of names) {
    const level = name.startsWith("risk:") ? name.slice(5) : "";
    const bucket = RISK_BUCKETS.find((b) => b === level && b !== "unlabeled");
    if (bucket && RISK_RANK[bucket] > RISK_RANK[risk]) risk = bucket;
  }
  return risk;
};

/**
 * Risk of a PR: the highest `risk:<level>` label on its linked issues (where
 * the factory puts them), else the highest on the PR itself, else `unlabeled`.
 */
export function riskOf(
  pr: GhPullRequest,
  issueLabels: Readonly<Record<number, readonly string[]>> = {},
): RiskBucket {
  const fromIssues = highestRisk(linkedIssueNumbers(pr).flatMap((n) => issueLabels[n] ?? []));
  if (fromIssues !== "unlabeled") return fromIssues;
  return highestRisk((pr.labels ?? []).map((label) => label.name));
}

const botSet = (extra: readonly string[]) =>
  new Set([...DEFAULT_BOT_LOGINS, ...extra].map((login) => login.toLowerCase()));

const isBotLogin = (login: string | undefined, bots: ReadonlySet<string>): boolean => {
  const name = (login ?? "").trim().toLowerCase();
  return name === "" || name.endsWith("[bot]") || bots.has(name);
};

/** Reviews that count: submitted, by a human other than the PR author. */
const humanReviews = (pr: GhPullRequest, bots: ReadonlySet<string>): GhReview[] => {
  const prAuthor = (pr.author?.login ?? "").trim().toLowerCase();
  return (pr.reviews ?? []).filter((review) => {
    if (review.state === "PENDING") return false;
    const login = review.author?.login;
    if (review.author?.is_bot || isBotLogin(login, bots)) return false;
    return (login ?? "").trim().toLowerCase() !== prAuthor;
  });
};

/** "Update branch" and other merge commits bring in main; they are not rework. */
const MERGE_COMMIT = /^Merge (branch|remote-tracking branch|pull request) /;
const isMergeCommit = (commit: GhCommit): boolean =>
  MERGE_COMMIT.test(commit.messageHeadline ?? "");

const firstReviewAt = (pr: GhPullRequest, bots: ReadonlySet<string>): number | null => {
  const times = humanReviews(pr, bots)
    .map((review) => time(review.submittedAt))
    .filter((ms): ms is number => ms !== null);
  return times.length > 0 ? Math.min(...times) : null;
};

/**
 * A merged agent PR counts as rework when the agent's first submission was not
 * what got merged. Any one of these is enough:
 * 1. a review with state CHANGES_REQUESTED;
 * 2. a commit committed after the first submitted review (a fix in response to review);
 * 3. on a `claude/` branch, a commit whose authors are all humans (someone pushed
 *    a fix by hand). Not applied to `agent/` branches: local runs commit under
 *    the human's own git identity, so authorship cannot tell agent from human.
 * Only reviews by humans other than the PR author count (rules 1 and 2), and
 * merge commits ("Merge branch ...", "Merge remote-tracking branch ...",
 * "Merge pull request ...", e.g. from Update branch) are skipped (rules 2 and 3).
 * A login is a bot when it is empty (apps have no user), ends in `[bot]`, or is
 * in DEFAULT_BOT_LOGINS or `botLogins` (case-insensitive).
 */
export function isReworked(pr: GhPullRequest, botLogins: readonly string[] = []): boolean {
  if (!isMerged(pr)) return false;
  const bots = botSet(botLogins);
  if (humanReviews(pr, bots).some((review) => review.state === "CHANGES_REQUESTED")) return true;

  const commits = (pr.commits ?? []).filter((commit) => !isMergeCommit(commit));
  const reviewedAt = firstReviewAt(pr, bots);
  if (reviewedAt !== null) {
    const afterReview = commits.some((commit) => {
      const committed = time(commit.committedDate) ?? time(commit.authoredDate);
      return committed !== null && committed > reviewedAt;
    });
    if (afterReview) return true;
  }

  if ((pr.headRefName ?? "").startsWith("claude/")) {
    const isHuman = (author: GhCommitAuthor) => !isBotLogin(author.login, bots);
    const humanOnly = commits.some(
      (commit) => (commit.authors ?? []).length > 0 && (commit.authors ?? []).every(isHuman),
    );
    if (humanOnly) return true;
  }
  return false;
}

const ratio = (n: number, d: number): number | null => (d === 0 ? null : n / d);

function countOutcomes(
  prs: readonly GhPullRequest[],
  reworked: ReadonlySet<number>,
): OutcomeCounts {
  const merged = prs.filter(isMerged).length;
  const closedUnmerged = prs.filter((pr) => !isMerged(pr) && pr.state === "CLOSED").length;
  const reworkedCount = prs.filter((pr) => reworked.has(pr.number)).length;
  return {
    total: prs.length,
    merged,
    closedUnmerged,
    open: prs.length - merged - closedUnmerged,
    mergeRate: ratio(merged, merged + closedUnmerged),
    reworked: reworkedCount,
    reworkRate: ratio(reworkedCount, merged),
  };
}

/**
 * Outcome metrics over agent PRs (head branch `claude/*` or `agent/*`), from
 * `gh pr list --json` objects. Other PRs are ignored. Pure: `now` only anchors
 * `sinceDays` and `generatedAt`.
 */
export function computeFactoryMetrics(
  prs: readonly GhPullRequest[],
  now: Date = new Date(),
  options: MetricsOptions = {},
): FactoryMetrics {
  const sinceDays = options.sinceDays ?? null;
  const cutoff = sinceDays === null ? null : now.getTime() - sinceDays * DAY_MS;
  const agentPrs = prs.filter(isAgentPr).filter((pr) => {
    if (cutoff === null) return true;
    const created = time(pr.createdAt);
    return created !== null && created >= cutoff;
  });

  const reworked = new Set(
    agentPrs.filter((pr) => isReworked(pr, options.botLogins)).map((pr) => pr.number),
  );

  const mergeDurations: number[] = [];
  const reviewDurations: number[] = [];
  for (const pr of agentPrs) {
    const created = time(pr.createdAt);
    if (created === null) continue;
    const merged = isMerged(pr) ? time(pr.mergedAt) : null;
    if (merged !== null && merged >= created) mergeDurations.push(merged - created);
    const reviewed = firstReviewAt(pr, botSet(options.botLogins ?? []));
    if (reviewed !== null && reviewed >= created) reviewDurations.push(reviewed - created);
  }

  const byRisk = Object.fromEntries(
    RISK_BUCKETS.map((bucket) => [
      bucket,
      countOutcomes(
        agentPrs.filter((pr) => riskOf(pr, options.issueLabels) === bucket),
        reworked,
      ),
    ]),
  ) as Record<RiskBucket, OutcomeCounts>;

  return {
    ...countOutcomes(agentPrs, reworked),
    generatedAt: now.toISOString(),
    sinceDays,
    timeToMerge: {
      count: mergeDurations.length,
      medianMs: median(mergeDurations),
      p90Ms: percentile(mergeDurations, 90),
    },
    timeToFirstReview: { count: reviewDurations.length, medianMs: median(reviewDurations) },
    reworkedPrs: [...reworked].sort((a, b) => a - b),
    byRisk,
  };
}
