// Turns specs/<NNN>-<slug>/tasks.md into ordered GitHub issues that mirror the
// Agent task form. Dry run by default; --create calls `gh issue create`.
//
//   node scripts/spec-to-issues.mjs specs/001-time-endpoint            # validate + preview
//   node scripts/spec-to-issues.mjs specs/001-time-endpoint --create   # open the issues
//
// Needs the compiled package: pnpm build --filter @repo/factory
// FACTORY_DIST_DIR overrides where the compiled package is loaded from (tests).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const out = (line = "") => process.stdout.write(`${line}\n`);
const err = (line = "") => process.stderr.write(`${line}\n`);
const die = (message, code = 1) => {
  err(message);
  process.exit(code);
};

const USAGE = "Usage: node scripts/spec-to-issues.mjs specs/<NNN>-<slug> [--create]";
const LABEL_STYLE = {
  agent: { color: "5319e7", description: "Ready for the Claude agent" },
  "risk:low": { color: "0e8a16", description: "Tests, docs, small isolated feature" },
  "risk:medium": { color: "fbca04", description: "Touches shared types or several apps" },
  "risk:high": { color: "d93f0b", description: "Auth, data, money, security: humans only" },
  "waiting-on-deps": {
    color: "c5def5",
    description: "Blocked until the issues it depends on are closed",
  },
  "ready-for-agent": { color: "0075ca", description: "Dependencies closed: add agent to start" },
};

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  out(USAGE);
  process.exit(0);
}
const unknown = args.filter((a) => a.startsWith("-") && a !== "--create");
if (unknown.length) die(`Unknown option: ${unknown.join(" ")}\n${USAGE}`, 2);
const positional = args.filter((a) => !a.startsWith("-"));
if (positional.length !== 1) die(USAGE, 2);
const create = args.includes("--create");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = process.env.FACTORY_DIST_DIR || join(repoRoot, "packages", "factory", "dist");
const specModule = join(distDir, "spec", "index.js");
if (!existsSync(specModule)) {
  die(`Compiled @repo/factory not found at ${specModule}.\nRun: pnpm build --filter @repo/factory`);
}
const { parseTasks, validateTasks, orderTasks, taskToIssue, WAITING_LABEL, READY_LABEL } =
  createRequire(import.meta.url)(specModule);

// Paths in issue bodies are relative to the repo root when the spec lives in it.
const specPath = resolve(positional[0]);
const fromRoot = relative(repoRoot, specPath);
const specDir = (
  fromRoot && !fromRoot.startsWith("..") && !isAbsolute(fromRoot) ? fromRoot : positional[0]
)
  .split(sep)
  .join("/");

const tasksFile = join(specPath, "tasks.md");
const problems = [];
for (const name of ["spec.md", "plan.md", "tasks.md"]) {
  if (!existsSync(join(specPath, name))) problems.push(`${specDir}/${name}: file is missing`);
}
if (!existsSync(tasksFile)) die(problems.join("\n"));

const { tasks, errors } = parseTasks(readFileSync(tasksFile, "utf8"));
const issues = [...errors, ...validateTasks(tasks)].sort((a, b) => a.line - b.line);
for (const issue of issues) problems.push(`${specDir}/tasks.md:${issue.line}: ${issue.message}`);
if (tasks.length === 0 && errors.length === 0) {
  problems.push(`${specDir}/tasks.md: no tasks found (expected "## T1: Title" headings)`);
}
if (problems.length) {
  die(`${problems.join("\n")}\n\n${problems.length} problem(s). Fix tasks.md and run again.`);
}

const ordered = orderTasks(tasks);

const gh = (ghArgs) =>
  execFileSync("gh", ghArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const printIssue = (index, task, issue, number) => {
  out(`=== ${index + 1}/${ordered.length}  ${task.id} -> #${number}  ${issue.title}`);
  out(`labels:  ${issue.labels.join(", ")}`);
  out(`depends: ${task.depends.length ? task.depends.join(", ") : "none"}`);
  out("---");
  out(issue.body.trimEnd());
  out();
};

// Simulates creation in order: each task's dependencies already have numbers
// by the time it is created. Placeholders #1..#N stand in for real numbers.
const plan = (() => {
  const numbers = {};
  return ordered.map((task, index) => {
    const issue = taskToIssue(task, { specDir, issueNumbersById: numbers });
    numbers[task.id] = index + 1;
    return issue;
  });
})();

if (!create) {
  out(`Spec: ${specDir} (${ordered.length} tasks, valid)`);
  out(`Dry run: nothing is created. #1..#${ordered.length} stand in for the issue numbers`);
  out("--create would get from GitHub, in this order.");
  out();
  ordered.forEach((task, index) => printIssue(index, task, plan[index], index + 1));
  out(`Order: ${ordered.map((t) => t.id).join(" -> ")}`);
  out("Run again with --create to open these issues with gh.");
  process.exit(0);
}

const ghFailure = (what, error) => {
  const detail = String(error.stderr || error.message || error).trim();
  return `${what} failed: ${detail}`;
};

// Labels must exist before `gh issue create --label` can use them.
// ready-for-agent too, so the unblock-tasks workflow can swap to it later.
const used = plan.flatMap((issue) => issue.labels);
if (used.includes(WAITING_LABEL)) used.push(READY_LABEL);
const wanted = [...new Set(used)].sort();
let existing;
try {
  const listed = JSON.parse(gh(["label", "list", "--limit", "500", "--json", "name"]));
  existing = new Set(listed.map((label) => label.name));
} catch (error) {
  die(ghFailure("gh label list", error));
}
for (const name of wanted) {
  if (existing.has(name)) continue;
  const style = LABEL_STYLE[name] ?? { color: "ededed", description: "" };
  try {
    gh(["label", "create", name, "--color", style.color, "--description", style.description]);
    out(`Created label ${name}`);
  } catch (error) {
    die(ghFailure(`gh label create ${name}`, error));
  }
}

const tmp = mkdtempSync(join(tmpdir(), "spec-to-issues-"));
const numbers = {};
const created = [];
let failure = null;
for (const [index, task] of ordered.entries()) {
  const issue = taskToIssue(task, { specDir, issueNumbersById: numbers });
  const bodyFile = join(tmp, `${task.id}.md`);
  writeFileSync(bodyFile, issue.body);
  const labelArgs = issue.labels.flatMap((label) => ["--label", label]);
  let stdout;
  try {
    stdout = gh(["issue", "create", "--title", issue.title, "--body-file", bodyFile, ...labelArgs]);
  } catch (error) {
    failure = ghFailure(`gh issue create for ${task.id}`, error);
    break;
  }
  const match = /\/issues\/(\d+)\s*$/.exec(stdout.trim());
  if (!match) {
    failure = `Could not read the issue number for ${task.id} from gh output: ${stdout.trim()}`;
    break;
  }
  numbers[task.id] = Number(match[1]);
  created.push(`${task.id}=#${match[1]}`);
  out(`${index + 1}/${ordered.length} ${task.id} -> #${match[1]} [${issue.labels.join(", ")}]`);
}
rmSync(tmp, { recursive: true, force: true });

if (failure) {
  const done = created.length ? `Already created: ${created.join(", ")}` : "Nothing was created.";
  die(`${failure}\n${done}`);
}
out(`Created ${created.length} issues: ${created.join(", ")}`);
