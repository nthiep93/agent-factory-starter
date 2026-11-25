import { describe, expect, it } from "vitest";
import { parseTasks } from "./index";

const VALID = `# Tasks: time endpoint

Free text before the first task is ignored.

## T1: Add buildTime to shared
goal: Give both apps one definition of the time payload.
area: shared
risk: low
depends: none
in-scope: packages/shared/src/time.ts
out-of-scope: apps/api, apps/web
Acceptance:
- buildTime(new Date(0)) returns { iso: "1970-01-01T00:00:00.000Z", epochMs: 0 }
- TimeResponse is exported
  from the package index

## T2: Expose GET /time
goal: Serve the time payload.
area: api
risk: medium
depends: T1
Acceptance:
* GET /time returns 200 with { iso, epochMs }
`;

describe("parseTasks", () => {
  it("parses tasks with all fields and no errors", () => {
    const { tasks, errors } = parseTasks(VALID);
    expect(errors).toEqual([]);
    expect(tasks).toEqual([
      {
        id: "T1",
        title: "Add buildTime to shared",
        goal: "Give both apps one definition of the time payload.",
        area: "shared",
        risk: "low",
        depends: [],
        inScope: "packages/shared/src/time.ts",
        outOfScope: "apps/api, apps/web",
        acceptance: [
          'buildTime(new Date(0)) returns { iso: "1970-01-01T00:00:00.000Z", epochMs: 0 }',
          "TimeResponse is exported from the package index",
        ],
        line: 5,
      },
      {
        id: "T2",
        title: "Expose GET /time",
        goal: "Serve the time payload.",
        area: "api",
        risk: "medium",
        depends: ["T1"],
        inScope: null,
        outOfScope: null,
        acceptance: ["GET /time returns 200 with { iso, epochMs }"],
        line: 17,
      },
    ]);
  });

  it("accepts CRLF line endings, case-insensitive keys and spaced dependency lists", () => {
    const md = [
      "## T3: Web drift",
      "Goal: Show drift.",
      "AREA: web",
      "Risk: low",
      "Depends: T1 , T2,T4",
      "Acceptance:",
      "- shows drift",
    ].join("\r\n");
    const { tasks, errors } = parseTasks(md);
    expect(errors).toEqual([]);
    expect(tasks[0]?.depends).toEqual(["T1", "T2", "T4"]);
    expect(tasks[0]?.area).toBe("web");
  });

  it("tolerates the blank lines prettier inserts after headings and Acceptance:", () => {
    const md =
      "## T1: X\n\ngoal: g\narea: api\nrisk: low\ndepends: none\nAcceptance:\n\n- a\n\n- b\n";
    const { tasks, errors } = parseTasks(md);
    expect(errors).toEqual([]);
    expect(tasks[0]?.acceptance).toEqual(["a", "b"]);
  });

  it("keeps unknown area and risk values for the validator", () => {
    const md = "## T1: X\ngoal: g\narea: mobile\nrisk: extreme\ndepends: none\nAcceptance:\n- a\n";
    const { tasks, errors } = parseTasks(md);
    expect(errors).toEqual([]);
    expect(tasks[0]).toMatchObject({ area: "mobile", risk: "extreme" });
  });

  it("returns an empty acceptance list when the Acceptance block is missing or empty", () => {
    const md =
      "## T1: X\ngoal: g\narea: api\nrisk: low\ndepends: none\nAcceptance:\n\n## T2: Y\ngoal: g\narea: api\nrisk: low\ndepends: none\n";
    const { tasks, errors } = parseTasks(md);
    expect(errors).toEqual([]);
    expect(tasks.map((t) => t.acceptance)).toEqual([[], []]);
  });

  it("returns no tasks and no errors for empty input", () => {
    expect(parseTasks("")).toEqual({ tasks: [], errors: [] });
    expect(parseTasks("# Only a title\n\nSome prose.\n")).toEqual({ tasks: [], errors: [] });
  });

  it("reports a malformed task heading and skips that task", () => {
    const md =
      "## Add thing\ngoal: g\n\n## T2: Fine\ngoal: g\narea: api\nrisk: low\ndepends: none\nAcceptance:\n- ok\n";
    const { tasks, errors } = parseTasks(md);
    expect(tasks.map((t) => t.id)).toEqual(["T2"]);
    expect(errors).toEqual([
      {
        line: 1,
        message: 'Task heading must look like "## T1: Title", got "## Add thing"',
      },
    ]);
  });

  it("reports missing required keys on the heading line", () => {
    const { tasks, errors } = parseTasks("## T1: X\narea: api\nAcceptance:\n- a\n");
    expect(tasks).toEqual([]);
    expect(errors).toEqual([
      { line: 1, message: "T1 is missing required keys: goal, risk, depends" },
    ]);
  });

  it("reports unknown keys, duplicate keys, stray text and empty values with line numbers", () => {
    const md = [
      "## T1: X", // 1
      "goal: g", // 2
      "area: api", // 3
      "area: web", // 4
      "owner: me", // 5
      "risk:", // 6
      "risk: low", // 7
      "depends: none", // 8
      "this line is prose", // 9
      "Acceptance:", // 10
      "- a", // 11
      "  continuation", // 12
      "not a bullet", // 13
    ].join("\n");
    const { tasks, errors } = parseTasks(md);
    expect(errors).toEqual([
      { line: 4, message: 'Duplicate key "area" in T1' },
      {
        line: 5,
        message:
          'Unknown key "owner" in T1 (allowed: goal, area, risk, depends, in-scope, out-of-scope, Acceptance)',
      },
      { line: 6, message: 'Key "risk" in T1 has an empty value' },
      {
        line: 9,
        message:
          'Expected "key: value", an "Acceptance:" bullet or a blank line in T1, got "this line is prose"',
      },
      {
        line: 13,
        message:
          'Expected "key: value", an "Acceptance:" bullet or a blank line in T1, got "not a bullet"',
      },
    ]);
    // A task with line-level errors is still returned so the validator can run.
    expect(tasks[0]).toMatchObject({ area: "api", risk: "low", acceptance: ["a continuation"] });
  });

  it("rejects bullets outside an Acceptance block and a non-empty Acceptance value", () => {
    const md =
      "## T1: X\n- early bullet\ngoal: g\narea: api\nrisk: low\ndepends: none\nAcceptance: inline\n";
    const { errors } = parseTasks(md);
    expect(errors).toEqual([
      { line: 2, message: 'Bullet outside an "Acceptance:" block in T1' },
      {
        line: 7,
        message: '"Acceptance:" takes no value in T1; list criteria as "- " bullets below it',
      },
    ]);
  });

  it("rejects malformed dependency ids and an empty dependency list", () => {
    const md = "## T1: X\ngoal: g\narea: api\nrisk: low\ndepends: T2, , foo\nAcceptance:\n- a\n";
    const { errors } = parseTasks(md);
    expect(errors).toEqual([
      { line: 5, message: 'Invalid dependency "" in T1: use task ids like T2, or "none"' },
      { line: 5, message: 'Invalid dependency "foo" in T1: use task ids like T2, or "none"' },
    ]);
  });

  it("never throws on hostile input", () => {
    const inputs = [
      "##",
      "## T1:",
      "## T1: \n",
      "Acceptance:\n- x",
      "\u0000\n## T9: x\n:::",
      "## T1: a\n: value",
    ];
    for (const input of inputs) {
      expect(() => parseTasks(input)).not.toThrow();
    }
    expect(parseTasks("## T1:").errors[0]?.line).toBe(1);
  });
});
