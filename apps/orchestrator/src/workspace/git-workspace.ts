import { mkdir, rm } from "node:fs/promises";
import { join, relative, resolve, isAbsolute } from "node:path";
import { ORCHESTRATOR_SECRETS, withoutSecrets } from "../common/safe-env.js";
import { SpawnCommandRunner, type CommandResult, type CommandRunner } from "./command-runner.js";
import type { PreparedWorkspace, VerifyResult, Workspace } from "./workspace.js";

export interface GitWorkspaceOptions {
  repoDir: string;
  worktreesDir: string;
  baseBranch?: string;
  /** Used only for `git push`, passed through git's env config, never argv. */
  pushToken?: string;
  /** Environment to derive child environments from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  installTimeoutMs?: number;
  verifyTimeoutMs?: number;
}

const AGENT_BRANCH = /^agent\/issue-[1-9][0-9]*$/;
const GIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Git worktrees under WORKTREES_DIR, created from REPO_DIR. Every command runs
 * through {@link CommandRunner} with an argument array; only the issue number
 * (an integer) and derived names ever reach git.
 */
export class GitWorkspace implements Workspace {
  private readonly baseBranch: string;
  private readonly worktreesDir: string;
  /** For git: no GitHub token or webhook secret. */
  private readonly gitEnv: Record<string, string>;
  /** For pnpm, which runs code the agent wrote: no API keys at all. */
  private readonly pnpmEnv: Record<string, string>;

  constructor(
    private readonly options: GitWorkspaceOptions,
    private readonly runner: CommandRunner = new SpawnCommandRunner(),
  ) {
    const env = options.env ?? process.env;
    this.baseBranch = options.baseBranch ?? "main";
    this.worktreesDir = resolve(options.worktreesDir);
    this.gitEnv = { ...withoutSecrets(env), GIT_TERMINAL_PROMPT: "0" };
    this.pnpmEnv = {
      ...withoutSecrets(env, [...ORCHESTRATOR_SECRETS, "ANTHROPIC_API_KEY"]),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
  }

  async prepare(issueNumber: number): Promise<PreparedWorkspace> {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(`Invalid issue number: ${issueNumber}`);
    }
    const branch = `agent/issue-${issueNumber}`;
    const dir = join(this.worktreesDir, `issue-${issueNumber}`);

    await mkdir(this.worktreesDir, { recursive: true });
    // A crashed earlier run may have left the worktree behind.
    await this.cleanup(dir);

    const repo = this.options.repoDir;
    await this.git(repo, ["fetch", "--prune", "origin"]);
    // -B resets the branch if an earlier run of the same issue created it.
    await this.git(repo, ["worktree", "add", "-B", branch, dir, `origin/${this.baseBranch}`]);

    const install = await this.runner.run(
      "pnpm",
      ["install", "--frozen-lockfile", "--prefer-offline"],
      { cwd: dir, env: this.pnpmEnv, timeoutMs: this.options.installTimeoutMs ?? 10 * 60_000 },
    );
    if (install.code !== 0) {
      throw new Error(`pnpm install failed (exit ${install.code}): ${tail(install.output)}`);
    }
    return { dir, branch };
  }

  async verify(dir: string): Promise<VerifyResult> {
    this.assertInside(dir);
    const result = await this.runner.run("pnpm", ["verify"], {
      cwd: dir,
      env: this.pnpmEnv,
      timeoutMs: this.options.verifyTimeoutMs ?? 20 * 60_000,
    });
    return { passed: result.code === 0, summary: summaryLine(result.output) };
  }

  async commitsAhead(dir: string): Promise<number> {
    this.assertInside(dir);
    const out = await this.git(dir, ["rev-list", "--count", `origin/${this.baseBranch}..HEAD`]);
    const count = Number.parseInt(out.output.trim(), 10);
    if (!Number.isInteger(count))
      throw new Error(`Unexpected rev-list output: ${tail(out.output)}`);
    return count;
  }

  async push(dir: string, branch: string): Promise<void> {
    this.assertInside(dir);
    if (!AGENT_BRANCH.test(branch)) {
      throw new Error(`Refusing to push "${branch}": only agent/issue-<n> branches are pushed`);
    }
    // --force-with-lease: a re-run may replace its own earlier branch, but only
    // if nobody pushed to it since the fetch in prepare().
    await this.git(
      dir,
      ["push", `--force-with-lease=refs/heads/${branch}`, "origin", `HEAD:refs/heads/${branch}`],
      this.pushEnv(),
    );
  }

  async cleanup(dir: string): Promise<void> {
    this.assertInside(dir);
    const repo = this.options.repoDir;
    // Ignore failures: the worktree may not exist or may be half-created.
    await this.runner.run("git", ["worktree", "remove", "--force", dir], {
      cwd: repo,
      env: this.gitEnv,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    await rm(dir, { recursive: true, force: true });
    await this.runner.run("git", ["worktree", "prune"], {
      cwd: repo,
      env: this.gitEnv,
      timeoutMs: GIT_TIMEOUT_MS,
    });
  }

  private async git(
    cwd: string,
    args: string[],
    env: Record<string, string> = this.gitEnv,
  ): Promise<CommandResult> {
    const result = await this.runner.run("git", args, { cwd, env, timeoutMs: GIT_TIMEOUT_MS });
    if (result.code !== 0) {
      throw new Error(`git ${args[0]} failed (exit ${result.code}): ${tail(result.output)}`);
    }
    return result;
  }

  /** Token as an HTTP header via GIT_CONFIG_* env, so it never shows up in argv or remotes. */
  private pushEnv(): Record<string, string> {
    const token = this.options.pushToken;
    if (!token) return this.gitEnv;
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    return {
      ...this.gitEnv,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    };
  }

  private assertInside(dir: string): void {
    const rel = relative(this.worktreesDir, resolve(dir));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Refusing to touch ${dir}: outside WORKTREES_DIR`);
    }
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Picks the line that best summarises a `pnpm verify` run. */
export function summaryLine(output: string): string {
  const lines = output
    .replace(ANSI, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = (re: RegExp): string | undefined => lines.filter((l) => re.test(l)).at(-1);
  return last(/^Tasks:/) ?? last(/^Tests\s+\d/) ?? lines.at(-1) ?? "(no output)";
}

function tail(output: string, max = 800): string {
  return output.trim().slice(-max);
}
