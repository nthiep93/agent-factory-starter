// Risk classification for a pull request, from the file list GitHub returns
// for GET /repos/{owner}/{repo}/pulls/{n}/files. Pure: no I/O, no clock.
//
// The level decides how much human attention a PR needs (see docs/gates.md).
// Rules are deliberately path based and conservative: anything the rules do
// not recognise is at least medium, and only docs/tests can be low. Paths are
// compared lower-cased, so case tricks (".GITHUB/", "Package.JSON") do not help.

export type RiskLevel = "low" | "medium" | "high";

/** One entry of GitHub's "list pull request files" response (fields we use). */
export interface PullRequestFile {
  filename: string;
  /** added | removed | modified | renamed | copied | changed | unchanged */
  status: string;
  additions: number;
  deletions: number;
  /** Set by GitHub when status is "renamed" or "copied". */
  previous_filename?: string;
}

/** Facts about the PR that the file list alone cannot show. */
export interface RiskContext {
  /** `changed_files` from the PR itself; the file list must have exactly this many entries. */
  expectedFileCount?: number;
  /** The unified diff adds a symlink (mode 120000) or changes a file mode. */
  modeOrSymlinkChange?: boolean;
}

export interface RiskResult {
  level: RiskLevel;
  /** "<level>: <why>", highest level first. File names are JSON-quoted. */
  reasons: string[];
}

export const RISK_LIMITS = {
  /** More changed lines than this is high risk, whatever the files. */
  highLines: 800,
  /** A docs/tests-only PR stays low only up to this many changed lines. */
  lowLines: 300,
  /** GitHub's files endpoint returns at most this many files. */
  maxListedFiles: 3000,
  /** File names listed per reason before "(+N more)". */
  filesPerReason: 5,
} as const;

/** Paths that define the factory's guardrails (CI, agent config, holdout, ownership). */
const GUARDRAIL_PREFIXES = [".github/", ".claude/", "holdout/"];
/** Agent instructions, agent tool config and ownership, at any depth. */
const GUARDRAIL_NAMES = new Set([
  "codeowners",
  "agents.md",
  "claude.md",
  "claude.local.md",
  ".mcp.json",
]);

/** Files that define what `pnpm verify` and `pnpm format:check` check, at any depth. */
const GATE_NAMES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  ".prettierignore",
  ".npmrc",
]);
const GATE_PATTERNS = [
  /^tsconfig.*\.json$/,
  /^\.prettierrc/,
  /^prettier\.config\.[cm]?[jt]s$/,
  /^\.eslintrc/,
  /^eslint\.config\.[cm]?[jt]s$/,
  /^vitest\.(config|workspace)\.[cm]?[jt]s$/,
];

/** Whole words in a path (segments split on / . - _ and camelCase). */
const SENSITIVE_WORD = /^(auth|oauth|security|secrets?|payments?|billing|crypto)$/;

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const DOC_FILE = /\.mdx?$/;
const DOC_DIRS = ["docs/", "specs/"];

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

type Finding = { level: RiskLevel; text: string };

export function classifyRisk(
  files: readonly PullRequestFile[],
  context: RiskContext = {},
): RiskResult {
  const found: Finding[] = [];
  const note = (level: RiskLevel, text: string) => found.push({ level, text });
  const flag = (level: RiskLevel, why: string, list: string[]) => {
    if (list.length > 0) note(level, `${why}: ${listPaths(list)}`);
  };

  // Facts about the whole PR, checked before the file list is trusted.
  const expected = context.expectedFileCount;
  if (expected !== undefined && files.length !== expected) {
    note("high", `file list incomplete: got ${files.length} files, PR reports ${expected}`);
  }
  if (files.length >= RISK_LIMITS.maxListedFiles) {
    note("high", `${files.length} files (GitHub lists at most ${RISK_LIMITS.maxListedFiles})`);
  }
  if (context.modeOrSymlinkChange) {
    note("high", "diff adds a symlink or changes a file mode");
  }
  if (files.length === 0) {
    note("medium", "no changed files reported; cannot prove the PR is low risk");
    return result(found);
  }

  // A rename or copy touches both paths: moving a file out of holdout/ is a holdout change.
  const touched = unique(files.flatMap(paths));
  const current = files.map((f) => normalise(f.filename));
  const totalLines = files.reduce((sum, f) => sum + lines(f.additions) + lines(f.deletions), 0);
  const names = (list: PullRequestFile[]) => list.map((f) => f.filename);

  flag(
    "high",
    "guardrail path changed (CI, agent config, holdout, ownership)",
    touched.filter(isGuardrail),
  );
  flag(
    "high",
    "verification config changed (package.json, tsconfig, lint, format, test, turbo)",
    touched.filter(isGateConfig),
  );
  flag("high", "possible secret file", touched.filter(isEnvFile));
  flag("high", "control character in file name", touched.filter(hasControlChar));
  flag(
    "high",
    "sensitive area (auth/security/secret/payment/billing/crypto)",
    touched.filter(isSensitive),
  );
  flag(
    "high",
    "test file deleted",
    files.filter(deletesTest).map((f) => f.previous_filename ?? f.filename),
  );
  flag(
    "high",
    "file mode changed (status changed)",
    names(files.filter((f) => f.status === "changed")),
  );
  if (totalLines > RISK_LIMITS.highLines) {
    note("high", `${totalLines} changed lines (> ${RISK_LIMITS.highLines})`);
  }

  flag("medium", "lockfile changed", current.filter(isLockfile));
  flag(
    "medium",
    "shared contract changed (packages/shared)",
    current.filter((p) => isSource(p) && lower(p).startsWith("packages/shared/")),
  );
  flag(
    "medium",
    "app or package source changed",
    current.filter((p) => isSource(p) && !lower(p).startsWith("packages/shared/")),
  );
  flag(
    "medium",
    "not docs or tests",
    current.filter((p) => !isDocOrTest(p) && !isSource(p) && !isKnown(p)),
  );
  flag("medium", "lines removed from test file", names(files.filter(shrinksTest)));
  flag("medium", "file copied", names(files.filter((f) => f.status === "copied")));
  if (
    current.every(isDocOrTest) &&
    totalLines > RISK_LIMITS.lowLines &&
    totalLines <= RISK_LIMITS.highLines
  ) {
    note("medium", `docs/tests only but ${totalLines} changed lines (> ${RISK_LIMITS.lowLines})`);
  }

  if (found.length === 0) {
    note(
      "low",
      `all ${files.length} file(s) are docs or tests, ${totalLines} changed lines (<= ${RISK_LIMITS.lowLines})`,
    );
  }
  return result(found);
}

function result(found: Finding[]): RiskResult {
  const level = found.reduce<RiskLevel>(
    (max, r) => (RANK[r.level] > RANK[max] ? r.level : max),
    "low",
  );
  const reasons = [...found]
    .sort((a, b) => RANK[b.level] - RANK[a.level])
    .map((r) => `${r.level}: ${r.text}`);
  return { level, reasons };
}

function paths(file: PullRequestFile): string[] {
  const all = [normalise(file.filename)];
  if (file.previous_filename) all.push(normalise(file.previous_filename));
  return all;
}

function normalise(path: string): string {
  return path.replace(/^(\.\/)+/, "");
}

function lower(path: string): string {
  return path.toLowerCase();
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function lines(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** JSON-quoted, so a name with newlines or "::" cannot forge output lines. */
function listPaths(list: string[]): string {
  const max = RISK_LIMITS.filesPerReason;
  const shown = list
    .slice(0, max)
    .map((p) => JSON.stringify(p))
    .join(", ");
  return list.length > max ? `${shown} (+${list.length - max} more)` : shown;
}

function isGuardrail(path: string): boolean {
  const p = lower(path);
  return (
    GUARDRAIL_PREFIXES.some((prefix) => p.startsWith(prefix)) || GUARDRAIL_NAMES.has(basename(p))
  );
}

function isGateConfig(path: string): boolean {
  const name = basename(lower(path));
  return GATE_NAMES.has(name) || GATE_PATTERNS.some((re) => re.test(name));
}

function isEnvFile(path: string): boolean {
  const name = basename(lower(path));
  return (name === ".env" || name.startsWith(".env.")) && name !== ".env.example";
}

/** No legitimate file in this repo has one; they are used to forge log lines. */
function hasControlChar(path: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(path);
}

function isLockfile(path: string): boolean {
  return basename(lower(path)) === "pnpm-lock.yaml";
}

/** camelCase is split on the original spelling, then every word is lower-cased. */
function isSensitive(path: string): boolean {
  return path
    .split(/[/._-]+/)
    .flatMap((segment) => segment.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .some((word) => SENSITIVE_WORD.test(word.toLowerCase()));
}

function isTest(path: string): boolean {
  return TEST_FILE.test(lower(path));
}

function isDocOrTest(path: string): boolean {
  const p = lower(path);
  return isTest(p) || DOC_FILE.test(p) || DOC_DIRS.some((dir) => p.startsWith(dir));
}

function isSource(path: string): boolean {
  const p = lower(path);
  return (p.startsWith("apps/") || p.startsWith("packages/")) && !isDocOrTest(p) && !isKnown(path);
}

/** Already explained by a more specific reason. */
function isKnown(path: string): boolean {
  return (
    isGuardrail(path) ||
    isGateConfig(path) ||
    isEnvFile(path) ||
    isSensitive(path) ||
    hasControlChar(path) ||
    isLockfile(path)
  );
}

/** A removed test, or a test renamed to a non-test name, weakens the suite. */
function deletesTest(file: PullRequestFile): boolean {
  if (file.status === "removed") return isTest(file.filename);
  if (file.status === "renamed" && file.previous_filename) {
    return isTest(file.previous_filename) && !isTest(file.filename);
  }
  return false;
}

/** An edited test that loses lines may have lost assertions: never low. */
function shrinksTest(file: PullRequestFile): boolean {
  return file.status !== "removed" && isTest(file.filename) && lines(file.deletions) > 0;
}
