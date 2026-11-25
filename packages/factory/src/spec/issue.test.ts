import { describe, expect, it } from "vitest";
import { taskToIssue, type Task } from "./index";

const base: Task = {
  id: "T2",
  title: "Expose GET /time",
  goal: "Serve the server time so the web app can measure drift.",
  area: "api",
  risk: "low",
  depends: [],
  inScope: "apps/api/src/time/",
  outOfScope: "apps/web",
  acceptance: ["GET /time returns 200", "Body matches TimeResponse"],
  line: 12,
};

describe("taskToIssue", () => {
  it("renders the Agent task form sections, spec links and labels", () => {
    const issue = taskToIssue(base, { specDir: "specs/001-time-endpoint", issueNumbersById: {} });
    expect(issue.title).toBe("[agent] Expose GET /time");
    expect(issue.labels).toEqual(["risk:low", "agent"]);
    expect(issue.body).toBe(
      [
        "<!-- factory-task: specs/001-time-endpoint/tasks.md#T2 -->",
        "",
        "### Goal",
        "",
        "Serve the server time so the web app can measure drift.",
        "",
        "### Acceptance criteria",
        "",
        "- GET /time returns 200",
        "- Body matches TimeResponse",
        "",
        "### In scope / out of scope",
        "",
        "- In scope: `apps/api` (apps/api/src/time/)",
        "- Out of scope: apps/web",
        "",
        "### Risk",
        "",
        "Low (tests, docs, small isolated feature)",
        "",
        "### Spec",
        "",
        "- Spec: [spec.md](specs/001-time-endpoint/spec.md)",
        "- Plan: [plan.md](specs/001-time-endpoint/plan.md)",
        "- Task: T2 in [tasks.md](specs/001-time-endpoint/tasks.md)",
        "",
        "### Dependencies",
        "",
        "None.",
        "",
      ].join("\n"),
    );
  });

  it("normalises the spec dir to a relative posix path", () => {
    const issue = taskToIssue(base, { specDir: "./specs\\001-x/", issueNumbersById: {} });
    expect(issue.body).toContain("[spec.md](specs/001-x/spec.md)");
    expect(issue.body).toContain("[plan.md](specs/001-x/plan.md)");
  });

  it("uses default scope text when in-scope and out-of-scope are absent", () => {
    const issue = taskToIssue(
      { ...base, area: "shared", inScope: null, outOfScope: null },
      { specDir: "specs/001", issueNumbersById: {} },
    );
    expect(issue.body).toContain("- In scope: `packages/shared`\n");
    expect(issue.body).toContain(
      "- Out of scope: anything not needed for the acceptance criteria above",
    );
  });

  it("links created dependencies and adds agent when all of them exist", () => {
    const issue = taskToIssue(
      { ...base, depends: ["T1", "T0"] },
      { specDir: "specs/001", issueNumbersById: { T1: 41, T0: 40 } },
    );
    expect(issue.body).toContain(
      "### Dependencies\n\n- Depends on #41 (T1)\n- Depends on #40 (T0)\n",
    );
    expect(issue.labels).toEqual(["risk:low", "agent"]);
  });

  it("leaves agent off while a dependency has no issue yet", () => {
    const issue = taskToIssue(
      { ...base, depends: ["T1", "T3"] },
      { specDir: "specs/001", issueNumbersById: { T1: 41 } },
    );
    expect(issue.body).toContain(
      "- Depends on #41 (T1)\n- Depends on T3 (no issue yet; add the link when it exists)\n",
    );
    expect(issue.labels).toEqual(["risk:low"]);
  });

  it("maps medium risk to the form text and still dispatches", () => {
    const issue = taskToIssue({ ...base, risk: "medium" }, { specDir: "s", issueNumbersById: {} });
    expect(issue.body).toContain("### Risk\n\nMedium (touches shared types or several apps)\n");
    expect(issue.labels).toEqual(["risk:medium", "agent"]);
  });

  it("never labels a high-risk task for the agent", () => {
    const issue = taskToIssue(
      { ...base, risk: "high", depends: ["T1"] },
      { specDir: "s", issueNumbersById: { T1: 1 } },
    );
    expect(issue.labels).toEqual(["risk:high"]);
    expect(issue.body).toContain("High (auth, data, money, security) - do not label for the agent");
  });

  it("does not dispatch a task whose risk value is unknown", () => {
    const issue = taskToIssue({ ...base, risk: "weird" }, { specDir: "s", issueNumbersById: {} });
    expect(issue.labels).toEqual(["risk:weird"]);
  });
});
