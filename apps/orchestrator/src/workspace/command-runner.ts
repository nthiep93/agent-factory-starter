import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  /** stdout and stderr interleaved, truncated to the last {@link MAX_OUTPUT} characters. */
  output: string;
}

export interface CommandOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Runs a program with an argument array: no shell, so nothing in the
 * arguments is ever interpreted. Resolves with the exit code instead of
 * rejecting on failure; rejects only when the program cannot start.
 */
export interface CommandRunner {
  run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult>;
}

export const MAX_OUTPUT = 200_000;

export class SpawnCommandRunner implements CommandRunner {
  run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
      });
      let output = "";
      const append = (chunk: Buffer): void => {
        output += chunk.toString("utf8");
        if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", reject);
      child.on("close", (code, signal) => {
        const suffix = signal ? `\n[killed by ${signal}]` : "";
        resolve({ code: code ?? 1, output: output.slice(-MAX_OUTPUT) + suffix });
      });
    });
  }
}
