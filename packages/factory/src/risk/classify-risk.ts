// Risk classification for a pull request, from the file list GitHub returns
// for GET /repos/{owner}/{repo}/pulls/{n}/files. Pure: no I/O, no clock.
//
// The level decides how much human attention a PR needs (see docs/gates.md).
// Rules are deliberately path based and conservative: anything the rules do
// not recognise is at least medium, and only docs/tests can be low.

export type RiskLevel = "low" | "medium" | "high";

/** One entry of GitHub's "list pull request files" response (fields we use). */
export interface PullRequestFile {
  filename: string;
  /** added | removed | modified | renamed | copied | changed | unchanged */
  status: string;
  additions: number;
  deletions: number;
  /** Set by GitHub when status is "renamed". */
  previous_filename?: string;
}

export interface RiskResult {
  level: RiskLevel;
  /** "<level>: <why>", highest level first. */
  reasons: string[];
}

export const RISK_LIMITS = {
  /** More changed lines than this is high risk, whatever the files. */
  highLines: 800,
  /** A docs/tests-only PR stays low only up to this many changed lines. */
  lowLines: 300,
  /** File names listed per reason before "(+N more)". */
  filesPerReason: 5,
} as const;

/** Paths that define the factory's guardrails (CI, agent config, holdout, ownership). */
const GUARDRAIL_PREFIXES = [".github/", ".claude/", "holdout/"];
const GUARDRAIL_ROOT_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);

/** Files that define what `pnpm verify` checks; editing them can switch a gate off. */
const GATE_ROOT_FILES = new Set(["package.json", "pnpm-workspace.yaml", "turbo.json"]);
const GATE_FILE = /^(eslint\.config|vitest\.config|vitest\.workspace)\.[cm]?[jt]s$/;

/** Whole words in a path (segments split on / . - _ and camelCase). */
const SENSITIVE_WORD = /^(auth|oauth|security|secrets?|payments?|billing|crypto)$/;

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const DOC_FILE = /\.mdx?$/;
const DOC_DIRS = ["docs/", "specs/"];

const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export function classifyRisk(files: readonly PullRequestFile[]): RiskResult {
  if (files.length === 0) {
    return {
      level: "medium",
      reasons: ["medium: no changed files reported; cannot prove the PR is low risk"],
    };
  }

  const found: Array<{ level: RiskLevel; text: string }> = [];
  const flag = (level: RiskLevel, why: string, paths: string[]) => {
    if (paths.length > 0) found.push({ level, text: `${why}: ${listPaths(paths)}` });
  };

  // A rename touches both paths: moving a file out of holdout/ is a holdout change.
  const touched = unique(files.flatMap((f) => paths(f)));
  const totalLines = files.reduce((sum, f) => sum + lines(f.additions) + lines(f.deletions), 0);

  flag(
    "high",
    "guardrail path changed (CI, agent config, holdout, ownership)",
    touched.filter(isGuardrail),
  );
  flag("high", "verification gate config changed", touched.filter(isGateConfig));
  flag("high", "possible secret file", touched.filter(isEnvFile));
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
  if (totalLines > RISK_LIMITS.highLines) {
    found.push({ level: "high", text: `${totalLines} changed lines (> ${RISK_LIMITS.highLines})` });
  }

  const current = files.map((f) => normalise(f.filename));
  flag("medium", "dependencies changed", current.filter(isDependencyFile));
  flag(
    "medium",
    "shared contract changed (packages/shared)",
    current.filter((p) => p.startsWith("packages/shared/") && !isDocOrTest(p)),
  );
  flag(
    "medium",
    "app or package source changed",
    current.filter((p) => isSource(p) && !p.startsWith("packages/shared/")),
  );
  flag(
    "medium",
    "not docs or tests",
    current.filter(
      (p) => !isDocOrTest(p) && !isSource(p) && !isDependencyFile(p) && !isClassifiedHigh(p),
    ),
  );

  const docsAndTestsOnly = current.every(isDocOrTest);
  if (
    docsAndTestsOnly &&
    totalLines > RISK_LIMITS.lowLines &&
    totalLines <= RISK_LIMITS.highLines
  ) {
    found.push({
      level: "medium",
      text: `docs/tests only but ${totalLines} changed lines (> ${RISK_LIMITS.lowLines})`,
    });
  }

  if (found.length === 0) {
    return {
      level: "low",
      reasons: [
        `low: all ${files.length} file(s) are docs or tests, ${totalLines} changed lines (<= ${RISK_LIMITS.lowLines})`,
      ],
    };
  }

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

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function lines(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function listPaths(list: string[]): string {
  const max = RISK_LIMITS.filesPerReason;
  const shown = list.slice(0, max).join(", ");
  return list.length > max ? `${shown} (+${list.length - max} more)` : shown;
}

function isGuardrail(path: string): boolean {
  return (
    GUARDRAIL_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    GUARDRAIL_ROOT_FILES.has(path) ||
    basename(path) === "CODEOWNERS"
  );
}

function isGateConfig(path: string): boolean {
  return GATE_ROOT_FILES.has(path) || GATE_FILE.test(basename(path));
}

function isEnvFile(path: string): boolean {
  const name = basename(path);
  return (name === ".env" || name.startsWith(".env.")) && name !== ".env.example";
}

function isSensitive(path: string): boolean {
  return path
    .split(/[/._-]+/)
    .flatMap((segment) => segment.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .some((word) => SENSITIVE_WORD.test(word.toLowerCase()));
}

function isTest(path: string): boolean {
  return TEST_FILE.test(path);
}

function isDocOrTest(path: string): boolean {
  return isTest(path) || DOC_FILE.test(path) || DOC_DIRS.some((dir) => path.startsWith(dir));
}

function isDependencyFile(path: string): boolean {
  const name = basename(path);
  return name === "package.json" || name === "pnpm-lock.yaml";
}

function isSource(path: string): boolean {
  return (
    (path.startsWith("apps/") || path.startsWith("packages/")) &&
    !isDocOrTest(path) &&
    !isDependencyFile(path)
  );
}

/** Already explained by a high reason, so it needs no "not docs or tests" reason too. */
function isClassifiedHigh(path: string): boolean {
  return isGuardrail(path) || isGateConfig(path) || isEnvFile(path) || isSensitive(path);
}

/** A removed test, or a test renamed to a non-test name, weakens the suite. */
function deletesTest(file: PullRequestFile): boolean {
  if (file.status === "removed") return isTest(normalise(file.filename));
  if (file.status === "renamed" && file.previous_filename) {
    return isTest(normalise(file.previous_filename)) && !isTest(normalise(file.filename));
  }
  return false;
}
