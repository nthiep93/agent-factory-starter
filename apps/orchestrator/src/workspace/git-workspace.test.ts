import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SpawnCommandRunner,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
} from "./command-runner.js";
import { GitWorkspace, summaryLine } from "./git-workspace.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    env: gitEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

interface RecordedCall {
  command: string;
  args: readonly string[];
  options: CommandOptions;
}

/** Real git; pnpm is stubbed because a full install per test would be too slow. */
class StubPnpmRunner implements CommandRunner {
  readonly calls: RecordedCall[] = [];
  pnpmResult: CommandResult = { code: 0, output: "" };
  /** When set, decides each pnpm result (e.g. install ok, verify failing). */
  pnpmFor: ((args: readonly string[]) => CommandResult) | null = null;
  private readonly real = new SpawnCommandRunner();

  run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    if (command === "pnpm") return Promise.resolve(this.pnpmFor?.(args) ?? this.pnpmResult);
    return this.real.run(command, args, { ...options, env: { ...options.env, ...gitEnv } });
  }
}

describe("GitWorkspace against a real git origin and clone", () => {
  let root: string;
  let origin: string;
  let repoDir: string;
  let worktreesDir: string;
  let runner: StubPnpmRunner;
  let workspace: GitWorkspace;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orchestrator-ws-"));
    origin = join(root, "origin.git");
    repoDir = join(root, "repo");
    worktreesDir = join(root, "worktrees");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, repoDir);
    await writeFile(join(repoDir, "README.md"), "hello\n");
    await mkdir(join(repoDir, "holdout"));
    await writeFile(join(repoDir, "holdout", "scenario.md"), "secret acceptance test\n");
    git(repoDir, "add", "README.md", "holdout/scenario.md");
    git(repoDir, "commit", "-q", "-m", "initial");
    git(repoDir, "push", "-q", "origin", "HEAD:main");

    runner = new StubPnpmRunner();
    workspace = new GitWorkspace(
      {
        repoDir,
        worktreesDir,
        pushUrl: origin,
        env: {
          PATH: process.env.PATH ?? "",
          GITHUB_TOKEN: "ghp_x",
          ANTHROPIC_API_KEY: "sk-ant-test",
          TURBO_TOKEN: "turbo-remote",
        },
      },
      runner,
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("prepares a worktree on agent/issue-<n> from origin/main and installs deps", async () => {
    // origin moved on since the clone: prepare must fetch and branch from the new tip.
    const other = join(root, "other");
    git(root, "clone", "-q", origin, other);
    await writeFile(join(other, "later.txt"), "later\n");
    git(other, "add", "later.txt");
    git(other, "commit", "-q", "-m", "later");
    git(other, "push", "-q", "origin", "HEAD:main");

    const ws = await workspace.prepare(42);

    expect(ws).toEqual({
      dir: join(worktreesDir, "issue-42"),
      branch: "agent/issue-42",
      baseSha: git(origin, "rev-parse", "refs/heads/main"),
      remoteBranchSha: null,
    });
    expect(git(ws.dir, "branch", "--show-current")).toBe("agent/issue-42");
    expect(existsSync(join(ws.dir, "later.txt"))).toBe(true);
    expect(await workspace.commitsAhead(ws, await workspace.headSha(ws))).toBe(0);

    const fetch = runner.calls.find((c) => c.args.includes("fetch"));
    expect(fetch?.args).toEqual(
      expect.arrayContaining([
        "core.hooksPath=/dev/null",
        "http.sslVerify=true",
        "http.proxy=",
        "credential.helper=",
        "core.askPass=",
        origin,
        "+refs/heads/main:refs/remotes/origin/main",
      ]),
    );
    for (const call of runner.calls.filter((c) => c.command === "git")) {
      expect(call.options.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(call.options.env.GITHUB_TOKEN).toBeUndefined();
      expect(call.options.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    }

    const install = runner.calls.find((c) => c.command === "pnpm");
    expect(install?.args).toEqual(["install", "--frozen-lockfile", "--prefer-offline"]);
    expect(install?.options.cwd).toBe(ws.dir);
    expect(install?.options.env.GITHUB_TOKEN).toBeUndefined();
    expect(runner.calls.every((c) => !c.args.join(" ").includes("ghp_x"))).toBe(true);
  });

  it("counts commits, pushes the branch to origin and keeps it after cleanup", async () => {
    const ws = await workspace.prepare(7);
    await writeFile(join(ws.dir, "feature.ts"), "export const x = 1;\n");
    git(ws.dir, "add", "feature.ts");
    git(ws.dir, "commit", "-q", "-m", "feat: x");

    const head = await workspace.headSha(ws);
    expect(await workspace.commitsAhead(ws, head)).toBe(1);
    await workspace.push(ws, head);
    const push = runner.calls.find((c) => c.args.includes("push"));
    expect(push?.args).toEqual(
      expect.arrayContaining([
        "--no-verify",
        "credential.helper=",
        origin,
        `${head}:refs/heads/agent/issue-7`,
      ]),
    );

    const remoteSha = git(origin, "rev-parse", "refs/heads/agent/issue-7");
    expect(remoteSha).toBe(git(ws.dir, "rev-parse", "HEAD"));

    await workspace.cleanup(ws.dir);
    expect(existsSync(ws.dir)).toBe(false);
    expect(git(repoDir, "worktree", "list")).not.toContain("issue-7");
    expect(git(repoDir, "branch", "--list", "agent/issue-7")).toContain("agent/issue-7");
  });

  it("re-runs an issue: replaces a stale worktree and updates the pushed branch", async () => {
    const first = await workspace.prepare(9);
    await writeFile(join(first.dir, "a.txt"), "a\n");
    git(first.dir, "add", "a.txt");
    git(first.dir, "commit", "-q", "-m", "first try");
    await workspace.push(first, await workspace.headSha(first));
    const firstSha = git(origin, "rev-parse", "refs/heads/agent/issue-9");
    // Simulate a crash: the worktree directory is left behind.

    const second = await workspace.prepare(9);
    expect(second.dir).toBe(first.dir);
    expect(second.remoteBranchSha).toBe(firstSha);
    expect(existsSync(join(second.dir, "a.txt"))).toBe(false);
    await writeFile(join(second.dir, "b.txt"), "b\n");
    git(second.dir, "add", "b.txt");
    git(second.dir, "commit", "-q", "-m", "second try");
    await workspace.push(second, await workspace.headSha(second));

    expect(git(origin, "log", "--format=%s", "-1", "refs/heads/agent/issue-9")).toBe("second try");
    await workspace.cleanup(second.dir);
  });

  it("refuses to push anything but an agent/issue-<n> branch", async () => {
    const ws = await workspace.prepare(3);
    const head = await workspace.headSha(ws);
    await expect(workspace.push({ ...ws, branch: "main" }, head)).rejects.toThrow(/agent\/issue-/);
    await expect(workspace.push(ws, "HEAD")).rejects.toThrow(/SHA/);
    await workspace.cleanup(ws.dir);
  });

  it("refuses to clean up a directory outside WORKTREES_DIR", async () => {
    await expect(workspace.cleanup(repoDir)).rejects.toThrow(/outside/);
    expect(existsSync(repoDir)).toBe(true);
  });

  it("throws with the tail of the output when pnpm install fails", async () => {
    runner.pnpmResult = { code: 1, output: "lots\nof\nERR_PNPM_OUTDATED_LOCKFILE boom" };
    await expect(workspace.prepare(5)).rejects.toThrow(/pnpm install failed.*OUTDATED_LOCKFILE/s);
  });

  it("redacts command output before cutting it into an error message", async () => {
    const secret = "install-output-secret";
    const redacting = new GitWorkspace(
      { repoDir, worktreesDir, pushUrl: origin, redact: (t) => t.split(secret).join("[REDACTED]") },
      runner,
    );
    // tail() keeps the last 800 characters: the secret straddles that cut.
    runner.pnpmResult = { code: 1, output: `${secret}${"x".repeat(790)}` };
    const error = await redacting.prepare(30).then(
      () => new Error("expected prepare to fail"),
      (e: unknown) => e as Error,
    );
    expect(error.message).toMatch(/pnpm install failed/);
    expect(error.message).not.toContain("secret");
  });

  it("verifies on a clean tree: git clean -ffdx, fresh install, turbo cache bypassed", async () => {
    const ws = await workspace.prepare(12);
    await writeFile(join(ws.dir, "leftover.js"), "planted by the agent\n");
    runner.calls.length = 0;

    await workspace.verify(ws.dir);

    expect(existsSync(join(ws.dir, "leftover.js"))).toBe(false);
    const steps = runner.calls.map(
      (c) => `${c.command} ${c.args.filter((a) => !a.includes("=") && a !== "-c").join(" ")}`,
    );
    expect(steps).toEqual([
      "git clean -ffdx",
      "pnpm install --frozen-lockfile --prefer-offline",
      "pnpm verify",
    ]);
    const verifyEnv = runner.calls.at(-1)?.options.env ?? {};
    expect(verifyEnv.TURBO_FORCE).toBe("1");
    expect(verifyEnv.TURBO_TOKEN).toBeUndefined();
    expect(verifyEnv.ANTHROPIC_API_KEY).toBeUndefined();

    runner.pnpmResult = { code: 1, output: "ERR_PNPM_OUTDATED_LOCKFILE" };
    expect(await workspace.verify(ws.dir)).toEqual({
      passed: false,
      summary: "pnpm install failed: ERR_PNPM_OUTDATED_LOCKFILE",
    });
    await workspace.cleanup(ws.dir);
  });

  it("reports verify pass and failure with a summary line", async () => {
    const ws = await workspace.prepare(11);
    runner.pnpmResult = {
      code: 0,
      output:
        "\u001b[32m Tasks:    6 successful, 6 total\u001b[0m\nCached:    0 cached\n  Time:    9s\n",
    };
    expect(await workspace.verify(ws.dir)).toEqual({
      passed: true,
      summary: "Tasks:    6 successful, 6 total",
    });
    const verifyCall = runner.calls.at(-1);
    expect(verifyCall?.args).toEqual(["verify"]);
    expect(verifyCall?.options.env.GITHUB_TOKEN).toBeUndefined();

    let call = 0;
    runner.pnpmFor = () =>
      ++call % 2 === 1
        ? { code: 0, output: "installed" }
        : { code: 1, output: "src/a.ts(1,1): error TS2322: nope\nELIFECYCLE failed" };
    expect(await workspace.verify(ws.dir)).toEqual({
      passed: false,
      summary: "ELIFECYCLE failed",
    });
    await workspace.cleanup(ws.dir);
  });
});

describe("GitWorkspace safety checks against a real git setup", () => {
  let root: string;
  let origin: string;
  let repoDir: string;
  let workspace: GitWorkspace;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orchestrator-ws-"));
    origin = join(root, "origin.git");
    repoDir = join(root, "repo");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    git(root, "clone", "-q", origin, repoDir);
    await writeFile(join(repoDir, "README.md"), "hello\n");
    await mkdir(join(repoDir, "holdout"));
    await writeFile(join(repoDir, "holdout", "scenario.md"), "secret\n");
    git(repoDir, "add", "-A");
    git(repoDir, "commit", "-q", "-m", "initial");
    git(repoDir, "push", "-q", "origin", "HEAD:main");
    workspace = new GitWorkspace(
      { repoDir, worktreesDir: join(root, "worktrees"), pushUrl: origin },
      new StubPnpmRunner(),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps holdout/ off disk and a commit of everything does not delete it on the branch", async () => {
    const ws = await workspace.prepare(4);
    expect(existsSync(join(ws.dir, "holdout"))).toBe(false);
    expect(existsSync(join(ws.dir, "README.md"))).toBe(true);
    expect(await workspace.isClean(ws.dir)).toBe(true);

    await writeFile(join(ws.dir, "README.md"), "changed\n");
    git(ws.dir, "add", "-A");
    git(ws.dir, "commit", "-q", "-m", "change everything");
    await workspace.push(ws, await workspace.headSha(ws));

    expect(git(origin, "ls-tree", "-r", "--name-only", "refs/heads/agent/issue-4")).toContain(
      "holdout/scenario.md",
    );
    expect(await workspace.changedFiles(ws, await workspace.headSha(ws))).toEqual(["README.md"]);
    await workspace.cleanup(ws.dir);
  });

  it("reports a dirty tree and lists changed files", async () => {
    const ws = await workspace.prepare(5);
    await mkdir(join(ws.dir, ".github"));
    await writeFile(join(ws.dir, ".github", "ci.yml"), "x\n");
    expect(await workspace.isClean(ws.dir)).toBe(false);
    git(ws.dir, "add", ".github/ci.yml");
    git(ws.dir, "commit", "-q", "-m", "ci");
    expect(await workspace.isClean(ws.dir)).toBe(true);
    expect(await workspace.changedFiles(ws, await workspace.headSha(ws))).toEqual([
      ".github/ci.yml",
    ]);
    await workspace.cleanup(ws.dir);
  });

  it("checks the fetched base SHA, not refs: moving origin/main does not hide a commit", async () => {
    const ws = await workspace.prepare(20);
    await mkdir(join(ws.dir, ".github"));
    await writeFile(join(ws.dir, ".github", "ci.yml"), "x\n");
    git(ws.dir, "add", ".github/ci.yml");
    git(ws.dir, "commit", "-q", "-m", "ci");
    // Agent-written code moves the tracking ref to HEAD to make the branch look empty.
    git(repoDir, "update-ref", "refs/remotes/origin/main", git(ws.dir, "rev-parse", "HEAD"));

    const head = await workspace.headSha(ws);
    expect(await workspace.changedFiles(ws, head)).toEqual([".github/ci.yml"]);
    expect(await workspace.commitsAhead(ws, head)).toBe(1);
    await workspace.cleanup(ws.dir);
  });

  it("lists paths of every commit, even when a later commit undoes them", async () => {
    const ws = await workspace.prepare(21);
    await mkdir(join(ws.dir, ".github"));
    await writeFile(join(ws.dir, ".github", "ci.yml"), "x\n");
    git(ws.dir, "add", "-A");
    git(ws.dir, "commit", "-q", "-m", "add ci");
    git(ws.dir, "rm", "-q", ".github/ci.yml");
    git(ws.dir, "commit", "-q", "-m", "remove ci");
    await writeFile(join(ws.dir, "src.ts"), "x\n");
    git(ws.dir, "add", "src.ts");
    git(ws.dir, "commit", "-q", "-m", "src");

    const head = await workspace.headSha(ws);
    expect(git(ws.dir, "diff", "--name-only", `${ws.baseSha}...${head}`)).toBe("src.ts");
    expect(await workspace.changedFiles(ws, head)).toEqual(["src.ts", ".github/ci.yml"]);
    await workspace.cleanup(ws.dir);
  });

  it("refuses a HEAD that does not descend from the fetched base", async () => {
    const ws = await workspace.prepare(22);
    git(ws.dir, "checkout", "-q", "--orphan", "rewritten");
    git(ws.dir, "commit", "-q", "-m", "unrelated history");
    await expect(workspace.headSha(ws)).rejects.toThrow(/does not descend/);
    await workspace.cleanup(ws.dir);
  });

  it("pushes exactly the verified SHA even if HEAD moves afterwards", async () => {
    const ws = await workspace.prepare(23);
    await writeFile(join(ws.dir, "a.ts"), "a\n");
    git(ws.dir, "add", "a.ts");
    git(ws.dir, "commit", "-q", "-m", "verified");
    const verified = await workspace.headSha(ws);
    await writeFile(join(ws.dir, "b.ts"), "b\n");
    git(ws.dir, "add", "b.ts");
    git(ws.dir, "commit", "-q", "-m", "sneaked in after verify");

    await workspace.push(ws, verified);

    expect(git(origin, "rev-parse", "refs/heads/agent/issue-23")).toBe(verified);
    await workspace.cleanup(ws.dir);
  });

  it("refuses planted git config: insteadOf, proxy, credential helper, include", async () => {
    const included = join(root, "included.gitconfig");
    await writeFile(included, "[user]\n  name = x\n");
    for (const [key, value] of [
      ["url.https://evil.example/.insteadOf", origin],
      ["http.proxy", "http://127.0.0.1:9"],
      ["credential.helper", "!sh -c 'cat >/tmp/stolen'"],
      ["include.path", included],
    ] as const) {
      git(repoDir, "config", key, value);
      await expect(workspace.prepare(24)).rejects.toThrow(
        new RegExp(`local config ${key.replace(/[.]/g, "\\.")}`, "i"),
      );
      git(repoDir, "config", "--unset", key);
    }
    const ws = await workspace.prepare(24);
    await workspace.cleanup(ws.dir);
  });

  it("refuses to push when the worktree's config.worktree gains a key", async () => {
    const ws = await workspace.prepare(25);
    await writeFile(join(ws.dir, "a.ts"), "a\n");
    git(ws.dir, "add", "a.ts");
    git(ws.dir, "commit", "-q", "-m", "a");
    git(ws.dir, "config", "--worktree", "http.proxy", "http://127.0.0.1:9");

    await expect(workspace.push(ws, await workspace.headSha(ws))).rejects.toThrow(
      /worktree config http\.proxy/,
    );
    expect(git(origin, "branch", "--list", "agent/issue-25")).toBe("");
    await workspace.cleanup(ws.dir);
  });

  it("refuses a REPO_DIR with an executable hook", async () => {
    const hook = join(repoDir, ".git", "hooks", "pre-push");
    await writeFile(hook, "#!/bin/sh\nexit 0\n");
    await chmod(hook, 0o755);
    await expect(workspace.prepare(6)).rejects.toThrow(/executable hook pre-push/);
  });

  it("refuses a REPO_DIR with core.hooksPath, core.fsmonitor or a pushurl", async () => {
    for (const [key, value] of [
      ["core.hooksPath", "/tmp/hooks"],
      ["core.fsmonitor", "/tmp/monitor"],
      ["remote.origin.pushurl", "https://example.com/evil.git"],
    ] as const) {
      git(repoDir, "config", key, value);
      await expect(workspace.prepare(6)).rejects.toThrow(new RegExp(key, "i"));
      git(repoDir, "config", "--unset", key);
    }
    const ws = await workspace.prepare(6);
    await workspace.cleanup(ws.dir);
  });

  it("serializes repo-level git commands: concurrent prepares both succeed", async () => {
    const [a, b, c] = await Promise.all([
      workspace.prepare(11),
      workspace.prepare(12),
      workspace.prepare(13),
    ]);
    for (const ws of [a, b, c]) {
      expect(git(ws.dir, "branch", "--show-current")).toBe(ws.branch);
      expect(existsSync(join(ws.dir, "README.md"))).toBe(true);
    }
    await Promise.all([a, b, c].map((ws) => workspace.cleanup(ws.dir)));
    expect(git(repoDir, "worktree", "list").split("\n")).toHaveLength(1);
  });
});

describe("summaryLine", () => {
  it("prefers the turbo Tasks line, then the vitest Tests line, then the last line", () => {
    expect(summaryLine("a\n Tasks:  2 successful, 2 total\n Time: 1s\n")).toBe(
      "Tasks:  2 successful, 2 total",
    );
    expect(summaryLine("x\n      Tests  12 passed (12)\n   Duration  1s\n")).toBe(
      "Tests  12 passed (12)",
    );
    expect(summaryLine("first\nlast line\n\n")).toBe("last line");
    expect(summaryLine("")).toBe("(no output)");
  });
});
