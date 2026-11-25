import { describe, expect, it } from "vitest";
import { REDACTED, makeRedactor, redactDeep, redactSecrets, secretVariants } from "./redact.js";

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

  it("redacts a base64-encoded token, at every byte offset and inside a basic-auth header", () => {
    const token = "custom-secret-token-value";
    for (const prefix of ["", "a", "ab", "abc"]) {
      const encoded = Buffer.from(`${prefix}${token}suffix`).toString("base64");
      const out = redactSecrets(`header ${encoded} end`, [token]);
      expect(out).toContain(REDACTED);
      // What survives cannot be decoded back to the token.
      expect(Buffer.from(out.replace(REDACTED, ""), "base64").toString()).not.toContain(token);
    }
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    expect(redactSecrets(`AUTHORIZATION: basic ${basic}`, [token])).not.toContain(basic);
  });

  it("redacts base64url, URL-encoded and hex forms", () => {
    const token = "s3cr3t+/value?&=more";
    const forms = [
      Buffer.from(token).toString("base64url"),
      encodeURIComponent(token),
      Buffer.from(token).toString("hex"),
      Buffer.from(token).toString("hex").toUpperCase(),
    ];
    for (const form of forms) {
      expect(redactSecrets(`x ${form} y`, [token])).toBe(`x ${REDACTED} y`);
    }
    expect(secretVariants(token)).toContain(encodeURIComponent(token));
  });

  it("matches a secret broken up by whitespace or line wraps", () => {
    const token = "my-secret-value-123";
    expect(redactSecrets("a my-secret-\n   value-123 b", [token])).toBe(`a ${REDACTED} b`);
  });

  it("redactDeep redacts every string in a nested record", () => {
    const redact = makeRedactor(["deep-secret-1"]);
    expect(
      redactDeep(
        {
          a: "x deep-secret-1",
          list: ["deep-secret-1", 3],
          nested: { b: null, c: "deep-secret-1" },
        },
        redact,
      ),
    ).toEqual({ a: `x ${REDACTED}`, list: [REDACTED, 3], nested: { b: null, c: REDACTED } });
  });
});
