// Summarises .agent-runs/runs.jsonl: the numbers that decide whether a task
// type is ready to run unattended.
//
//   node scripts/agent-stats.mjs [--days 14]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const out = (line = "") => process.stdout.write(`${line}\n`);

const daysArg = process.argv.indexOf("--days");
const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 14;
const since = Date.now() - days * 86_400_000;

const mainRoot = execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" })
  .split("\n")[0]
  .replace(/^worktree /, "");
const log = join(mainRoot, ".agent-runs", "runs.jsonl");

if (!existsSync(log)) {
  out('No runs recorded yet. Start one with: pnpm agent:run "<task>"');
  process.exit(0);
}

const runs = readFileSync(log, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((run) => Date.parse(run.startedAt) >= since);

const count = (pred) => runs.filter(pred).length;
const pct = (n, d) => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);
const sum = (key) =>
  runs.reduce((acc, run) => acc + (typeof run[key] === "number" ? run[key] : 0), 0);

const labeled = runs.filter((run) => run.label);
const success = count((run) => run.label === "success");
const verified = count((run) => run.verify === "pass");
const costed = runs.filter((run) => typeof run.costUsd === "number");

out(`Agent runs, last ${days} days: ${runs.length}`);
out();
for (const label of ["success", "flawed", "blocked", "manual"]) {
  out(`  ${label.padEnd(9)} ${String(count((run) => run.label === label)).padStart(4)}`);
}
out(`  ${"unlabeled".padEnd(9)} ${String(runs.length - labeled.length).padStart(4)}`);
out();
out(`Success rate (of labeled):   ${pct(success, labeled.length)}`);
out(`Independent verify passed:   ${pct(verified, runs.length)}`);
out(
  `Cost: total $${sum("costUsd").toFixed(2)}, ` +
    `avg $${costed.length ? (sum("costUsd") / costed.length).toFixed(2) : "n/a"} per run`,
);
out(`Avg duration: ${runs.length ? Math.round(sum("durationSec") / runs.length) : "n/a"}s`);

const flawed = runs.filter((run) => run.label === "flawed" && run.note);
if (flawed.length) {
  out();
  out("Flawed notes (fix the prompt, AGENTS.md or tests):");
  for (const run of flawed.slice(-5)) out(`  ${run.id}: ${run.note}`);
}
