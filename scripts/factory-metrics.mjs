// How agent PRs (claude/*, agent/*) perform: merge rate, rework rate, time to
// merge and to first review, split by risk:* label.
//
//   node scripts/factory-metrics.mjs [--days 30]              # runs gh pr list
//   node scripts/factory-metrics.mjs --input prs.json         # gh pr list --json output saved earlier
//     [--issues issues.json]                                  # gh issue list --json number,labels output
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
  "Usage: node scripts/factory-metrics.mjs [--input prs.json [--issues issues.json]] [--days N] [--now ISO] [--json]";
const PR_LIMIT = 200;
const ISSUE_LIMIT = 500;
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  out(USAGE);
  process.exit(0);
}

const options = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--json") options.json = true;
  else if (["--input", "--issues", "--days", "--now"].includes(arg)) {
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

const warn = (message) => process.stderr.write(`Warning: ${message}\n`);
const ghJson = (ghArgs) =>
  execFileSync("gh", ghArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
const readJsonFile = (file) => {
  if (!existsSync(file)) die(`Input file not found: ${file}`);
  return readFileSync(file, "utf8");
};

let raw;
let rawIssues = null;
if (options.input) {
  raw = readJsonFile(options.input);
  if (options.issues) rawIssues = readJsonFile(options.issues);
} else {
  // A date-only search keeps gh's 200-PR limit for the window; the exact
  // cutoff is applied again by computeFactoryMetrics.
  const search =
    days === undefined
      ? []
      : [
          "--search",
          `created:>=${new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10)}`,
        ];
  try {
    raw = ghJson([
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      String(PR_LIMIT),
      ...search,
      "--json",
      GH_PR_FIELDS.join(","),
    ]);
  } catch (error) {
    die(`gh pr list failed: ${String(error.stderr || error.message).trim()}`);
  }
  // Risk labels live on the issues the agent PRs come from.
  try {
    rawIssues = ghJson([
      "issue",
      "list",
      "--state",
      "all",
      "--limit",
      String(ISSUE_LIMIT),
      "--json",
      "number,labels",
    ]);
  } catch (error) {
    die(`gh issue list failed: ${String(error.stderr || error.message).trim()}`);
  }
}

let prs;
try {
  prs = JSON.parse(raw);
} catch (error) {
  die(`Input is not valid JSON: ${error.message}`);
}
if (!Array.isArray(prs)) die("Input must be a JSON array of pull requests (gh pr list --json)");
if (!options.input && prs.length === PR_LIMIT) {
  warn(
    `gh returned exactly ${PR_LIMIT} PRs (the --limit); older PRs may be missing. Use a smaller --days.`,
  );
}

const issueLabels = {};
if (rawIssues !== null) {
  let issues;
  try {
    issues = JSON.parse(rawIssues);
  } catch (error) {
    die(`Issues input is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(issues))
    die("Issues input must be a JSON array (gh issue list --json number,labels)");
  if (!options.input && issues.length === ISSUE_LIMIT) {
    warn(
      `gh returned exactly ${ISSUE_LIMIT} issues; risk of older PRs may fall back to PR labels.`,
    );
  }
  for (const issue of issues) {
    if (Number.isSafeInteger(issue?.number) && Array.isArray(issue.labels)) {
      issueLabels[issue.number] = issue.labels.map((label) => label?.name).filter(Boolean);
    }
  }
}

const metrics = computeFactoryMetrics(prs, now, {
  ...(days === undefined ? {} : { sinceDays: days }),
  issueLabels,
});

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
