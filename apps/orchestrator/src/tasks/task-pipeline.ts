import { Inject, Injectable, Logger } from "@nestjs/common";
import { AGENT_RUNNER, type AgentRunResult, type AgentRunner } from "../agent/agent-runner.js";
import { makeRedactor, type Redact } from "../common/redact.js";
import { APP_CONFIG, secretValues, type OrchestratorConfig } from "../config/config.js";
import {
  GITHUB_CLIENT,
  GitHubApiError,
  type GitHubClient,
  type PullRequestRef,
} from "../github/github-client.js";
import {
  WORKSPACE,
  type PreparedWorkspace,
  type VerifyResult,
  type Workspace,
} from "../workspace/workspace.js";
import { protectedPaths, verifyConfigPaths } from "./path-policy.js";
import { buildTaskPrompt } from "./task-prompt.js";
import type { RunOutcome, RunRecord, TaskJobData } from "./task.types.js";

const BASE_BRANCH = "main";
const MAX_LISTED_PATHS = 20;

type RecordParts = Partial<
  Pick<RunRecord, "verify" | "commits" | "pullRequest" | "blockedPaths">
> & {
  agent: AgentRunResult;
};

/**
 * One issue, end to end: comment, worktree, agent, checks, independent verify,
 * push, PR, comment. The agent's own claims are never trusted: the
 * orchestrator checks the tree, the changed paths and the commits, and runs
 * `pnpm verify` itself before pushing anything. Every string that leaves the
 * process (comments, PR body, return value, errors, logs) is redacted.
 */
@Injectable()
export class TaskPipeline {
  private readonly logger = new Logger(TaskPipeline.name);
  private readonly redact: Redact;

  constructor(
    @Inject(APP_CONFIG) private readonly config: OrchestratorConfig,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
    @Inject(WORKSPACE) private readonly workspace: Workspace,
    @Inject(GITHUB_CLIENT) private readonly github: GitHubClient,
  ) {
    this.redact = makeRedactor(secretValues(config));
  }

  async execute(task: TaskJobData): Promise<RunRecord> {
    const n = task.issueNumber;
    const startedAt = new Date().toISOString();
    const branch = `agent/issue-${n}`;
    const record = (outcome: RunOutcome, parts: RecordParts): RunRecord => ({
      issueNumber: n,
      branch,
      outcome,
      agent: {
        ok: parts.agent.ok,
        subtype: parts.agent.subtype,
        costUsd: parts.agent.costUsd,
        numTurns: parts.agent.numTurns,
      },
      verify: parts.verify
        ? { passed: parts.verify.passed, summary: this.redact(parts.verify.summary) }
        : null,
      commits: parts.commits ?? 0,
      blockedPaths: parts.blockedPaths ?? [],
      pullRequest: parts.pullRequest ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    const kept = `Nothing was pushed; the local branch \`${branch}\` is kept on the orchestrator host for inspection.`;

    let ws: PreparedWorkspace | undefined;
    try {
      await this.comment(
        n,
        `The agent factory picked up this issue. Working on branch \`${branch}\` ` +
          `(max ${this.config.agentMaxTurns} turns, budget $${this.config.agentMaxBudgetUsd}).`,
      );
      ws = await this.workspace.prepare(n);
      this.log(`issue #${n}: worktree ready at ${ws.dir}`);

      const agent = await this.runner.run({
        cwd: ws.dir,
        prompt: buildTaskPrompt(task),
        maxTurns: this.config.agentMaxTurns,
        maxBudgetUsd: this.config.agentMaxBudgetUsd,
      });
      this.log(
        `issue #${n}: agent ${agent.subtype}, ${agent.numTurns} turns, $${agent.costUsd.toFixed(2)}`,
      );

      if (!agent.ok) {
        await this.comment(
          n,
          `The agent stopped without finishing (\`${agent.subtype}\`) after ${costLine(agent)}. ${kept}` +
            quote(agent.summary),
        );
        return record("agent_error", { agent });
      }

      if (!(await this.workspace.isClean(ws.dir))) {
        await this.comment(
          n,
          `The agent left uncommitted changes, so the result is ambiguous and was not verified. ${kept}`,
        );
        return record("dirty_tree", { agent });
      }

      const files = await this.workspace.changedFiles(ws.dir);
      const forbidden = protectedPaths(files);
      if (forbidden.length > 0) {
        await this.comment(
          n,
          `The branch changes protected paths (CI, agent configuration, holdout or agent instructions), ` +
            `which only humans may change:\n\n${pathList(forbidden)}\n\n${kept}`,
        );
        return record("protected_paths", { agent, blockedPaths: forbidden });
      }
      const verifyConfig = verifyConfigPaths(files);
      if (verifyConfig.length > 0) {
        await this.comment(
          n,
          `The branch changes files that define \`pnpm verify\` (package.json, lint, test, ` +
            `TypeScript or build config, scripts/), so an automatic verify would not be trustworthy. ` +
            `A human needs to review it:\n\n${pathList(verifyConfig)}\n\n${kept}`,
        );
        return record("verify_config_changed", { agent, blockedPaths: verifyConfig });
      }

      const commits = await this.workspace.commitsAhead(ws.dir);
      if (commits === 0) {
        await this.comment(
          n,
          `The agent finished after ${costLine(agent)} but made no commits, so there is nothing to open a PR for.` +
            quote(agent.summary),
        );
        return record("no_commits", { agent, commits });
      }

      const verify = await this.workspace.verify(ws.dir);
      if (!verify.passed) {
        await this.comment(
          n,
          `The agent finished, but the orchestrator's own \`pnpm verify\` failed: \`${oneLine(verify.summary)}\`. ` +
            `Nothing was pushed; the local branch \`${branch}\` (${commits} commit(s)) is kept for inspection.`,
        );
        return record("verify_failed", { agent, verify, commits });
      }

      await this.workspace.push(ws.dir, branch);
      const { pullRequest, created } = await this.openOrFindPullRequest(task, branch, {
        agent,
        verify,
        commits,
      });

      const message = created
        ? `Opened #${pullRequest.number}: ${pullRequest.url}`
        : `Updated the existing pull request #${pullRequest.number} with a new run: ${pullRequest.url}`;
      // The PR exists now: a failing comment must not turn the run into a failure.
      await this.comment(
        n,
        `${message}\n\n\`pnpm verify\`: \`${oneLine(verify.summary)}\`, ${costLine(agent)}.`,
      ).catch((e: unknown) =>
        this.logger.error(this.redact(`issue #${n}: could not comment the PR link: ${String(e)}`)),
      );
      this.log(`issue #${n}: ${created ? "opened" : "updated"} PR #${pullRequest.number}`);
      return record(created ? "pr_opened" : "pr_updated", { agent, verify, commits, pullRequest });
    } catch (error) {
      const message = this.redact(error instanceof Error ? error.message : String(error));
      this.logger.error(`issue #${n}: run failed: ${message}`);
      await this.comment(n, `The agent run failed: \`${oneLine(message).slice(0, 500)}\``).catch(
        (commentError: unknown) =>
          this.logger.error(
            this.redact(`issue #${n}: could not report the failure: ${String(commentError)}`),
          ),
      );
      // BullMQ stores the message as failedReason: rethrow the redacted text only.
      // No `cause`: the original error is exactly the unredacted text to keep out.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(message);
    } finally {
      if (ws) {
        await this.workspace
          .cleanup(ws.dir)
          .catch((e: unknown) =>
            this.logger.error(this.redact(`issue #${n}: cleanup failed: ${String(e)}`)),
          );
      }
    }
  }

  /**
   * Opens the PR. GitHub answers 422 when one is already open for the branch
   * (a re-run of the same issue): the push already updated it, so link it.
   */
  private async openOrFindPullRequest(
    task: TaskJobData,
    branch: string,
    run: { agent: AgentRunResult; verify: VerifyResult; commits: number },
  ): Promise<{ pullRequest: PullRequestRef; created: boolean }> {
    try {
      const pullRequest = await this.github.createPullRequest({
        title: this.redact(prTitle(task)),
        head: branch,
        base: BASE_BRANCH,
        body: this.redact(prBody(task, run.agent, run.verify, run.commits)),
      });
      return { pullRequest, created: true };
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
      const existing = await this.github.findOpenPullRequest(branch);
      if (!existing) throw error;
      return { pullRequest: existing, created: false };
    }
  }

  private comment(issueNumber: number, body: string): Promise<void> {
    return this.github.commentOnIssue(issueNumber, this.redact(body));
  }

  private log(message: string): void {
    this.logger.log(this.redact(message));
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

function pathList(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).map((p) => `- \`${oneLine(p)}\``);
  if (paths.length > MAX_LISTED_PATHS)
    shown.push(`- ...and ${paths.length - MAX_LISTED_PATHS} more`);
  return shown.join("\n");
}

function quote(summary: string): string {
  const text = summary.trim().slice(0, 1500);
  if (!text) return "";
  return `\n\nAgent's last message:\n\n${text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}`;
}
