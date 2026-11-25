// End-to-end tests for scripts/unblock-tasks.mjs with a fake gh on PATH.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildFactory, fakeGh, runScript } from "./script-test-helpers.mjs";

let distDir;
beforeAll(() => {
  distDir = buildFactory();
}, 120_000);

const deps = (...lines) => `### Goal\n\nx\n\n### Dependencies\n\n${lines.join("\n")}\n`;
const waiting = [{ name: "risk:low" }, { name: "waiting-on-deps" }];

/** Writes the issue list and per-issue states the fake gh serves. */
function world(issues, states) {
  const dir = mkdtempSync(join(tmpdir(), "unblock-"));
  const statesDir = join(dir, "states");
  mkdirSync(statesDir);
  writeFileSync(join(dir, "issues.json"), JSON.stringify(issues));
  for (const [number, state] of Object.entries(states)) {
    writeFileSync(join(statesDir, `${number}.json`), JSON.stringify(state));
  }
  return { FAKE_GH_ISSUES: join(dir, "issues.json"), FAKE_GH_STATES: statesDir };
}

const url = (n, kind = "issues") => `https://github.com/o/r/${kind}/${n}`;
const CLOSED = (n) => ({ state: "CLOSED", stateReason: "COMPLETED", url: url(n) });
const OPEN = (n) => ({ state: "OPEN", stateReason: null, url: url(n) });

const run = (args, gh, env) =>
  runScript("unblock-tasks.mjs", args, {
    distDir,
    gh,
    env: { FAKE_GH_LABELS: '[{"name":"waiting-on-deps"},{"name":"ready-for-agent"}]', ...env },
  });

const summary = (gh) =>
  gh.readCalls().map((c) => [c.args.slice(0, 3).join(" "), ...c.args.slice(3)].join(" | "));

describe("unblock-tasks", () => {
  it("moves issues whose dependencies are all closed to ready-for-agent and comments", () => {
    const gh = fakeGh();
    const env = world(
      [
        // ready: both deps closed
        {
          number: 20,
          labels: waiting,
          body: deps("- Depends on #10 (T1)", "- Depends on #11 (T2)"),
        },
        // still waiting: #12 open
        {
          number: 21,
          labels: waiting,
          body: deps("- Depends on #10 (T1)", "- Depends on #12 (T3)"),
        },
        // still waiting: a dependency has no issue yet
        {
          number: 22,
          labels: waiting,
          body: deps(
            "- Depends on #10 (T1)",
            "- Depends on T4 (no issue yet; add the link when it exists)",
          ),
        },
        // no machine-readable deps: left for a human
        { number: 23, labels: waiting, body: "Hand-written issue, depends on the login work." },
        // dependency closed as not planned: not unblocked
        { number: 24, labels: waiting, body: deps("- Depends on #13 (T5)") },
      ],
      {
        10: CLOSED(10),
        11: CLOSED(11),
        12: OPEN(12),
        13: { state: "CLOSED", stateReason: "NOT_PLANNED", url: url(13) },
      },
    );
    const { status, stdout, stderr } = run([], gh, env);
    expect(stderr).toBe("");
    expect(status).toBe(0);

    const calls = summary(gh);
    expect(calls[0]).toBe(
      "issue list --label | waiting-on-deps | --state | open | --limit | 500 | --json | number,body,labels",
    );
    // Each dependency is looked up once, even when several issues share it.
    expect(calls.filter((c) => c.startsWith("issue view 10 "))).toHaveLength(1);
    expect(
      calls.filter((c) => c.startsWith("issue edit") || c.startsWith("issue comment")),
    ).toEqual([
      "issue edit 20 | --remove-label | waiting-on-deps | --add-label | ready-for-agent",
      expect.stringMatching(/^issue comment 20 \| --body-file \| /),
    ]);
    const comment = gh.readCalls().find((c) => c.args[1] === "comment");
    expect(comment.body).toBe(
      "Dependencies #10, #11 are closed. Add the `agent` label to start the agent.\n",
    );
    expect(calls.some((c) => c.includes("--add-label | agent"))).toBe(false);

    expect(stdout).toContain("#20: ready-for-agent (dependencies #10, #11 closed)");
    expect(stdout).toContain("#21: waiting on #12");
    expect(stdout).toContain("#22: waiting on T4 (no issue yet)");
    expect(stdout).toContain("#23: no Depends on #N lines, left for a human");
    expect(stdout).toContain("#24: waiting on #13 (closed as not_planned)");
    expect(stdout).toContain("Unblocked 1 of 5 waiting issues.");
  });

  it("uses singular wording for one dependency and creates the ready label when missing", () => {
    const gh = fakeGh();
    const env = world([{ number: 30, labels: waiting, body: deps("- Depends on #10 (T1)") }], {
      10: CLOSED(10),
    });
    const { status } = run([], gh, { ...env, FAKE_GH_LABELS: '[{"name":"waiting-on-deps"}]' });
    expect(status).toBe(0);
    const calls = summary(gh);
    expect(calls).toContain(
      "label create ready-for-agent | --color | 0075ca | --description | Dependencies closed: add agent to start",
    );
    const comment = gh.readCalls().find((c) => c.args[1] === "comment");
    expect(comment.body).toBe(
      "Dependency #10 is closed. Add the `agent` label to start the agent.\n",
    );
  });

  it("changes nothing with --dry-run", () => {
    const gh = fakeGh();
    const env = world([{ number: 20, labels: waiting, body: deps("- Depends on #10 (T1)") }], {
      10: CLOSED(10),
    });
    const { status, stdout } = run(["--dry-run"], gh, env);
    expect(status).toBe(0);
    expect(stdout).toContain("#20: ready-for-agent (dependency #10 closed) [dry run]");
    expect(summary(gh).every((c) => /^(issue list|issue view|label list)/.test(c))).toBe(true);
  });

  it("counts a dependency as done only when closed as COMPLETED", () => {
    const gh = fakeGh();
    const issues = [31, 32, 33, 34].map((n, i) => ({
      number: n,
      labels: waiting,
      body: deps(`- Depends on #${40 + i} (T1)`),
    }));
    const env = world(issues, {
      40: { state: "CLOSED", stateReason: "DUPLICATE", url: url(40) },
      41: { state: "CLOSED", stateReason: null, url: url(41) },
      42: { state: "CLOSED", stateReason: "", url: url(42) },
      43: { state: "CLOSED", url: url(43) },
    });
    const { status, stdout } = run([], gh, env);
    expect(status).toBe(0);
    expect(stdout).toContain("#31: waiting on #40 (closed as duplicate)");
    expect(stdout).toContain("#32: waiting on #41 (closed without a reason)");
    expect(stdout).toContain("#33: waiting on #42 (closed without a reason)");
    expect(stdout).toContain("#34: waiting on #43 (closed without a reason)");
    expect(stdout).toContain("Unblocked 0 of 4 waiting issues.");
    expect(summary(gh).some((c) => c.startsWith("issue edit"))).toBe(false);
  });

  it("requests the url and rejects a pull request as a dependency", () => {
    const gh = fakeGh();
    const env = world([{ number: 20, labels: waiting, body: deps("- Depends on #15 (T1)") }], {
      15: { state: "CLOSED", stateReason: "COMPLETED", url: url(15, "pull") },
    });
    const { status, stdout } = run([], gh, env);
    expect(status).toBe(0);
    expect(summary(gh)).toContain("issue view 15 | --json | state,stateReason,url");
    expect(stdout).toContain("#20: waiting on #15 (unknown)");
  });

  it("only acts on risk:low or risk:medium issues", () => {
    const gh = fakeGh();
    const env = world(
      [
        {
          number: 50,
          labels: [{ name: "risk:high" }, { name: "waiting-on-deps" }],
          body: deps("- Depends on #10 (T1)"),
        },
        { number: 51, labels: [{ name: "waiting-on-deps" }], body: deps("- Depends on #10 (T1)") },
        {
          number: 52,
          labels: [{ name: "risk:low" }, { name: "risk:high" }, { name: "waiting-on-deps" }],
          body: deps("- Depends on #10 (T1)"),
        },
        {
          number: 53,
          labels: [{ name: "risk:medium" }, { name: "waiting-on-deps" }],
          body: deps("- Depends on #10 (T1)"),
        },
      ],
      { 10: CLOSED(10) },
    );
    const { status, stdout } = run([], gh, env);
    expect(status).toBe(0);
    expect(stdout).toContain("#50: skipped, not labeled risk:low or risk:medium");
    expect(stdout).toContain("#51: skipped, not labeled risk:low or risk:medium");
    expect(stdout).toContain("#52: skipped, not labeled risk:low or risk:medium");
    expect(stdout).toContain("#53: ready-for-agent (dependency #10 closed)");
    expect(summary(gh).filter((c) => c.startsWith("issue edit"))).toEqual([
      "issue edit 53 | --remove-label | waiting-on-deps | --add-label | ready-for-agent",
    ]);
  });

  it("treats a dependency gh cannot find as not closed", () => {
    const gh = fakeGh();
    const env = world([{ number: 20, labels: waiting, body: deps("- Depends on #99 (T1)") }], {});
    const { status, stdout, stderr } = run([], gh, env);
    expect(status).toBe(0);
    expect(stderr).toContain("Could not read #99");
    expect(stdout).toContain("#20: waiting on #99 (unknown)");
  });

  it("reports a failed edit, carries on with other issues and exits 1", () => {
    const gh = fakeGh();
    const env = world(
      [
        { number: 20, labels: waiting, body: deps("- Depends on #10 (T1)") },
        { number: 21, labels: waiting, body: deps("- Depends on #10 (T1)") },
      ],
      { 10: CLOSED(10) },
    );
    const { status, stdout, stderr } = run([], gh, { ...env, FAKE_GH_FAIL_EDIT: "20" });
    expect(status).toBe(1);
    expect(stderr).toContain("#20: gh issue edit failed: HTTP 403: forbidden");
    expect(stdout).toContain("#21: ready-for-agent");
  });

  it("handles no waiting issues", () => {
    const gh = fakeGh();
    const { status, stdout } = run([], gh, world([], {}));
    expect(status).toBe(0);
    expect(stdout).toContain("No open issues labeled waiting-on-deps.");
  });

  it("rejects unknown arguments", () => {
    expect(run(["--force"], fakeGh(), world([], {})).status).toBe(2);
  });
});
