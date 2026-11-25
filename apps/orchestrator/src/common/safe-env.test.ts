import { describe, expect, it } from "vitest";
import { withoutSecrets } from "./safe-env.js";

describe("withoutSecrets", () => {
  it("drops the orchestrator secrets and keeps everything else", () => {
    const env = withoutSecrets({
      PATH: "/bin",
      GITHUB_TOKEN: "t",
      GH_TOKEN: "t",
      GITHUB_WEBHOOK_SECRET: "s",
      REDIS_URL: "redis://x",
      RUNS_API_TOKEN: "r",
      ANTHROPIC_API_KEY: "k",
      EMPTY: undefined,
    });
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "k" });
  });

  it("accepts an extra deny list", () => {
    expect(withoutSecrets({ A: "1", B: "2" }, ["B"])).toEqual({ A: "1" });
  });
});
