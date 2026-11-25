// How agent PRs (claude/*, agent/*) perform: merge rate, rework rate, time to
// merge and to first review, split by risk:* label.
//
//   node scripts/factory-metrics.mjs [--days 30]              # runs gh pr list
//   node scripts/factory-metrics.mjs --input prs.json         # gh pr list --json output saved earlier
//   options: --json (print the raw metrics), --now <ISO time> (reproducible --days window)
//
// Needs the compiled package: pnpm build --filter @repo/factory
// FACTORY_DIST_DIR overrides where the compiled package is loaded from (tests).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = (line = "") => process.stdout.write(`${line}\n`);
const die = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

const USAGE =
  "Usage: node scripts/factory-metrics.mjs [--input file.json] [--days N] [--now ISO] [--json]";
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  out(USAGE);
  process.exit(0);
}

const options = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--json") options.json = true;
  else if (arg === "--input" || arg === "--days" || arg === "--now") {
    const value = args[++i];
    if (value === undefined) die(`${arg} needs a value\n${USAGE}`, 2);
    options[arg.slice(2)] = value;
  } else die(`Unknown argument: ${arg}\n${USAGE}`, 2);
}

const days = options.days === undefined ? undefined : Number(options.days);
if (days !== undefined && !(Number.isFinite(days) && days > 0)) {
  die(`--days must be a positive number, got "${options.days}"`, 2);
}
const now = options.now === undefined ? new Date() : new Date(options.now);
if (Number.isNaN(now.getTime())) die(`--now must be an ISO date, got "${options.now}"`, 2);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = process.env.FACTORY_DIST_DIR || join(repoRoot, "packages", "factory", "dist");
const metricsModule = join(distDir, "metrics", "index.js");
if (!existsSync(metricsModule)) {
  die(
    `Compiled @repo/factory not found at ${metricsModule}.\nRun: pnpm build --filter @repo/factory`,
  );
}
const { computeFactoryMetrics, GH_PR_FIELDS, RISK_BUCKETS } = createRequire(import.meta.url)(
  metricsModule,
);

let raw;
if (options.input) {
  if (!existsSync(options.input)) die(`Input file not found: ${options.input}`);
  raw = readFileSync(options.input, "utf8");
} else {
  try {
    raw = execFileSync(
      "gh",
      ["pr", "list", "--state", "all", "--limit", "200", "--json", GH_PR_FIELDS.join(",")],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    die(`gh pr list failed: ${String(error.stderr || error.message).trim()}`);
  }
}

let prs;
try {
  prs = JSON.parse(raw);
} catch (error) {
  die(`Input is not valid JSON: ${error.message}`);
}
if (!Array.isArray(prs)) die("Input must be a JSON array of pull requests (gh pr list --json)");

const metrics = computeFactoryMetrics(prs, now, days === undefined ? {} : { sinceDays: days });

if (options.json) {
  out(JSON.stringify(metrics, null, 2));
  process.exit(0);
}

const pct = (rate) => (rate === null ? "n/a" : `${Math.round(rate * 100)}%`);
const duration = (ms) => {
  if (ms === null) return "n/a";
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
};

const scope = days === undefined ? "all fetched" : `last ${days} days`;
out(`Agent PRs (claude/*, agent/*), ${scope}: ${metrics.total}`);
out();
out(`  merged           ${String(metrics.merged).padStart(4)}`);
out(`  closed unmerged  ${String(metrics.closedUnmerged).padStart(4)}`);
out(`  open             ${String(metrics.open).padStart(4)}`);
out();
out(`Merge rate:     ${pct(metrics.mergeRate)} (merged / (merged + closed unmerged))`);
const reworkList = metrics.reworkedPrs.length
  ? `: ${metrics.reworkedPrs.map((n) => `#${n}`).join(", ")}`
  : "";
out(
  `Rework rate:    ${pct(metrics.reworkRate)} (${metrics.reworked} of ${metrics.merged} merged${reworkList})`,
);
out(
  `Time to merge:  median ${duration(metrics.timeToMerge.medianMs)}, ` +
    `p90 ${duration(metrics.timeToMerge.p90Ms)} (n=${metrics.timeToMerge.count})`,
);
out(
  `First review:   median ${duration(metrics.timeToFirstReview.medianMs)} ` +
    `(n=${metrics.timeToFirstReview.count})`,
);
out();
out("By risk      total  merged  closed  open  merge  rework");
for (const bucket of RISK_BUCKETS) {
  const row = metrics.byRisk[bucket];
  if (row.total === 0) continue;
  out(
    `  ${bucket.padEnd(10)}${String(row.total).padStart(6)}${String(row.merged).padStart(8)}` +
      `${String(row.closedUnmerged).padStart(8)}${String(row.open).padStart(6)}` +
      `${pct(row.mergeRate).padStart(7)}${pct(row.reworkRate).padStart(8)}`,
  );
}
if (metrics.total === 0) out("  (no agent PRs)");
