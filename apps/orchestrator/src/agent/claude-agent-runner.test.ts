import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  AGENT_ALLOWED_TOOLS,
  AGENT_DISALLOWED_TOOLS,
  ClaudeAgentRunner,
  type QueryFn,
} from "./claude-agent-runner.js";

const input = { cwd: "/tmp/wt/issue-7", prompt: "do it", maxTurns: 12, maxBudgetUsd: 1.5 };

function fakeQuery(messages: object[]): {
  fn: QueryFn;
  calls: { prompt: string; options?: Options }[];
} {
  const calls: { prompt: string; options?: Options }[] = [];
  const fn: QueryFn = (params) => {
    calls.push(params);
    return (async function* () {
      for (const m of messages) yield m as SDKMessage;
    })();
  };
  return { fn, calls };
}

describe("ClaudeAgentRunner", () => {
  it("passes the guarded options to query()", async () => {
    const { fn, calls } = fakeQuery([]);
    await new ClaudeAgentRunner(fn, {
      PATH: "/bin",
      GITHUB_TOKEN: "ghp_x",
      ANTHROPIC_API_KEY: "k",
    }).run(input);

    expect(calls).toHaveLength(1);
    const options = calls[0]?.options;
    expect(calls[0]?.prompt).toBe("do it");
    expect(options).toMatchObject({
      cwd: "/tmp/wt/issue-7",
      permissionMode: "acceptEdits",
      settingSources: ["project"],
      maxTurns: 12,
      maxBudgetUsd: 1.5,
      systemPrompt: { type: "preset", preset: "claude_code" },
    });
    expect(options?.allowedTools).toEqual([
      "Bash(pnpm install --frozen-lockfile)",
      "Bash(pnpm verify)",
      "Bash(pnpm lint)",
      "Bash(pnpm typecheck)",
      "Bash(pnpm test)",
      "Bash(pnpm format)",
      "Bash(git add *)",
      "Bash(git commit *)",
    ]);
    expect(options?.allowedTools).toEqual(AGENT_ALLOWED_TOOLS);
    expect(options?.disallowedTools).toEqual(AGENT_DISALLOWED_TOOLS);
    for (const rule of [
      "Edit(.github/**)",
      "Write(.github/**)",
      "Edit(.claude/**)",
      "Write(.claude/**)",
      "Edit(holdout/**)",
      "Write(holdout/**)",
      "Read(holdout/**)",
      "Bash(git push *)",
      "Bash(gh *)",
    ]) {
      expect(options?.disallowedTools).toContain(rule);
    }
  });

  it("does not hand the GitHub token to the agent process", async () => {
    const { fn, calls } = fakeQuery([]);
    await new ClaudeAgentRunner(fn, {
      PATH: "/bin",
      GITHUB_TOKEN: "ghp_x",
      GITHUB_WEBHOOK_SECRET: "s",
      ANTHROPIC_API_KEY: "k",
    }).run(input);
    const env = calls[0]?.options?.env;
    expect(env?.GITHUB_TOKEN).toBeUndefined();
    expect(env?.GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(env?.ANTHROPIC_API_KEY).toBe("k");
    expect(env?.PATH).toBe("/bin");
  });

  it("turns on CLAUDE_CODE_SUBPROCESS_ENV_SCRUB only when asked", async () => {
    const off = fakeQuery([]);
    await new ClaudeAgentRunner(off.fn, {
      PATH: "/bin",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      RUNS_API_TOKEN: "runs-token",
    }).run(input);
    expect(off.calls[0]?.options?.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBeUndefined();
    expect(off.calls[0]?.options?.env?.RUNS_API_TOKEN).toBeUndefined();

    const on = fakeQuery([]);
    await new ClaudeAgentRunner(on.fn, { PATH: "/bin" }, true).run(input);
    expect(on.calls[0]?.options?.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
  });

  it("maps a success result", async () => {
    const { fn } = fakeQuery([
      { type: "system", subtype: "init" },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Added the endpoint with tests.",
        total_cost_usd: 0.42,
        num_turns: 9,
      },
    ]);
    expect(await new ClaudeAgentRunner(fn, {}).run(input)).toEqual({
      ok: true,
      subtype: "success",
      costUsd: 0.42,
      numTurns: 9,
      summary: "Added the endpoint with tests.",
    });
  });

  it("maps an error result with its subtype and errors", async () => {
    const { fn } = fakeQuery([
      {
        type: "result",
        subtype: "error_max_budget_usd",
        is_error: true,
        errors: ["budget exceeded"],
        total_cost_usd: 1.51,
        num_turns: 30,
      },
    ]);
    expect(await new ClaudeAgentRunner(fn, {}).run(input)).toEqual({
      ok: false,
      subtype: "error_max_budget_usd",
      costUsd: 1.51,
      numTurns: 30,
      summary: "budget exceeded",
    });
  });

  it("treats a success subtype flagged is_error as a failure", async () => {
    const { fn } = fakeQuery([
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "API Error",
        total_cost_usd: 0,
        num_turns: 1,
      },
    ]);
    const result = await new ClaudeAgentRunner(fn, {}).run(input);
    expect(result.ok).toBe(false);
    expect(result.subtype).toBe("success");
  });

  it("reports no_result when the stream ends without a result message", async () => {
    const { fn } = fakeQuery([{ type: "system", subtype: "init" }]);
    const result = await new ClaudeAgentRunner(fn, {}).run(input);
    expect(result).toMatchObject({ ok: false, subtype: "no_result", costUsd: 0, numTurns: 0 });
  });
});
