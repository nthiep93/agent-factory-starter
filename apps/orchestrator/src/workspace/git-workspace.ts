import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ORCHESTRATOR_SECRETS, withoutSecrets } from "../common/safe-env.js";
import { SpawnCommandRunner, type CommandResult, type CommandRunner } from "./command-runner.js";
import { Mutex } from "./mutex.js";
import type { PreparedWorkspace, VerifyResult, Workspace } from "./workspace.js";

export interface GitWorkspaceOptions {
  repoDir: string;
  worktreesDir: string;
  /** Where main is fetched from and branches are pushed to: https://github.com/<owner>/<repo>.git. */
  pushUrl: string;
  baseBranch?: string;
  /** Sent as an HTTP header through git's env config for fetch and push, never in argv. */
  pushToken?: string;
  /** Environment to derive child environments from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Applied to command output before it is truncated into an error or summary. */
  redact?: (text: string) => string;
  installTimeoutMs?: number;
  verifyTimeoutMs?: number;
}

const AGENT_BRANCH = /^agent\/issue-[1-9][0-9]*$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const GIT_TIMEOUT_MS = 5 * 60_000;
/** Prepended to every git command: no hooks, no fsmonitor daemon, whatever the repo config says. */
const SAFE_GIT_FLAGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="];
/** Added for commands that talk to the network: TLS on, no proxy, no credential helpers or askpass. */
const NETWORK_GIT_FLAGS = [
  "-c",
  "http.sslVerify=true",
  "-c",
  "http.proxy=",
  "-c",
  "credential.helper=",
  "-c",
  "core.askPass=",
];
/** The only repo/worktree config keys git itself writes for this setup. Anything else is refused. */
const ALLOWED_CONFIG: readonly RegExp[] = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|sparsecheckout|sparsecheckoutcone)$/,
  /^extensions\.worktreeconfig$/,
  /^remote\.origin\.(url|fetch)$/,
  /^branch\.[^=]+\.(remote|merge)$/,
  /^user\.(name|email)$/,
];
/** Turbo remote-cache credentials: verify must not read or write a shared cache. */
const TURBO_REMOTE = ["TURBO_TOKEN", "TURBO_TEAM", "TURBO_API"];

/**
 * Git worktrees under WORKTREES_DIR, created from REPO_DIR. Every command runs
 * through {@link CommandRunner} with an argument array; only the issue number
 * (an integer), derived names and SHAs ever reach git. Commands that change
 * REPO_DIR itself (fetch, worktree add/remove/prune, sparse-checkout) run one
 * at a time.
 */
export class GitWorkspace implements Workspace {
  private readonly baseBranch: string;
  private readonly worktreesDir: string;
  private readonly repoLock = new Mutex();
  private readonly redact: (text: string) => string;
  /** For git: no secrets at all, no system or global git config. */
  private readonly gitEnv: Record<string, string>;
  /** For pnpm, which runs code the agent wrote: no API keys, no remote cache. */
  private readonly pnpmEnv: Record<string, string>;

  constructor(
    private readonly options: GitWorkspaceOptions,
    private readonly runner: CommandRunner = new SpawnCommandRunner(options.redact),
  ) {
    const env = options.env ?? process.env;
    this.baseBranch = options.baseBranch ?? "main";
    this.worktreesDir = resolve(options.worktreesDir);
    this.redact = options.redact ?? ((text) => text);
    this.gitEnv = {
      ...withoutSecrets(env, [...ORCHESTRATOR_SECRETS, "ANTHROPIC_API_KEY"]),
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    this.pnpmEnv = {
      ...withoutSecrets(env, [...ORCHESTRATOR_SECRETS, "ANTHROPIC_API_KEY", ...TURBO_REMOTE]),
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

    const { baseSha, remoteBranchSha } = await this.repoLock.run(async () => {
      const repo = this.options.repoDir;
      await this.assertSafeRepo([repo]);
      const trackingRef = `refs/remotes/origin/${this.baseBranch}`;
      await this.git(
        repo,
        [
          ...NETWORK_GIT_FLAGS,
          "fetch",
          "--prune",
          "--no-tags",
          this.options.pushUrl,
          `+refs/heads/${this.baseBranch}:${trackingRef}`,
        ],
        this.authEnv(),
      );
      // Read once, right after the fetch, and keep it in memory from here on.
      const base = (
        await this.git(repo, ["rev-parse", "--verify", `${trackingRef}^{commit}`])
      ).output.trim();
      if (!SHA.test(base)) throw new Error(`Unexpected base SHA: ${this.tail(base)}`);
      const remote = await this.git(
        repo,
        [...NETWORK_GIT_FLAGS, "ls-remote", this.options.pushUrl, `refs/heads/${branch}`],
        this.authEnv(),
      );
      const remoteSha = remote.output.trim().split(/\s+/)[0] ?? "";
      // -B resets the branch if an earlier run of the same issue created it.
      await this.git(repo, ["worktree", "add", "-B", branch, dir, base]);
      // holdout/ never reaches the agent's disk. Sparse entries are skip-worktree
      // in the index, so commits made here keep the holdout files on the branch.
      await this.git(dir, ["sparse-checkout", "set", "--no-cone", "/*", "!/holdout/"]);
      return { baseSha: base, remoteBranchSha: SHA.test(remoteSha) ? remoteSha : null };
    });

    await this.install(dir);
    return { dir, branch, baseSha, remoteBranchSha };
  }

  async isClean(dir: string): Promise<boolean> {
    this.assertInside(dir);
    const result = await this.git(dir, ["status", "--porcelain"]);
    return result.output.trim() === "";
  }

  async headSha(ws: PreparedWorkspace): Promise<string> {
    this.assertInside(ws.dir);
    const head = (await this.git(ws.dir, ["rev-parse", "--verify", "HEAD^{commit}"])).output.trim();
    if (!SHA.test(head)) throw new Error(`Unexpected HEAD: ${this.tail(head)}`);
    const ancestor = await this.runner.run(
      "git",
      [...SAFE_GIT_FLAGS, "merge-base", "--is-ancestor", ws.baseSha, head],
      { cwd: ws.dir, env: this.gitEnv, timeoutMs: GIT_TIMEOUT_MS },
    );
    if (ancestor.code !== 0) {
      throw new Error(`HEAD ${head} does not descend from the fetched base ${ws.baseSha}`);
    }
    return head;
  }

  async changedFiles(ws: PreparedWorkspace, headSha: string): Promise<string[]> {
    this.assertInside(ws.dir);
    assertSha(headSha);
    // Every commit, merges split per parent: a file added then removed still counts.
    const result = await this.git(ws.dir, [
      "log",
      "--no-renames",
      "-m",
      "--name-only",
      "--format=",
      `${ws.baseSha}..${headSha}`,
    ]);
    const files = result.output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return [...new Set(files)];
  }

  async commitsAhead(ws: PreparedWorkspace, headSha: string): Promise<number> {
    this.assertInside(ws.dir);
    assertSha(headSha);
    const out = await this.git(ws.dir, ["rev-list", "--count", `${ws.baseSha}..${headSha}`]);
    const count = Number.parseInt(out.output.trim(), 10);
    if (!Number.isInteger(count))
      throw new Error(`Unexpected rev-list output: ${this.tail(out.output)}`);
    return count;
  }

  async verify(dir: string): Promise<VerifyResult> {
    this.assertInside(dir);
    // Nothing the agent's run left behind (node_modules, caches, build output) survives.
    await this.git(dir, ["clean", "-ffdx"]);
    const install = await this.runner.run(
      "pnpm",
      ["install", "--frozen-lockfile", "--prefer-offline"],
      { cwd: dir, env: this.pnpmEnv, timeoutMs: this.options.installTimeoutMs ?? 10 * 60_000 },
    );
    if (install.code !== 0) {
      return { passed: false, summary: `pnpm install failed: ${this.summary(install.output)}` };
    }
    const result = await this.runner.run("pnpm", ["verify"], {
      cwd: dir,
      env: { ...this.pnpmEnv, TURBO_FORCE: "1" },
      timeoutMs: this.options.verifyTimeoutMs ?? 20 * 60_000,
    });
    return { passed: result.code === 0, summary: this.summary(result.output) };
  }

  async push(ws: PreparedWorkspace, headSha: string): Promise<void> {
    this.assertInside(ws.dir);
    assertSha(headSha);
    if (!AGENT_BRANCH.test(ws.branch)) {
      throw new Error(`Refusing to push "${ws.branch}": only agent/issue-<n> branches are pushed`);
    }
    await this.assertSafeRepo([this.options.repoDir, ws.dir]);
    // Lease on what prepare() saw on the remote: a re-run may replace its own
    // earlier branch, never commits someone pushed since. Empty = must not exist.
    await this.git(
      ws.dir,
      [
        ...NETWORK_GIT_FLAGS,
        "push",
        "--no-verify",
        `--force-with-lease=refs/heads/${ws.branch}:${ws.remoteBranchSha ?? ""}`,
        this.options.pushUrl,
        `${headSha}:refs/heads/${ws.branch}`,
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

  private async install(dir: string): Promise<void> {
    const install = await this.runner.run(
      "pnpm",
      ["install", "--frozen-lockfile", "--prefer-offline"],
      { cwd: dir, env: this.pnpmEnv, timeoutMs: this.options.installTimeoutMs ?? 10 * 60_000 },
    );
    if (install.code !== 0) {
      throw new Error(`pnpm install failed (exit ${install.code}): ${this.tail(install.output)}`);
    }
  }

  /**
   * Refuses executable hooks and any repo or worktree config key outside a
   * tight allowlist (url.*.insteadOf, http.proxy, credential.helper,
   * include.path, core.hooksPath, ...). Runs before every fetch and push.
   */
  private async assertSafeRepo(dirs: readonly string[]): Promise<void> {
    const problems: string[] = [];

    const repo = this.options.repoDir;
    const commonDir = (await this.git(repo, ["rev-parse", "--git-common-dir"])).output.trim();
    const hooksDir = resolve(repo, commonDir, "hooks");
    const entries = await readdir(hooksDir).catch(() => [] as string[]);
    for (const name of entries) {
      if (name.endsWith(".sample")) continue;
      const info = await stat(join(hooksDir, name)).catch(() => null);
      if (info?.isFile() && (info.mode & 0o111) !== 0) problems.push(`executable hook ${name}`);
    }

    for (const dir of dirs) {
      const list = await this.runner.run(
        "git",
        ["config", "--list", "--show-scope", "--includes"],
        { cwd: dir, env: this.gitEnv, timeoutMs: GIT_TIMEOUT_MS },
      );
      if (list.code !== 0) throw new Error(`git config --list failed: ${this.tail(list.output)}`);
      for (const line of list.output.split("\n").filter(Boolean)) {
        const [scope = "", entry = ""] = line.split("\t");
        // "command" is what the orchestrator's own process passes (-c, GIT_CONFIG_*).
        if (scope === "command") continue;
        const key = (entry.split("=")[0] ?? "").toLowerCase();
        if (!ALLOWED_CONFIG.some((re) => re.test(key))) problems.push(`${scope} config ${key}`);
      }
    }

    if (problems.length > 0) {
      throw new Error(
        `Refusing to use REPO_DIR: ${[...new Set(problems)].join(", ")}. Remove them from the orchestrator's clone.`,
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
      const verb = args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? "command";
      throw new Error(`git ${verb} failed (exit ${result.code}): ${this.tail(result.output)}`);
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

  /** Redact first, then cut: a secret straddling the cut cannot leak a prefix. */
  private tail(output: string, max = 800): string {
    return this.redact(output).trim().slice(-max);
  }

  private summary(output: string): string {
    return summaryLine(this.redact(output));
  }
}

function assertSha(sha: string): void {
  if (!SHA.test(sha)) throw new Error(`Not a commit SHA: ${sha.slice(0, 80)}`);
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
