import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, redactConfig } from "./config.js";

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
      },
      exists,
    );
    expect(config.triggerLabel).toBe("factory");
    expect(config.agentMaxTurns).toBe(10);
    expect(config.agentMaxBudgetUsd).toBe(0.5);
    expect(config.agentConcurrency).toBe(1);
    expect(config.port).toBe(4000);
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
