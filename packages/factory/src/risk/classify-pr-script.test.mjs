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
    expect(result.stdout).toContain("test file deleted: apps/web/lib/api.test.ts");
  });

  it("fails with exit 1 on input that is not a file list", () => {
    expect(run([], "not json").status).toBe(1);
    expect(run([], '{"filename":"a"}').status).toBe(1);
    expect(run([], "[1]").stderr).toContain("not a PR file entry");
  });
});
