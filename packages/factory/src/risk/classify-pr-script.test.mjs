// End-to-end test of scripts/classify-pr.mjs against the compiled package.
// Plain .mjs so it can spawn Node without @types/node; tsc ignores it, Vitest runs it.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const pkgDir = fileURLToPath(new URL("../..", import.meta.url));
const script = fileURLToPath(new URL("../../../../scripts/classify-pr.mjs", import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const tsc = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));

const run = (args, input) =>
  spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8" });

describe("scripts/classify-pr.mjs", () => {
  // `test` runs before `build` in pnpm verify, so compile dist/ here.
  beforeAll(() => {
    execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: pkgDir });
  }, 60_000);

  it.each([
    ["low.json", "low"],
    ["medium.json", "medium"],
    ["high.json", "high"],
    ["empty.json", "medium"],
    ["paged.json", "high"],
  ])("%s -> %s", (name, level) => {
    const result = run([fixture(name)]);
    expect(result.status).toBe(0);
    const [first, ...reasons] = result.stdout.trim().split("\n");
    expect(first).toBe(level);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons[0]).toMatch(new RegExp(`^${level}: `));
    expect(reasons.every((r) => /^(low|medium|high): /.test(r))).toBe(true);
  });

  it("reads stdin when no path is given", () => {
    const result = run([], readFileSync(fixture("high.json"), "utf8"));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^high\n/);
    expect(result.stdout).toContain('test file deleted: "apps/web/lib/api.test.ts"');
  });

  it("cannot be tricked into printing workflow commands by a file name", () => {
    const evil = [
      {
        filename: "docs/a.md\n::set-output name=level::low",
        status: "modified",
        additions: 1,
        deletions: 0,
      },
      {
        filename: "apps/x.ts\r\n::error::boom\u2028::warning::x",
        status: "modified",
        additions: 1,
        deletions: 0,
      },
    ];
    const result = run([], JSON.stringify(evil));
    expect(result.status).toBe(0);
    const out = result.stdout.trim().split("\n");
    expect(out[0]).toBe("high");
    expect(result.stdout).toContain("control character in file name");
    // Every line is the level or a reason; no line starts a workflow command.
    expect(out.slice(1).every((line) => /^(low|medium|high): /.test(line))).toBe(true);
    expect(out.some((line) => line.startsWith("::"))).toBe(false);
    expect(result.stdout).not.toMatch(/[\r\u2028\u2029]/);
  });

  it("--expected-count makes a short file list high", () => {
    const result = run([fixture("low.json"), "--expected-count", "3"]);
    expect(result.stdout).toMatch(/^high\n/);
    expect(result.stdout).toContain("file list incomplete: got 2 files, PR reports 3");
    expect(run([fixture("low.json"), "--expected-count", "2"]).stdout).toMatch(/^low\n/);
  });

  it("--mode-change makes the PR high", () => {
    const result = run([fixture("low.json"), "--mode-change"]);
    expect(result.stdout).toMatch(/^high\n/);
    expect(result.stdout).toContain("symlink");
  });

  it("rejects a bad --expected-count", () => {
    expect(run([fixture("low.json"), "--expected-count", "x"]).status).toBe(1);
  });

  it("fails with exit 1 on input that is not a file list", () => {
    expect(run([], "not json").status).toBe(1);
    expect(run([], '{"filename":"a"}').status).toBe(1);
    expect(run([], "[1]").stderr).toContain("not a PR file entry");
  });
});
