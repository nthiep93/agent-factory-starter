import { Inject, Injectable, Logger } from "@nestjs/common";
import { AGENT_RUNNER, type AgentRunResult, type AgentRunner } from "../agent/agent-runner.js";
import { APP_CONFIG, type OrchestratorConfig } from "../config/config.js";
import { GITHUB_CLIENT, type GitHubClient } from "../github/github-client.js";
import {
  WORKSPACE,
  type PreparedWorkspace,
  type VerifyResult,
  type Workspace,
} from "../workspace/workspace.js";
import { buildTaskPrompt } from "./task-prompt.js";
import type { RunOutcome, RunRecord, TaskJobData } from "./task.types.js";

const BASE_BRANCH = "main";

/**
 * One issue, end to end: comment, worktree, agent, independent verify, push,
 * PR, comment. The agent's own claims are never trusted: the orchestrator runs
 * `pnpm verify` and counts commits itself before pushing anything.
 */
@Injectable()
export class TaskPipeline {
  private readonly logger = new Logger(TaskPipeline.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: OrchestratorConfig,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
    @Inject(WORKSPACE) private readonly workspace: Workspace,
    @Inject(GITHUB_CLIENT) private readonly github: GitHubClient,
  ) {}

  async execute(task: TaskJobData): Promise<RunRecord> {
    const n = task.issueNumber;
    const startedAt = new Date().toISOString();
    const branch = `agent/issue-${n}`;
    const record = (
      outcome: RunOutcome,
      parts: Partial<Pick<RunRecord, "verify" | "commits" | "pullRequest">> & {
        agent: AgentRunResult;
      },
    ): RunRecord => ({
      issueNumber: n,
      branch,
      outcome,
      agent: {
        ok: parts.agent.ok,
        subtype: parts.agent.subtype,
        costUsd: parts.agent.costUsd,
        numTurns: parts.agent.numTurns,
      },
      verify: parts.verify ?? null,
      commits: parts.commits ?? 0,
      pullRequest: parts.pullRequest ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
    });

    await this.github.commentOnIssue(
      n,
      `The agent factory picked up this issue. Working on branch \`${branch}\` ` +
        `(max ${this.config.agentMaxTurns} turns, budget $${this.config.agentMaxBudgetUsd}).`,
    );

    let ws: PreparedWorkspace | undefined;
    try {
      ws = await this.workspace.prepare(n);
      this.logger.log(`issue #${n}: worktree ready at ${ws.dir}`);

      const agent = await this.runner.run({
        cwd: ws.dir,
        prompt: buildTaskPrompt(task),
        maxTurns: this.config.agentMaxTurns,
        maxBudgetUsd: this.config.agentMaxBudgetUsd,
      });
      this.logger.log(
        `issue #${n}: agent ${agent.subtype}, ${agent.numTurns} turns, $${agent.costUsd.toFixed(2)}`,
      );

      if (!agent.ok) {
        await this.github.commentOnIssue(
          n,
          `The agent stopped without finishing (\`${agent.subtype}\`) after ${costLine(agent)}. ` +
            `Nothing was pushed; the local branch \`${branch}\` is kept on the orchestrator host for inspection.` +
            quote(agent.summary),
        );
        return record("agent_error", { agent });
      }

      const verify = await this.workspace.verify(ws.dir);
      const commits = await this.workspace.commitsAhead(ws.dir);

      if (!verify.passed) {
        await this.github.commentOnIssue(
          n,
          `The agent finished, but the orchestrator's own \`pnpm verify\` failed: \`${oneLine(verify.summary)}\`. ` +
            `Nothing was pushed; the local branch \`${branch}\` (${commits} commit(s)) is kept for inspection.`,
        );
        return record("verify_failed", { agent, verify, commits });
      }
      if (commits === 0) {
        await this.github.commentOnIssue(
          n,
          `The agent finished after ${costLine(agent)} but made no commits, so there is nothing to open a PR for.` +
            quote(agent.summary),
        );
        return record("no_commits", { agent, verify, commits });
      }

      await this.workspace.push(ws.dir, branch);
      const pullRequest = await this.github.createPullRequest({
        title: prTitle(task),
        head: branch,
        base: BASE_BRANCH,
        body: prBody(task, agent, verify, commits),
      });
      await this.github.commentOnIssue(
        n,
        `Opened #${pullRequest.number}: ${pullRequest.url}\n\n` +
          `\`pnpm verify\`: \`${oneLine(verify.summary)}\`, ${costLine(agent)}.`,
      );
      this.logger.log(`issue #${n}: opened PR #${pullRequest.number}`);
      return record("pr_opened", { agent, verify, commits, pullRequest });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`issue #${n}: run failed: ${message}`);
      await this.github
        .commentOnIssue(n, `The agent run failed: \`${oneLine(message).slice(0, 500)}\``)
        .catch((commentError: unknown) =>
          this.logger.error(`issue #${n}: could not report the failure: ${String(commentError)}`),
        );
      throw error;
    } finally {
      if (ws) {
        await this.workspace
          .cleanup(ws.dir)
          .catch((e: unknown) => this.logger.error(`issue #${n}: cleanup failed: ${String(e)}`));
      }
    }
  }
}

function prTitle(task: TaskJobData): string {
  const title = oneLine(task.title).slice(0, 200);
  return title || `Resolve issue #${task.issueNumber}`;
}

function prBody(
  task: TaskJobData,
  agent: AgentRunResult,
  verify: VerifyResult,
  commits: number,
): string {
  return [
    `Closes #${task.issueNumber}`,
    "",
    "## Agent summary",
    "",
    agent.summary.trim().slice(0, 10_000) || "(no summary)",
    "",
    "## Verification",
    "",
    `- \`pnpm verify\` run by the orchestrator: \`${oneLine(verify.summary)}\``,
    `- Commits: ${commits}`,
    `- Agent: ${costLine(agent)}`,
    "",
    "_Opened by the agent-factory orchestrator. Review it like any other PR before merging._",
  ].join("\n");
}

const costLine = (agent: AgentRunResult): string =>
  `${agent.numTurns} turns, cost $${agent.costUsd.toFixed(2)}`;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").replace(/`/g, "'").trim();

function quote(summary: string): string {
  const text = summary.trim().slice(0, 1500);
  if (!text) return "";
  return `\n\nAgent's last message:\n\n${text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}`;
}
