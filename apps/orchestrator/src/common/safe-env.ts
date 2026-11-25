/** Variables only the orchestrator itself may see. */
export const ORCHESTRATOR_SECRETS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "REDIS_URL",
] as const;

/**
 * Copy of `env` without the named variables. Child processes (the agent, and
 * `pnpm` running code the agent wrote) get this instead of `process.env`, so
 * a prompt-injected or malicious change cannot read the GitHub token.
 */
export function withoutSecrets(
  env: NodeJS.ProcessEnv,
  names: readonly string[] = ORCHESTRATOR_SECRETS,
): Record<string, string> {
  const blocked = new Set(names);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !blocked.has(key)) result[key] = value;
  }
  return result;
}
