import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Claude Code (the CLI the SDK runs) honours CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:
 * the Bash tool's subprocesses then run in a bubblewrap sandbox with a
 * scrubbed environment. Found in the bundled CLI of
 * @anthropic-ai/claude-agent-sdk 0.3.332; it refuses to start without
 * bubblewrap ("bubblewrap is required for subprocess env scrubbing"), so
 * "auto" only enables it when `bwrap` is on PATH.
 */
export const ENV_SCRUB_VARIABLE = "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB";

export function bubblewrapOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      accessSync(join(dir, "bwrap"), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

export function resolveEnvScrub(
  mode: "auto" | "on" | "off",
  hasBubblewrap: () => boolean = bubblewrapOnPath,
): boolean {
  if (mode === "auto") return hasBubblewrap();
  return mode === "on";
}
