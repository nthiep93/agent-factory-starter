// Input shapes follow the field names of `gh pr list --json ...`. Only the
// fields the metrics read are typed; everything is optional where gh may omit it.

export interface GhActor {
  login?: string;
  is_bot?: boolean;
  name?: string;
}

export interface GhCommitAuthor {
  /** Empty or missing when the commit was made by an app/bot without a user. */
  login?: string;
  name?: string;
  email?: string;
}

export interface GhCommit {
  oid?: string;
  messageHeadline?: string;
  authoredDate?: string;
  committedDate?: string;
  authors?: GhCommitAuthor[];
}

export interface GhReview {
  author?: GhActor | null;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING. */
  state?: string;
  submittedAt?: string | null;
}

export interface GhLabel {
  name: string;
}

/** An issue the PR closes when merged. gh does not return its labels. */
export interface GhIssueRef {
  number: number;
  url?: string;
}

export interface GhPullRequest {
  number: number;
  headRefName: string;
  /** OPEN, CLOSED or MERGED. */
  state: string;
  createdAt: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  author?: GhActor | null;
  commits?: GhCommit[];
  reviews?: GhReview[];
  labels?: GhLabel[];
  closingIssuesReferences?: GhIssueRef[];
  additions?: number;
  deletions?: number;
}

/** The `--json` fields scripts/factory-metrics.mjs asks gh for. */
export const GH_PR_FIELDS = [
  "number",
  "headRefName",
  "state",
  "createdAt",
  "mergedAt",
  "closedAt",
  "author",
  "commits",
  "reviews",
  "labels",
  "closingIssuesReferences",
  "additions",
  "deletions",
] as const;

export const RISK_BUCKETS = ["low", "medium", "high", "unlabeled"] as const;
export type RiskBucket = (typeof RISK_BUCKETS)[number];

export interface OutcomeCounts {
  total: number;
  merged: number;
  closedUnmerged: number;
  open: number;
  /** merged / (merged + closedUnmerged); null when nothing is decided yet. */
  mergeRate: number | null;
  reworked: number;
  /** reworked / merged; null when nothing is merged. */
  reworkRate: number | null;
}

export interface FactoryMetrics extends OutcomeCounts {
  generatedAt: string;
  /** Window applied to createdAt, or null for all PRs given. */
  sinceDays: number | null;
  timeToMerge: { count: number; medianMs: number | null; p90Ms: number | null };
  timeToFirstReview: { count: number; medianMs: number | null };
  /** Numbers of the merged PRs counted as rework, ascending. */
  reworkedPrs: number[];
  byRisk: Record<RiskBucket, OutcomeCounts>;
}

export interface MetricsOptions {
  /** Only count PRs created in the last N days before `now`. */
  sinceDays?: number;
  /** Extra commit-author and reviewer logins to treat as bots (case-insensitive). */
  botLogins?: readonly string[];
  /**
   * Label names per issue number (from `gh issue list --json number,labels`).
   * Risk comes from the issue a PR is linked to; PR labels are the fallback.
   */
  issueLabels?: Readonly<Record<number, readonly string[]>>;
}
