/** DI token for {@link Workspace}. */
export const WORKSPACE = Symbol("WORKSPACE");

export interface PreparedWorkspace {
  dir: string;
  branch: string;
  /** origin/main as fetched from the explicit URL. Every later check uses this, never a ref. */
  baseSha: string;
  /** The remote branch before this run (push lease), or null when it does not exist. */
  remoteBranchSha: string | null;
}

export interface VerifyResult {
  passed: boolean;
  /** The most useful last line of `pnpm verify` output (turbo or vitest summary). */
  summary: string;
}

/** Git worktree lifecycle for one issue run. */
export interface Workspace {
  /**
   * Checks REPO_DIR (hooks, git config allowlist), fetches main from the
   * explicit URL, creates `agent/issue-<n>` at that SHA in a fresh worktree
   * without holdout/, and installs dependencies.
   */
  prepare(issueNumber: number): Promise<PreparedWorkspace>;
  /** True when `git status --porcelain` is empty. */
  isClean(dir: string): Promise<boolean>;
  /** HEAD's SHA. Throws unless `baseSha` is an ancestor of HEAD. */
  headSha(ws: PreparedWorkspace): Promise<string>;
  /** Every path touched by any commit in baseSha..headSha (not only the net diff). */
  changedFiles(ws: PreparedWorkspace, headSha: string): Promise<string[]>;
  /** Commits in baseSha..headSha. */
  commitsAhead(ws: PreparedWorkspace, headSha: string): Promise<number>;
  /**
   * `git clean -ffdx`, a fresh `pnpm install --frozen-lockfile`, then
   * `pnpm verify` with the turbo cache bypassed. Never trusts the agent's claim.
   */
  verify(dir: string): Promise<VerifyResult>;
  /** Pushes exactly `headSha` (the verified commit) to `agent/issue-<n>`. */
  push(ws: PreparedWorkspace, headSha: string): Promise<void>;
  /** Removes the worktree directory; the branch is kept for inspection. */
  cleanup(dir: string): Promise<void>;
}
