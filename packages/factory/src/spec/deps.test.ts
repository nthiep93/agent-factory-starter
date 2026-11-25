import { describe, expect, it } from "vitest";
import { parseDependencyRefs, parseUnlinkedDependencies, taskToIssue, type Task } from "./index";

const task: Task = {
  id: "T3",
  title: "Web drift",
  goal: "g",
  area: "web",
  risk: "low",
  depends: ["T1", "T2"],
  inScope: null,
  outOfScope: null,
  acceptance: ["a"],
  line: 1,
};

describe("parseDependencyRefs", () => {
  it("round-trips the Depends on lines taskToIssue writes", () => {
    const { body } = taskToIssue(task, {
      specDir: "specs/001",
      issueNumbersById: { T1: 7, T2: 12 },
    });
    expect(parseDependencyRefs(body)).toEqual([7, 12]);
    expect(parseUnlinkedDependencies(body)).toEqual([]);
  });

  it("reports dependencies that have no issue yet", () => {
    const { body } = taskToIssue(task, { specDir: "specs/001", issueNumbersById: { T1: 7 } });
    expect(parseDependencyRefs(body)).toEqual([7]);
    expect(parseUnlinkedDependencies(body)).toEqual(["T2"]);
  });

  it("returns nothing for empty or unrelated bodies", () => {
    expect(parseDependencyRefs("")).toEqual([]);
    expect(parseDependencyRefs("See #4 and depends on #5 in prose.")).toEqual([]);
    expect(parseUnlinkedDependencies("")).toEqual([]);
  });

  it("accepts CRLF, * bullets and manual lines, dedupes and keeps first-seen order", () => {
    const body =
      "- Depends on #9\r\n* Depends on #3 (T1)\r\n- Depends on #9 (T2)\n- depends on #4\n";
    expect(parseDependencyRefs(body)).toEqual([9, 3, 4]);
  });

  it("ignores references that are not at the start of a bullet line", () => {
    const body = "text - Depends on #1\n  - Depends on #2\n- Depends on #x\n- Depends on #0\n";
    expect(parseDependencyRefs(body)).toEqual([]);
  });
});
