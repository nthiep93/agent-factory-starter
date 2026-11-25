/** DI token for {@link Workspace}. */
export const WORKSPACE = Symbol("WORKSPACE");

export interface PreparedWorkspace {
  dir: string;
  branch: string;
}

export interface VerifyResult {
  passed: boolean;
  /** The most useful last line of `pnpm verify` output (turbo or vitest summary). */
  summary: string;
}

/** Git worktree lifecycle for one issue run. */
export interface Workspace {
  /** Fetches origin, creates `agent/issue-<n>` from origin/main in a fresh worktree, installs deps. */
  prepare(issueNumber: number): Promise<PreparedWorkspace>;
  /** Runs `pnpm verify` in the worktree. Never trusts what the agent said about it. */
  verify(dir: string): Promise<VerifyResult>;
  /** Commits on HEAD that origin/main does not have. */
  commitsAhead(dir: string): Promise<number>;
  push(dir: string, branch: string): Promise<void>;
  /** Removes the worktree directory; the branch is kept for inspection. */
  cleanup(dir: string): Promise<void>;
}
