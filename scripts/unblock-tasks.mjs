// Moves issues labeled waiting-on-deps (and risk:low or risk:medium) to
// ready-for-agent once every issue in their "- Depends on #N" lines is closed
// as completed, and comments so a
// maintainer can add the `agent` label. Run by .github/workflows/unblock-tasks.yml
// when an issue closes; safe to run by hand.
//
//   node scripts/unblock-tasks.mjs [--dry-run]
//
// It never adds `agent`: labels added with GITHUB_TOKEN do not trigger other
// workflows, and dispatching stays a human decision.
// Issue bodies are untrusted: they are only parsed for numbers, never executed
// or passed to a shell (gh is called with an argument array, comments via a file).
//
// Needs the compiled package: pnpm build --filter @repo/factory
// FACTORY_DIST_DIR overrides where the compiled package is loaded from (tests).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const out = (line = "") => process.stdout.write(`${line}\n`);
const err = (line = "") => process.stderr.write(`${line}\n`);
const die = (message, code = 1) => {
  err(message);
  process.exit(code);
};

const USAGE = "Usage: node scripts/unblock-tasks.mjs [--dry-run]";
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  out(USAGE);
  process.exit(0);
}
const unknown = args.filter((a) => a !== "--dry-run");
if (unknown.length) die(`Unknown argument: ${unknown.join(" ")}\n${USAGE}`, 2);
const dryRun = args.includes("--dry-run");

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = process.env.FACTORY_DIST_DIR || join(repoRoot, "packages", "factory", "dist");
const specModule = join(distDir, "spec", "index.js");
if (!existsSync(specModule)) {
  die(`Compiled @repo/factory not found at ${specModule}.\nRun: pnpm build --filter @repo/factory`);
}
const { parseDependencyRefs, parseUnlinkedDependencies, WAITING_LABEL, READY_LABEL, AGENT_LABEL } =
  createRequire(import.meta.url)(specModule);

const gh = (ghArgs) =>
  execFileSync("gh", ghArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const ghError = (error) => String(error.stderr || error.message || error).trim();

let waiting;
try {
  const listed = gh([
    "issue",
    "list",
    "--label",
    WAITING_LABEL,
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "number,body,labels",
  ]);
  waiting = JSON.parse(listed);
} catch (error) {
  die(`gh issue list failed: ${ghError(error)}`);
}
if (!Array.isArray(waiting) || waiting.length === 0) {
  out(`No open issues labeled ${WAITING_LABEL}.`);
  process.exit(0);
}

// Each dependency is looked up once. It is done only when it is an issue (not
// a pull request) closed as COMPLETED; DUPLICATE, NOT_PLANNED or no reason do not count.
const states = new Map();
const stateOf = (number) => {
  if (!states.has(number)) {
    let state = { done: false, note: "unknown" };
    try {
      const view = JSON.parse(
        gh(["issue", "view", String(number), "--json", "state,stateReason,url"]),
      );
      const isIssue = typeof view.url === "string" && view.url.includes("/issues/");
      if (!isIssue) state = { done: false, note: "unknown" };
      else if (view.state === "OPEN") state = { done: false, note: null };
      else if (view.state === "CLOSED" && view.stateReason === "COMPLETED") {
        state = { done: true, note: null };
      } else if (view.state === "CLOSED") {
        state = {
          done: false,
          note: view.stateReason
            ? `closed as ${String(view.stateReason).toLowerCase()}`
            : "closed without a reason",
        };
      }
    } catch (error) {
      err(`Could not read #${number}: ${ghError(error)}`);
    }
    states.set(number, state);
  }
  return states.get(number);
};

const DISPATCHABLE_RISKS = ["risk:low", "risk:medium"];

let readyLabelChecked = false;
const ensureReadyLabel = () => {
  if (readyLabelChecked) return;
  readyLabelChecked = true;
  const names = JSON.parse(gh(["label", "list", "--limit", "500", "--json", "name"])).map(
    (label) => label.name,
  );
  if (!names.includes(READY_LABEL)) {
    gh([
      "label",
      "create",
      READY_LABEL,
      "--color",
      "0075ca",
      "--description",
      `Dependencies closed: add ${AGENT_LABEL} to start`,
    ]);
  }
};

const refList = (refs) => refs.map((n) => `#${n}`).join(", ");
const tmp = mkdtempSync(join(tmpdir(), "unblock-tasks-"));
let unblocked = 0;
let failures = 0;

for (const issue of waiting) {
  const number = Number(issue.number);
  if (!Number.isSafeInteger(number)) continue;
  const body = typeof issue.body === "string" ? issue.body : "";
  const labels = Array.isArray(issue.labels) ? issue.labels.map((label) => label?.name) : [];
  if (labels.includes("risk:high") || !labels.some((name) => DISPATCHABLE_RISKS.includes(name))) {
    out(`#${number}: skipped, not labeled risk:low or risk:medium`);
    continue;
  }

  const unlinked = parseUnlinkedDependencies(body);
  if (unlinked.length) {
    out(`#${number}: waiting on ${unlinked.join(", ")} (no issue yet)`);
    continue;
  }
  const refs = parseDependencyRefs(body).filter((ref) => ref !== number);
  if (refs.length === 0) {
    out(`#${number}: no Depends on #N lines, left for a human`);
    continue;
  }
  const blocking = refs.filter((ref) => !stateOf(ref).done);
  if (blocking.length) {
    const describe = (ref) => {
      const { note } = stateOf(ref);
      return note ? `#${ref} (${note})` : `#${ref}`;
    };
    out(`#${number}: waiting on ${blocking.map(describe).join(", ")}`);
    continue;
  }

  const what = refs.length === 1 ? `dependency ${refList(refs)}` : `dependencies ${refList(refs)}`;
  if (dryRun) {
    out(`#${number}: ${READY_LABEL} (${what} closed) [dry run]`);
    unblocked++;
    continue;
  }
  const comment =
    (refs.length === 1
      ? `Dependency ${refList(refs)} is closed.`
      : `Dependencies ${refList(refs)} are closed.`) +
    ` Add the \`${AGENT_LABEL}\` label to start the agent.\n`;
  try {
    ensureReadyLabel();
  } catch (error) {
    err(`#${number}: could not check or create the ${READY_LABEL} label: ${ghError(error)}`);
    failures++;
    continue;
  }
  try {
    gh([
      "issue",
      "edit",
      String(number),
      "--remove-label",
      WAITING_LABEL,
      "--add-label",
      READY_LABEL,
    ]);
  } catch (error) {
    err(`#${number}: gh issue edit failed: ${ghError(error)}`);
    failures++;
    continue;
  }
  try {
    const file = join(tmp, `${number}.md`);
    writeFileSync(file, comment);
    gh(["issue", "comment", String(number), "--body-file", file]);
  } catch (error) {
    err(`#${number}: relabeled, but gh issue comment failed: ${ghError(error)}`);
    failures++;
  }
  out(`#${number}: ${READY_LABEL} (${what} closed)`);
  unblocked++;
}
rmSync(tmp, { recursive: true, force: true });

out(`Unblocked ${unblocked} of ${waiting.length} waiting issues.${dryRun ? " (dry run)" : ""}`);
if (failures) process.exit(1);
