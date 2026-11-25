// End-to-end tests for scripts/spec-to-issues.mjs with a fake gh on PATH.
import { beforeAll, describe, expect, it } from "vitest";
import { buildFactory, fakeGh, runScript, writeSpec } from "./script-test-helpers.mjs";

let distDir;
beforeAll(() => {
  distDir = buildFactory();
}, 120_000);

const run = (args, opts = {}) => runScript("spec-to-issues.mjs", args, { distDir, ...opts });

const task = (id, { depends = "none", risk = "low", area = "api" } = {}) =>
  `## ${id}: Task ${id}\ngoal: Do ${id}.\narea: ${area}\nrisk: ${risk}\ndepends: ${depends}\nAcceptance:\n- ${id} works\n`;

describe("spec-to-issues dry run", () => {
  it("validates specs/001-time-endpoint and prints the issues in order without calling gh", () => {
    const gh = fakeGh();
    const { status, stdout, stderr } = run(["specs/001-time-endpoint"], { gh });
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("Spec: specs/001-time-endpoint (3 tasks, valid)");
    expect(stdout).toContain("Order: T1 -> T2 -> T3");
    expect(stdout).toContain("=== 1/3  T1 -> #1  [agent] Add TimeResponse and buildTime");
    expect(stdout).toContain("- Depends on #1 (T1)\n- Depends on #2 (T2)");
    expect(stdout).toContain("[spec.md](specs/001-time-endpoint/spec.md)");
    expect(gh.readCalls()).toEqual([]);
  });

  it("orders by dependency and keeps high-risk tasks away from the agent", () => {
    const { cwd, rel } = writeSpec(
      task("T1", { depends: "T2" }) + "\n" + task("T2", { risk: "high", area: "shared" }),
    );
    const { status, stdout } = run([rel], { cwd });
    expect(status).toBe(0);
    expect(stdout).toContain("Order: T2 -> T1");
    expect(stdout).toMatch(/=== 1\/2 {2}T2 -> #1 .*\nlabels: {2}risk:high\n/);
    expect(stdout).toMatch(/=== 2\/2 {2}T1 -> #2 .*\nlabels: {2}risk:low, agent\n/);
  });
});

describe("spec-to-issues --create", () => {
  it("creates missing labels, then issues in dependency order with real issue numbers", () => {
    const gh = fakeGh();
    const { status, stdout, stderr } = run(["specs/001-time-endpoint", "--create"], {
      gh,
      env: { FAKE_GH_LABELS: '[{"name":"agent"},{"name":"bug"}]' },
    });
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("Created 3 issues: T1=#101, T2=#102, T3=#103");

    const calls = gh.readCalls();
    expect(calls.map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "label list",
      "label create",
      "issue create",
      "issue create",
      "issue create",
    ]);
    expect(calls[1].args.slice(0, 3)).toEqual(["label", "create", "risk:low"]);

    const issues = calls.slice(2);
    const flag = (args, name) => args.flatMap((a, i) => (args[i - 1] === name ? [a] : []));
    expect(issues.map((c) => flag(c.args, "--title")[0])).toEqual([
      "[agent] Add TimeResponse and buildTime to packages/shared",
      "[agent] Expose GET /time in the API",
      "[agent] Show web/API clock drift on the home page",
    ]);
    expect(issues.map((c) => flag(c.args, "--label"))).toEqual([
      ["risk:low", "agent"],
      ["risk:low", "agent"],
      ["risk:low", "agent"],
    ]);
    expect(issues[0].body).toContain("### Dependencies\n\nNone.");
    expect(issues[1].body).toContain("- Depends on #101 (T1)");
    expect(issues[2].body).toContain("- Depends on #101 (T1)\n- Depends on #102 (T2)");
    expect(issues[2].body).toContain("### Goal\n\nLet the maintainer see");
  });

  it("does not create labels that already exist", () => {
    const gh = fakeGh();
    const { cwd, rel } = writeSpec(task("T1"));
    const { status } = run([rel, "--create"], {
      gh,
      cwd,
      env: { FAKE_GH_LABELS: '[{"name":"agent"},{"name":"risk:low"}]' },
    });
    expect(status).toBe(0);
    expect(gh.readCalls().map((c) => c.args.slice(0, 2).join(" "))).toEqual([
      "label list",
      "issue create",
    ]);
  });

  it("stops at the first gh failure and reports what was already created", () => {
    const gh = fakeGh();
    const { status, stderr } = run(["specs/001-time-endpoint", "--create"], {
      gh,
      env: { FAKE_GH_LABELS: '[{"name":"agent"},{"name":"risk:low"}]', FAKE_GH_FAIL_AT: "102" },
    });
    expect(status).toBe(1);
    expect(stderr).toContain("gh issue create for T2 failed: HTTP 502: Bad Gateway");
    expect(stderr).toContain("Already created: T1=#101");
    expect(gh.readCalls().filter((c) => c.args[0] === "issue")).toHaveLength(2);
  });
});

describe("spec-to-issues errors", () => {
  it("exits 1 with line-numbered problems and never calls gh", () => {
    const gh = fakeGh();
    const { cwd, rel } = writeSpec(
      [
        "## T1: One", // 1
        "goal: g", // 2
        "area: mobile", // 3
        "risk: low", // 4
        "depends: T2", // 5
        "Acceptance:", // 6
        "- ok", // 7
        "", // 8
        "## T2: Two", // 9
        "goal: g", // 10
        "area: api", // 11
        "risk: low", // 12
        "depends: T1", // 13
        "owner: me", // 14
        "Acceptance:", // 15
      ].join("\n"),
    );
    const { status, stdout, stderr } = run([rel, "--create"], { gh, cwd });
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain('specs/042-demo/tasks.md:1: T1 has unknown area "mobile"');
    expect(stderr).toContain("specs/042-demo/tasks.md:1: Dependency cycle: T1 -> T2 -> T1");
    expect(stderr).toContain("specs/042-demo/tasks.md:9: T2 has no acceptance criteria");
    expect(stderr).toContain('specs/042-demo/tasks.md:14: Unknown key "owner" in T2');
    expect(stderr).toContain("4 problem(s). Fix tasks.md and run again.");
    expect(gh.readCalls()).toEqual([]);
  });

  it("requires spec.md and plan.md next to tasks.md", () => {
    const { cwd, rel } = writeSpec(task("T1"), { withPlan: false });
    const { status, stderr } = run([rel], { cwd });
    expect(status).toBe(1);
    expect(stderr).toContain("specs/042-demo/plan.md: file is missing");
  });

  it("rejects a tasks.md without tasks", () => {
    const { cwd, rel } = writeSpec("# Tasks\n\nNothing yet.\n");
    const { status, stderr } = run([rel], { cwd });
    expect(status).toBe(1);
    expect(stderr).toContain('no tasks found (expected "## T1: Title" headings)');
  });

  it("exits 2 with usage on bad arguments", () => {
    expect(run([]).status).toBe(2);
    const { status, stderr } = run(["specs/001-time-endpoint", "--yes"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown option: --yes");
  });

  it("explains how to build when the compiled package is missing", () => {
    const { status, stderr } = runScript("spec-to-issues.mjs", ["specs/001-time-endpoint"], {
      distDir: "/nonexistent-factory-dist",
    });
    expect(status).toBe(1);
    expect(stderr).toContain("Run: pnpm build --filter @repo/factory");
  });
});
