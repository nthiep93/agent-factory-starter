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

const ROOT_VERIFY_FILES = new Set(["turbo.json", "pnpm-workspace.yaml", ".npmrc"]);

/**
 * Changed paths that define what `pnpm verify` checks. A branch that touches
 * them could make the orchestrator's independent verify pass trivially, so it
 * is not pushed automatically.
 */
export function verifyConfigPaths(files: readonly string[]): string[] {
  return files.filter((file) => {
    const base = posix.basename(file);
    return (
      ROOT_VERIFY_FILES.has(file) ||
      file.startsWith("scripts/") ||
      base === "package.json" ||
      base.startsWith("eslint.config.") ||
      base.startsWith("vitest.config.") ||
      /^tsconfig.*\.json$/.test(base) ||
      base.startsWith(".prettierrc") ||
      base === ".prettierignore"
    );
  });
}
