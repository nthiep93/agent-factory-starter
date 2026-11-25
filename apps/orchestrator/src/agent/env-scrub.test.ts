import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bubblewrapOnPath, resolveEnvScrub } from "./env-scrub.js";

describe("resolveEnvScrub", () => {
  it("follows explicit on/off and probes bubblewrap for auto", () => {
    expect(resolveEnvScrub("on", () => false)).toBe(true);
    expect(resolveEnvScrub("off", () => true)).toBe(false);
    expect(resolveEnvScrub("auto", () => true)).toBe(true);
    expect(resolveEnvScrub("auto", () => false)).toBe(false);
  });
});

describe("bubblewrapOnPath", () => {
  it("finds an executable bwrap on PATH only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bwrap-"));
    try {
      expect(bubblewrapOnPath({ PATH: dir })).toBe(false);
      await writeFile(join(dir, "bwrap"), "#!/bin/sh\n");
      expect(bubblewrapOnPath({ PATH: dir })).toBe(false);
      await chmod(join(dir, "bwrap"), 0o755);
      expect(bubblewrapOnPath({ PATH: `/nonexistent:${dir}` })).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
