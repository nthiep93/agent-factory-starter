import { describe, expect, it } from "vitest";
import { REDACTED, makeRedactor, redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("replaces every occurrence of a configured secret", () => {
    expect(redactSecrets("a my-secret-value b my-secret-value", ["my-secret-value"])).toBe(
      `a ${REDACTED} b ${REDACTED}`,
    );
  });

  it("redacts token-shaped strings even when they are not configured", () => {
    const text = [
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "gho_abcdefghijklmnopqrstuvwxyz0123",
      "ghs_abcdefghijklmnopqrstuvwxyz0123",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
      "sk-ant-api03-abcDEF_123-xyz",
    ].join(" ");
    const out = redactSecrets(text, []);
    expect(out).not.toMatch(/ghp_|gho_|ghs_|github_pat_|sk-ant-/);
    expect(out.split(REDACTED)).toHaveLength(6);
  });

  it("ignores missing and very short values instead of mangling text", () => {
    expect(redactSecrets("abc def", [undefined, "", "abc"])).toBe("abc def");
  });

  it("replaces a longer secret whole when it contains a shorter one", () => {
    expect(redactSecrets("x secret-long-value y", ["secret", "secret-long-value"])).toBe(
      `x ${REDACTED} y`,
    );
  });

  it("makeRedactor binds the secret list", () => {
    const redact = makeRedactor(["webhook-secret-1"]);
    expect(redact("sig webhook-secret-1")).toBe(`sig ${REDACTED}`);
  });
});
