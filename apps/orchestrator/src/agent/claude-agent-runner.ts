import {
  query,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ORCHESTRATOR_SECRETS, withoutSecrets } from "../common/safe-env.js";
import { ENV_SCRUB_VARIABLE } from "./env-scrub.js";
import type { AgentRunInput, AgentRunResult, AgentRunner } from "./agent-runner.js";

/** Exactly the commands the agent may run without asking (no one is there to ask). */
export const AGENT_ALLOWED_TOOLS: string[] = [
  "Bash(pnpm install --frozen-lockfile)",
  "Bash(pnpm verify)",
  "Bash(pnpm lint)",
  "Bash(pnpm typecheck)",
  "Bash(pnpm test)",
  "Bash(pnpm format)",
  "Bash(git add *)",
  "Bash(git commit *)",
];

/**
 * CI, agent guardrails and holdout scenarios stay out of reach, and the agent
 * never talks to GitHub: the orchestrator pushes and opens the PR itself.
 */
export const AGENT_DISALLOWED_TOOLS: string[] = [
  "Edit(.github/**)",
  "Write(.github/**)",
  "Edit(.claude/**)",
  "Write(.claude/**)",
  "Read(holdout/**)",
  "Edit(holdout/**)",
  "Write(holdout/**)",
  "Bash(git push *)",
  "Bash(gh *)",
];

const APPEND_SYSTEM_PROMPT = [
  "You run headless inside the agent-factory orchestrator, in a git worktree created for one GitHub issue.",
  "Nobody can answer questions during the run. If the task is ambiguous, make no changes and explain why in your final message.",
  "Never push and never call GitHub; the orchestrator verifies your commits and opens the pull request.",
  "Your final message becomes part of the pull request description: summarise what changed and how it was tested.",
].join(" ");

/** The part of the SDK's `query()` this adapter uses; the real function satisfies it. */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

/**
 * Runs the Claude Agent SDK with the factory's permission policy. Built by a
 * factory provider (see app.module.ts), so it carries no DI metadata.
 */
export class ClaudeAgentRunner implements AgentRunner {
  constructor(
    private readonly queryFn: QueryFn = query,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
    /** Sets CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 (needs bubblewrap, see env-scrub.ts). */
    private readonly envScrub = false,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const options: Options = {
      cwd: input.cwd,
      permissionMode: "acceptEdits",
      // Loads the repo's CLAUDE.md, hooks and deny rules from .claude/settings.json.
      settingSources: ["project"],
      allowedTools: AGENT_ALLOWED_TOOLS,
      disallowedTools: AGENT_DISALLOWED_TOOLS,
      maxTurns: input.maxTurns,
      maxBudgetUsd: input.maxBudgetUsd,
      systemPrompt: { type: "preset", preset: "claude_code", append: APPEND_SYSTEM_PROMPT },
      // Replaces the inherited environment: the agent keeps ANTHROPIC_API_KEY, never the GitHub token.
      env: this.agentEnv(),
    };

    let result: SDKResultMessage | undefined;
    for await (const message of this.queryFn({ prompt: input.prompt, options })) {
      if (message.type === "result") result = message;
    }

    if (!result) {
      return {
        ok: false,
        subtype: "no_result",
        costUsd: 0,
        numTurns: 0,
        summary: "The agent ended without a result message.",
      };
    }
    return {
      ok: result.subtype === "success" && !result.is_error,
      subtype: result.subtype,
      costUsd: result.total_cost_usd,
      numTurns: result.num_turns,
      summary: result.subtype === "success" ? result.result : result.errors.join("\n"),
    };
  }

  private agentEnv(): Record<string, string> {
    const env = withoutSecrets(this.baseEnv, [...ORCHESTRATOR_SECRETS, ENV_SCRUB_VARIABLE]);
    if (this.envScrub) env[ENV_SCRUB_VARIABLE] = "1";
    return env;
  }
}
