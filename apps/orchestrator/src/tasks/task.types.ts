/** BullMQ queue that holds one job per issue the factory works on. */
export const TASK_QUEUE_NAME = "agent-tasks";
export const TASK_JOB_NAME = "implement-issue";

/** Payload enqueued by the webhook. Title and body are untrusted user text. */
export interface TaskJobData {
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  deliveryId: string;
}

export type RunOutcome =
  | "pr_opened"
  | "pr_updated"
  | "agent_error"
  | "dirty_tree"
  | "protected_paths"
  | "verify_config_changed"
  | "verify_failed"
  | "no_commits";

/** Returned by the processor and stored by BullMQ as the job's return value. */
export interface RunRecord {
  issueNumber: number;
  branch: string;
  outcome: RunOutcome;
  agent: {
    ok: boolean;
    subtype: string;
    costUsd: number;
    numTurns: number;
  } | null;
  verify: { passed: boolean; summary: string } | null;
  commits: number;
  /** The commit that was checked, verified and pushed. */
  headSha: string | null;
  /** Changed paths that stopped the run (protected_paths, verify_config_changed). */
  blockedPaths: string[];
  pullRequest: { number: number; url: string } | null;
  startedAt: string;
  finishedAt: string;
}

export const taskJobId = (issueNumber: number): string => `issue-${issueNumber}`;
