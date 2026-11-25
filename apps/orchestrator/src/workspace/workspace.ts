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
  /**
   * Checks REPO_DIR for hooks and risky git config, fetches origin, creates
   * `agent/issue-<n>` from origin/main in a fresh worktree without holdout/,
   * and installs dependencies.
   */
  prepare(issueNumber: number): Promise<PreparedWorkspace>;
  /** True when `git status --porcelain` is empty. */
  isClean(dir: string): Promise<boolean>;
  /** Paths changed on the branch since it left origin/main. */
  changedFiles(dir: string): Promise<string[]>;
  /** Runs `pnpm verify` in the worktree. Never trusts what the agent said about it. */
  verify(dir: string): Promise<VerifyResult>;
  /** Commits on HEAD that origin/main does not have. */
  commitsAhead(dir: string): Promise<number>;
  push(dir: string, branch: string): Promise<void>;
  /** Removes the worktree directory; the branch is kept for inspection. */
  cleanup(dir: string): Promise<void>;
}
