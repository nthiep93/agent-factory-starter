import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, redactConfig, secretValues } from "./config.js";

const valid = {
  GITHUB_WEBHOOK_SECRET: "whsec",
  GITHUB_TOKEN: "ghp_secret_token",
  GITHUB_REPOSITORY: "acme/widgets",
  REDIS_URL: "redis://localhost:6379",
  REPO_DIR: "/srv/repo",
  WORKTREES_DIR: "/srv/worktrees",
};
const exists = (): boolean => true;

describe("loadConfig", () => {
  it("parses required values and applies defaults", () => {
    const config = loadConfig(valid, exists);
    expect(config).toEqual({
      webhookSecret: "whsec",
      githubToken: "ghp_secret_token",
      repository: { owner: "acme", repo: "widgets" },
      redisUrl: "redis://localhost:6379",
      repoDir: "/srv/repo",
      worktreesDir: "/srv/worktrees",
      triggerLabel: "agent",
      agentMaxTurns: 40,
      agentMaxBudgetUsd: 3,
      agentConcurrency: 2,
      port: 3100,
      runsApiToken: null,
      agentEnvScrub: "auto",
    });
  });

  it("reads overrides for the optional values", () => {
    const config = loadConfig(
      {
        ...valid,
        TRIGGER_LABEL: "factory",
        AGENT_MAX_TURNS: "10",
        AGENT_MAX_BUDGET_USD: "0.5",
        AGENT_CONCURRENCY: "1",
        PORT: "4000",
        RUNS_API_TOKEN: "runs-token-123",
        AGENT_SUBPROCESS_ENV_SCRUB: "0",
      },
      exists,
    );
    expect(config.triggerLabel).toBe("factory");
    expect(config.agentMaxTurns).toBe(10);
    expect(config.agentMaxBudgetUsd).toBe(0.5);
    expect(config.agentConcurrency).toBe(1);
    expect(config.port).toBe(4000);
    expect(config.runsApiToken).toBe("runs-token-123");
    expect(config.agentEnvScrub).toBe("off");
    expect(loadConfig({ ...valid, AGENT_SUBPROCESS_ENV_SCRUB: "1" }, exists).agentEnvScrub).toBe(
      "on",
    );
  });

  it("only accepts owner/repo made of word characters, dots and dashes", () => {
    for (const bad of ["a/b/c", "a b/c", "a/b?x=1", "../x", "a/..", "owner/"]) {
      expect(() => loadConfig({ ...valid, GITHUB_REPOSITORY: bad }, exists)).toThrow(
        /GITHUB_REPOSITORY/,
      );
    }
    expect(
      loadConfig({ ...valid, GITHUB_REPOSITORY: "my-org.x/repo_1.js" }, exists).repository,
    ).toEqual({ owner: "my-org.x", repo: "repo_1.js" });
  });

  it("rejects an unknown AGENT_SUBPROCESS_ENV_SCRUB value", () => {
    expect(() => loadConfig({ ...valid, AGENT_SUBPROCESS_ENV_SCRUB: "maybe" }, exists)).toThrow(
      /AGENT_SUBPROCESS_ENV_SCRUB/,
    );
  });

  it("reports every problem at once with the variable names", () => {
    let error: unknown;
    try {
      loadConfig(
        {
          GITHUB_REPOSITORY: "not-a-repo",
          REDIS_URL: "http://x",
          AGENT_MAX_TURNS: "zero",
          AGENT_MAX_BUDGET_USD: "-1",
          PORT: "70000",
        },
        () => false,
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    for (const name of [
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_TOKEN",
      "GITHUB_REPOSITORY",
      "REDIS_URL",
      "REPO_DIR",
      "WORKTREES_DIR",
      "AGENT_MAX_TURNS",
      "AGENT_MAX_BUDGET_USD",
      "PORT",
    ]) {
      expect(message).toContain(name);
    }
  });

  it("rejects a REPO_DIR that does not exist and relative directories", () => {
    expect(() => loadConfig({ ...valid, REPO_DIR: "/nope" }, (p) => p !== "/nope")).toThrow(
      /REPO_DIR .*does not exist/,
    );
    expect(() => loadConfig({ ...valid, WORKTREES_DIR: "relative/dir" }, exists)).toThrow(
      /WORKTREES_DIR .*absolute/,
    );
  });

  it("never puts secret values in the error message", () => {
    expect(() => loadConfig({ ...valid, REDIS_URL: "redis" }, exists)).toThrow(ConfigError);
    try {
      loadConfig({ ...valid, REDIS_URL: "redis" }, exists);
    } catch (e) {
      expect((e as Error).message).not.toContain("ghp_secret_token");
      expect((e as Error).message).not.toContain("whsec");
    }
  });
});

describe("secretValues", () => {
  it("lists the token, webhook secret, runs token and Anthropic key", () => {
    const config = loadConfig({ ...valid, RUNS_API_TOKEN: "runs-token-123" }, exists);
    expect(secretValues(config, { ANTHROPIC_API_KEY: "sk-ant-key" })).toEqual([
      "ghp_secret_token",
      "whsec",
      "runs-token-123",
      "sk-ant-key",
    ]);
    expect(secretValues(loadConfig(valid, exists), {})).toEqual(["ghp_secret_token", "whsec"]);
  });
});

describe("redactConfig", () => {
  it("hides the token, the webhook secret and redis credentials", () => {
    const redacted = redactConfig(
      loadConfig({ ...valid, REDIS_URL: "redis://user:pw@redis:6379" }, exists),
    );
    const text = JSON.stringify(redacted);
    expect(text).not.toContain("ghp_secret_token");
    expect(text).not.toContain("whsec");
    expect(text).not.toContain("pw@");
    expect(redacted.repository).toBe("acme/widgets");
  });
});
