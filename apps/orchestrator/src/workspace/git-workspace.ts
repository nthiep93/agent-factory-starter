import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ORCHESTRATOR_SECRETS, withoutSecrets } from "../common/safe-env.js";
import { SpawnCommandRunner, type CommandResult, type CommandRunner } from "./command-runner.js";
import { Mutex } from "./mutex.js";
import type { PreparedWorkspace, VerifyResult, Workspace } from "./workspace.js";

export interface GitWorkspaceOptions {
  repoDir: string;
  worktreesDir: string;
  /** Where branches are pushed, e.g. https://github.com/<owner>/<repo>.git. Never a remote name. */
  pushUrl: string;
  baseBranch?: string;
  /** Sent as an HTTP header through git's env config for fetch and push, never in argv. */
  pushToken?: string;
  /** Environment to derive child environments from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  installTimeoutMs?: number;
  verifyTimeoutMs?: number;
}

const AGENT_BRANCH = /^agent\/issue-[1-9][0-9]*$/;
const GIT_TIMEOUT_MS = 5 * 60_000;
/** Prepended to every git command: no hooks, no fsmonitor daemon, whatever the repo config says. */
const SAFE_GIT_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="];
/** Repo-level settings that would run code or redirect pushes. */
const RISKY_CONFIG = "^(core\\.hookspath|core\\.fsmonitor|remote\\..*\\.pushurl)$";

/**
 * Git worktrees under WORKTREES_DIR, created from REPO_DIR. Every command runs
 * through {@link CommandRunner} with an argument array; only the issue number
 * (an integer) and derived names ever reach git. Commands that change REPO_DIR
 * itself (fetch, worktree add/remove/prune, sparse-checkout) run one at a time.
 */
export class GitWorkspace implements Workspace {
  private readonly baseBranch: string;
  private readonly worktreesDir: string;
  private readonly repoLock = new Mutex();
  /** For git: no secrets, no system or global git config. */
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
    this.gitEnv = {
      ...withoutSecrets(env),
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
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

    await this.repoLock.run(async () => {
      const repo = this.options.repoDir;
      await this.assertSafeRepo();
      await this.git(repo, ["fetch", "--prune", "origin"], this.authEnv());
      // -B resets the branch if an earlier run of the same issue created it.
      await this.git(repo, ["worktree", "add", "-B", branch, dir, `origin/${this.baseBranch}`]);
      // holdout/ never reaches the agent's disk. Sparse entries are skip-worktree
      // in the index, so commits made here keep the holdout files on the branch.
      await this.git(dir, ["sparse-checkout", "set", "--no-cone", "/*", "!/holdout/"]);
    });

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

  async isClean(dir: string): Promise<boolean> {
    this.assertInside(dir);
    const result = await this.git(dir, ["status", "--porcelain"]);
    return result.output.trim() === "";
  }

  async changedFiles(dir: string): Promise<string[]> {
    this.assertInside(dir);
    const result = await this.git(dir, [
      "diff",
      "--name-only",
      "--no-renames",
      `origin/${this.baseBranch}...HEAD`,
    ]);
    return result.output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
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
    await this.assertSafeRepo();
    // Lease on what prepare() fetched: a re-run may replace its own earlier
    // branch, but never commits someone pushed since. Empty = must not exist.
    const tracking = await this.runner.run(
      "git",
      [...SAFE_GIT_FLAGS, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
      { cwd: dir, env: this.gitEnv, timeoutMs: GIT_TIMEOUT_MS },
    );
    const expected = tracking.code === 0 ? tracking.output.trim() : "";
    await this.git(
      dir,
      [
        "push",
        "--no-verify",
        `--force-with-lease=refs/heads/${branch}:${expected}`,
        this.options.pushUrl,
        `HEAD:refs/heads/${branch}`,
      ],
      this.authEnv(),
    );
  }

  async cleanup(dir: string): Promise<void> {
    this.assertInside(dir);
    const repo = this.options.repoDir;
    await this.repoLock.run(async () => {
      // Ignore failures: the worktree may not exist or may be half-created.
      await this.runner.run("git", [...SAFE_GIT_FLAGS, "worktree", "remove", "--force", dir], {
        cwd: repo,
        env: this.gitEnv,
        timeoutMs: GIT_TIMEOUT_MS,
      });
      await rm(dir, { recursive: true, force: true });
      await this.runner.run("git", [...SAFE_GIT_FLAGS, "worktree", "prune"], {
        cwd: repo,
        env: this.gitEnv,
        timeoutMs: GIT_TIMEOUT_MS,
      });
    });
  }

  /**
   * Refuses to work with a REPO_DIR that has executable hooks or config that
   * runs code or redirects pushes. The -c flags already neutralise most of it;
   * this makes a tampered clone fail loudly instead.
   */
  private async assertSafeRepo(): Promise<void> {
    const repo = this.options.repoDir;
    const problems: string[] = [];

    const commonDir = (await this.git(repo, ["rev-parse", "--git-common-dir"])).output.trim();
    const hooksDir = resolve(repo, commonDir, "hooks");
    const entries = await readdir(hooksDir).catch(() => [] as string[]);
    for (const name of entries) {
      if (name.endsWith(".sample")) continue;
      const info = await stat(join(hooksDir, name)).catch(() => null);
      if (info?.isFile() && (info.mode & 0o111) !== 0) problems.push(`executable hook ${name}`);
    }

    const config = await this.runner.run(
      "git",
      [...SAFE_GIT_FLAGS, "config", "--local", "--get-regexp", RISKY_CONFIG],
      { cwd: repo, env: this.gitEnv, timeoutMs: GIT_TIMEOUT_MS },
    );
    if (config.code === 0) {
      for (const line of config.output.split("\n").filter(Boolean)) {
        problems.push(`config ${line.split(" ")[0]}`);
      }
    }

    if (problems.length > 0) {
      throw new Error(
        `Refusing to use REPO_DIR: ${problems.join(", ")}. Remove them from the orchestrator's clone.`,
      );
    }
  }

  private async git(
    cwd: string,
    args: string[],
    env: Record<string, string> = this.gitEnv,
  ): Promise<CommandResult> {
    const result = await this.runner.run("git", [...SAFE_GIT_FLAGS, ...args], {
      cwd,
      env,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(`git ${args[0]} failed (exit ${result.code}): ${tail(result.output)}`);
    }
    return result;
  }

  /** Token as an HTTP header via GIT_CONFIG_* env, so it never shows up in argv or remotes. */
  private authEnv(): Record<string, string> {
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
