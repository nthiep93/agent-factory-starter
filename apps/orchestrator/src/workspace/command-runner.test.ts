import { describe, expect, it } from "vitest";
import { MAX_OUTPUT, SpawnCommandRunner } from "./command-runner.js";

describe("SpawnCommandRunner", () => {
  it("runs without a shell and returns the exit code", async () => {
    const result = await new SpawnCommandRunner().run("sh", ["-c", "echo '$HOME'; exit 3"], {
      cwd: "/",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.code).toBe(3);
    expect(result.output.trim()).toBe("$HOME");
  });

  it("redacts before truncating, so a secret straddling the cut cannot leak a prefix", async () => {
    const secret = "straddling-secret-value";
    // The secret starts just before the last MAX_OUTPUT characters.
    const script = `const s=${JSON.stringify(secret)};process.stdout.write("x".repeat(10)+s+"y".repeat(${MAX_OUTPUT} - 5))`;
    const redact = (text: string): string => text.split(secret).join("[REDACTED]");
    const result = await new SpawnCommandRunner(redact).run(process.execPath, ["-e", script], {
      cwd: "/",
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result.output).toHaveLength(MAX_OUTPUT);
    expect(result.output).not.toContain(secret.slice(-5));
    expect(result.output).not.toMatch(/-value/);
  });
});
