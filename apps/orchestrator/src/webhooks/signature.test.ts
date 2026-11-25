import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signPayload, verifySignature } from "./signature.js";

const secret = "It's a Secret to Everybody";
const body = Buffer.from("Hello, World!");

describe("verifySignature", () => {
  it("accepts GitHub's documented example signature", () => {
    // Example from GitHub's "Validating webhook deliveries" documentation.
    const header = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(verifySignature(secret, body, header)).toBe(true);
  });

  it("accepts a signature it produced itself", () => {
    expect(verifySignature(secret, body, signPayload(secret, body))).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifySignature(secret, body, signPayload("wrong secret", body))).toBe(false);
  });

  it("rejects a modified body", () => {
    expect(verifySignature(secret, Buffer.from("Hello, World?"), signPayload(secret, body))).toBe(
      false,
    );
  });

  it("rejects a missing or empty header", () => {
    expect(verifySignature(secret, body, undefined)).toBe(false);
    expect(verifySignature(secret, body, "")).toBe(false);
  });

  it("rejects a header of the wrong length without throwing", () => {
    expect(verifySignature(secret, body, "sha256=abc")).toBe(false);
    expect(verifySignature(secret, body, `${signPayload(secret, body)}00`)).toBe(false);
  });

  it("rejects other algorithms and non-hex digests", () => {
    const sha1 = createHmac("sha1", secret).update(body).digest("hex");
    expect(verifySignature(secret, body, `sha1=${sha1}`)).toBe(false);
    expect(verifySignature(secret, body, `sha256=${"z".repeat(64)}`)).toBe(false);
  });

  it("rejects everything when the secret is empty", () => {
    expect(verifySignature("", body, signPayload("", body))).toBe(false);
  });
});
