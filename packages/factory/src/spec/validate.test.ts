import { describe, expect, it } from "vitest";
import { orderTasks, validateTasks, type Task } from "./index";

let nextLine = 1;
const task = (id: string, depends: string[] = [], overrides: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  goal: "goal",
  area: "api",
  risk: "low",
  depends,
  inScope: null,
  outOfScope: null,
  acceptance: ["works"],
  line: nextLine++,
  ...overrides,
});

describe("validateTasks", () => {
  it("accepts a valid set", () => {
    expect(validateTasks([task("T1"), task("T2", ["T1"]), task("T3", ["T1", "T2"])])).toEqual([]);
  });

  it("accepts an empty set", () => {
    expect(validateTasks([])).toEqual([]);
  });

  it("reports duplicate ids on every repeat", () => {
    const errors = validateTasks([task("T1", [], { line: 1 }), task("T1", [], { line: 9 })]);
    expect(errors).toEqual([
      {
        code: "duplicate-id",
        taskId: "T1",
        line: 9,
        message: "Duplicate task id T1 (first defined on line 1)",
      },
    ]);
  });

  it("reports unknown dependencies", () => {
    const errors = validateTasks([task("T1", ["T7"], { line: 3 })]);
    expect(errors).toEqual([
      {
        code: "unknown-dependency",
        taskId: "T1",
        line: 3,
        message: "T1 depends on unknown task T7",
      },
    ]);
  });

  it("reports a self dependency as a cycle", () => {
    const errors = validateTasks([task("T1", ["T1"], { line: 2 })]);
    expect(errors).toEqual([
      {
        code: "dependency-cycle",
        taskId: "T1",
        line: 2,
        message: "Dependency cycle: T1 -> T1",
      },
    ]);
  });

  it("reports each longer cycle once", () => {
    const errors = validateTasks([
      task("T1", ["T3"], { line: 1 }),
      task("T2", ["T1"], { line: 5 }),
      task("T3", ["T2"], { line: 9 }),
      task("T4", ["T3"], { line: 13 }),
    ]);
    expect(errors).toEqual([
      {
        code: "dependency-cycle",
        taskId: "T1",
        line: 1,
        message: "Dependency cycle: T1 -> T3 -> T2 -> T1",
      },
    ]);
  });

  it("reports two independent cycles", () => {
    const errors = validateTasks([
      task("T1", ["T2"]),
      task("T2", ["T1"]),
      task("T3", ["T4"]),
      task("T4", ["T3"]),
    ]);
    expect(errors.map((e) => e.message)).toEqual([
      "Dependency cycle: T1 -> T2 -> T1",
      "Dependency cycle: T3 -> T4 -> T3",
    ]);
  });

  it("rejects @claude mentions, which would start the agent on issue creation", () => {
    const errors = validateTasks([
      task("T1", [], { title: "Ask @Claude to fix", line: 1 }),
      task("T2", [], { goal: "ping @CLAUDE", line: 2 }),
      task("T3", [], { inScope: "x @claude", line: 3 }),
      task("T4", [], { outOfScope: "@claude", line: 4 }),
      task("T5", [], { acceptance: ["ok", "then @claude reviews"], line: 5 }),
      task("T6", [], { goal: "mail claude@example.com is fine? no: claude", line: 6 }),
    ]);
    expect(errors.map((e) => [e.code, e.taskId, e.line])).toEqual([
      ["agent-mention", "T1", 1],
      ["agent-mention", "T2", 2],
      ["agent-mention", "T3", 3],
      ["agent-mention", "T4", 4],
      ["agent-mention", "T5", 5],
    ]);
    expect(errors[0]?.message).toBe(
      'T1 mentions "@claude" in its title: GitHub would start the agent as soon as the issue is created. Remove the mention.',
    );
    expect(errors[4]?.message).toContain("in its acceptance criteria");
  });

  it("reports empty acceptance lists and unknown area or risk", () => {
    const errors = validateTasks([
      task("T1", [], { acceptance: [], area: "mobile", risk: "extreme", line: 4 }),
    ]);
    expect(errors).toEqual([
      {
        code: "empty-acceptance",
        taskId: "T1",
        line: 4,
        message: "T1 has no acceptance criteria",
      },
      {
        code: "unknown-area",
        taskId: "T1",
        line: 4,
        message: 'T1 has unknown area "mobile" (allowed: api, web, shared, docs, infra)',
      },
      {
        code: "unknown-risk",
        taskId: "T1",
        line: 4,
        message: 'T1 has unknown risk "extreme" (allowed: low, medium, high)',
      },
    ]);
  });
});

describe("orderTasks", () => {
  const ids = (tasks: Task[]) => tasks.map((t) => t.id);

  it("returns an empty list for no tasks", () => {
    expect(orderTasks([])).toEqual([]);
  });

  it("keeps file order when there are no dependencies", () => {
    expect(ids(orderTasks([task("T3"), task("T1"), task("T2")]))).toEqual(["T3", "T1", "T2"]);
  });

  it("puts dependencies first", () => {
    expect(ids(orderTasks([task("T1", ["T2"]), task("T2")]))).toEqual(["T2", "T1"]);
  });

  it("is stable: among ready tasks the earliest in the file wins", () => {
    const tasks = [
      task("T1"),
      task("T2", ["T4"]),
      task("T3", ["T1"]),
      task("T4"),
      task("T5", ["T2", "T3"]),
    ];
    expect(ids(orderTasks(tasks))).toEqual(["T1", "T3", "T4", "T2", "T5"]);
  });

  it("does not mutate its input", () => {
    const tasks = [task("T1", ["T2"]), task("T2")];
    orderTasks(tasks);
    expect(ids(tasks)).toEqual(["T1", "T2"]);
  });

  it("ignores unknown dependencies (validateTasks reports them)", () => {
    expect(ids(orderTasks([task("T1", ["T9"]), task("T2")]))).toEqual(["T1", "T2"]);
  });

  it("throws on a cycle so callers validate first", () => {
    expect(() => orderTasks([task("T1", ["T2"]), task("T2", ["T1"])])).toThrow(
      "Cannot order tasks: dependency cycle among T1, T2",
    );
  });
});
