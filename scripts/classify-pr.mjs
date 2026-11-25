// Classifies a pull request's risk from its changed-file list.
//
//   node scripts/classify-pr.mjs files.json [--expected-count N] [--mode-change]
//   gh api --paginate --slurp repos/OWNER/REPO/pulls/N/files | node scripts/classify-pr.mjs
//
// --expected-count N  the PR's changed_files; a list of another length is high
// --mode-change       the diff adds a symlink or changes a file mode: high
//
// Input: the JSON array GitHub's "list pull request files" endpoint returns,
// or an array of such pages (gh --paginate --slurp). Output: the level
// (low | medium | high) on the first line, then one reason per line. Exit 0
// on success, 1 on unreadable input, 2 when @repo/factory is not built.
//
// Needs the compiled package: pnpm build --filter @repo/factory
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = (line) => process.stdout.write(`${line}\n`);
const fail = (code, message) => {
  process.stderr.write(`classify-pr: ${message}\n`);
  process.exit(code);
};

const distEntry = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/factory/dist/risk/index.js",
);
if (!existsSync(distEntry)) {
  fail(2, `${distEntry} not found. Run: pnpm build --filter @repo/factory`);
}
const { classifyRisk } = createRequire(import.meta.url)(distEntry);

let source;
const context = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--mode-change") context.modeOrSymlinkChange = true;
  else if (arg === "--expected-count") {
    const n = Number(args[++i]);
    if (!Number.isInteger(n) || n < 0) fail(1, "--expected-count needs a non-negative integer");
    context.expectedFileCount = n;
  } else if (arg.startsWith("--")) fail(1, `unknown option ${arg}`);
  else source = arg;
}
let raw;
try {
  raw = source && source !== "-" ? readFileSync(source, "utf8") : readFileSync(0, "utf8");
} catch (error) {
  fail(1, `cannot read ${source ?? "stdin"}: ${error.message}`);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  fail(1, `input is not JSON: ${error.message}`);
}
if (!Array.isArray(parsed)) fail(1, "input must be a JSON array of files");

// gh --paginate --slurp wraps each page in its own array.
const files = parsed.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]));
const invalid = files.find(
  (f) => typeof f !== "object" || f === null || typeof f.filename !== "string",
);
if (invalid !== undefined) fail(1, `not a PR file entry: ${JSON.stringify(invalid)}`);

const { level, reasons } = classifyRisk(
  files.map((f) => ({
    filename: f.filename,
    status: String(f.status ?? "modified"),
    additions: Number(f.additions ?? 0),
    deletions: Number(f.deletions ?? 0),
    ...(typeof f.previous_filename === "string" ? { previous_filename: f.previous_filename } : {}),
  })),
  context,
);

// File names are attacker-controlled. The classifier JSON-quotes them; also
// drop every control and line-separator character so no output line can
// start a GitHub Actions workflow command (::set-output::, ::error:: ...).
// eslint-disable-next-line no-control-regex
const safe = (line) => line.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");

out(level);
for (const reason of reasons) out(safe(reason));
