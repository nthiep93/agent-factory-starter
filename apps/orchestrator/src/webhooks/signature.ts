import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

/** The `X-Hub-Signature-256` value GitHub sends for this body. */
export function signPayload(secret: string, body: Buffer): string {
  return PREFIX + createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Checks `X-Hub-Signature-256` against an HMAC-SHA256 of the raw body.
 * Compares in constant time; returns false (never throws) for a missing,
 * malformed or wrong-length header.
 */
export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!secret || !header || !header.startsWith(PREFIX)) return false;
  const received = header.slice(PREFIX.length);
  if (!/^[0-9a-f]{64}$/i.test(received)) return false;

  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(received, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
