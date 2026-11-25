import { describe, expect, it } from "vitest";
import { Mutex } from "./mutex.js";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("Mutex", () => {
  it("runs tasks one at a time in call order", async () => {
    const mutex = new Mutex();
    const events: string[] = [];
    const task = (name: string) => async () => {
      events.push(`start ${name}`);
      await tick();
      events.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([mutex.run(task("a")), mutex.run(task("b"))]);
    expect(results).toEqual(["a", "b"]);
    expect(events).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("keeps going after a task fails", async () => {
    const mutex = new Mutex();
    const failed = mutex.run(async () => {
      throw new Error("boom");
    });
    await expect(failed).rejects.toThrow("boom");
    await expect(mutex.run(async () => "next")).resolves.toBe("next");
  });
});
