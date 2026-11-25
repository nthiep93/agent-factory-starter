import { posix } from "node:path";

const PROTECTED_DIRS = [".github/", ".claude/", "holdout/"];
const PROTECTED_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);

/**
 * Changed paths the agent must never ship: CI, agent guardrails, holdout
 * scenarios, and agent instructions (AGENTS.md / CLAUDE.md at any depth).
 */
export function protectedPaths(files: readonly string[]): string[] {
  return files.filter(
    (file) =>
      PROTECTED_DIRS.some((dir) => file.startsWith(dir)) ||
      PROTECTED_FILES.has(posix.basename(file)),
  );
}

/** Files, at any depth, that change how dependencies install or how checks run. */
const VERIFY_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".pnpmfile.cjs",
  "pnpmfile.cjs",
  "turbo.json",
  ".npmrc",
  ".swcrc",
  ".prettierignore",
  ".gitattributes",
]);
const VERIFY_PREFIXES = [
  "eslint.config.",
  "vitest.config.",
  "vitest.workspace.",
  "next.config.",
  ".prettierrc",
];

/**
 * Changed paths that define what `pnpm verify` installs and checks. A branch
 * that touches them could make the orchestrator's independent verify pass
 * trivially (or run code at install time), so it is never pushed
 * automatically. This includes lockfile-only changes: --frozen-lockfile does
 * not validate integrity hashes or tarball URLs against package.json.
 * Tasks that need dependency changes go to a human.
 */
export function verifyConfigPaths(files: readonly string[]): string[] {
  return files.filter((file) => {
    const parts = file.split("/");
    const base = parts.at(-1) ?? "";
    return (
      VERIFY_FILES.has(base) ||
      VERIFY_PREFIXES.some((prefix) => base.startsWith(prefix)) ||
      /^tsconfig.*\.json$/.test(base) ||
      parts.slice(0, -1).includes("scripts")
    );
  });
}
