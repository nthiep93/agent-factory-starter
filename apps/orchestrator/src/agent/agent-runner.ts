/** DI token for {@link AgentRunner}. */
export const AGENT_RUNNER = Symbol("AGENT_RUNNER");

export interface AgentRunInput {
  cwd: string;
  prompt: string;
  maxTurns: number;
  maxBudgetUsd: number;
}

export interface AgentRunResult {
  ok: boolean;
  /** `success`, an SDK error subtype such as `error_max_turns`, or `no_result`. */
  subtype: string;
  costUsd: number;
  numTurns: number;
  /** The agent's final message, or the error details when it failed. */
  summary: string;
}

/** Runs one coding agent session inside a prepared worktree. */
export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
