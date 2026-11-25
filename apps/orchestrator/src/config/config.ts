import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

/** DI token for the validated {@link OrchestratorConfig}. */
export const APP_CONFIG = Symbol("APP_CONFIG");

export interface OrchestratorConfig {
  webhookSecret: string;
  githubToken: string;
  repository: { owner: string; repo: string };
  redisUrl: string;
  /** Existing clone the worktrees are created from. */
  repoDir: string;
  worktreesDir: string;
  triggerLabel: string;
  agentMaxTurns: number;
  agentMaxBudgetUsd: number;
  agentConcurrency: number;
  port: number;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid orchestrator configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

/**
 * Reads and validates the orchestrator configuration. Collects every problem
 * before throwing so a misconfigured deploy fails once with the full list.
 * Error messages name variables, never their values (some are secrets).
 */
export function loadConfig(
  env: Env,
  pathExists: (path: string) => boolean = existsSync,
): OrchestratorConfig {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      problems.push(`${name} is required`);
      return "";
    }
    return value;
  };

  const optionalNumber = (
    name: string,
    fallback: number,
    check: (n: number) => boolean,
    rule: string,
  ): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || !check(value)) {
      problems.push(`${name} must be ${rule}`);
      return fallback;
    }
    return value;
  };

  const directory = (name: string, mustExist: boolean): string => {
    const value = required(name);
    if (!value) return value;
    if (!isAbsolute(value)) {
      problems.push(`${name} must be an absolute path`);
    } else if (mustExist && !pathExists(value)) {
      problems.push(`${name} points to a directory that does not exist`);
    }
    return value;
  };

  const webhookSecret = required("GITHUB_WEBHOOK_SECRET");
  const githubToken = required("GITHUB_TOKEN");

  const repositoryRaw = required("GITHUB_REPOSITORY");
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repositoryRaw);
  if (repositoryRaw && !match) problems.push("GITHUB_REPOSITORY must look like owner/repo");

  const redisUrl = required("REDIS_URL");
  if (redisUrl && !/^rediss?:\/\//.test(redisUrl)) {
    problems.push("REDIS_URL must start with redis:// or rediss://");
  }

  const repoDir = directory("REPO_DIR", true);
  const worktreesDir = directory("WORKTREES_DIR", false);

  const positiveInt = (n: number): boolean => Number.isInteger(n) && n > 0;
  const config: OrchestratorConfig = {
    webhookSecret,
    githubToken,
    repository: { owner: match?.[1] ?? "", repo: match?.[2] ?? "" },
    redisUrl,
    repoDir,
    worktreesDir,
    triggerLabel: env.TRIGGER_LABEL?.trim() || "agent",
    agentMaxTurns: optionalNumber("AGENT_MAX_TURNS", 40, positiveInt, "a positive integer"),
    agentMaxBudgetUsd: optionalNumber(
      "AGENT_MAX_BUDGET_USD",
      3,
      (n) => n > 0,
      "a positive number of dollars",
    ),
    agentConcurrency: optionalNumber("AGENT_CONCURRENCY", 2, positiveInt, "a positive integer"),
    port: optionalNumber(
      "PORT",
      3100,
      (n) => Number.isInteger(n) && n > 0 && n < 65536,
      "an integer between 1 and 65535",
    ),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** A copy that is safe to log: secrets removed, Redis credentials masked. */
export function redactConfig(config: OrchestratorConfig): Record<string, string | number> {
  return {
    repository: `${config.repository.owner}/${config.repository.repo}`,
    redisUrl: config.redisUrl.replace(/\/\/[^@/]*@/, "//***@"),
    repoDir: config.repoDir,
    worktreesDir: config.worktreesDir,
    triggerLabel: config.triggerLabel,
    agentMaxTurns: config.agentMaxTurns,
    agentMaxBudgetUsd: config.agentMaxBudgetUsd,
    agentConcurrency: config.agentConcurrency,
    port: config.port,
  };
}
