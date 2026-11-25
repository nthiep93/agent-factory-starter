/** Generic shapes of GitHub and Anthropic credentials, redacted even when not configured here. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
];

/** Shorter values are too likely to appear in normal text to be replaced safely. */
const MIN_SECRET_LENGTH = 6;
/** Encoded fragments shorter than this would match ordinary text. */
const MIN_FRAGMENT_LENGTH = 8;
export const REDACTED = "[REDACTED]";

const toBase64Url = (b64: string): string => b64.replace(/\+/g, "-").replace(/\//g, "_");

/**
 * The part of base64(prefix + secret) that depends only on the secret, for a
 * prefix of 0, 1 or 2 bytes. Together the three cover the secret wherever it
 * sits inside a larger base64-encoded blob (for example a basic-auth header).
 */
function base64Fragments(secret: Buffer): string[] {
  const out: string[] = [];
  for (let offset = 0; offset < 3; offset++) {
    const encoded = Buffer.concat([Buffer.alloc(offset), secret]).toString("base64");
    const start = Math.ceil((offset * 8) / 6);
    const end = Math.floor(((offset + secret.length) * 8) / 6);
    const fragment = encoded.slice(start, end);
    if (fragment.length >= MIN_FRAGMENT_LENGTH) out.push(fragment, toBase64Url(fragment));
  }
  return out;
}

/** Every form a secret can take in output: raw, base64/base64url, URL-encoded, hex, basic auth. */
export function secretVariants(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  const basic = Buffer.from(`x-access-token:${secret}`, "utf8").toString("base64");
  const hex = bytes.toString("hex");
  const variants = [
    secret,
    ...base64Fragments(bytes),
    bytes.toString("base64").replace(/=+$/, ""),
    toBase64Url(bytes.toString("base64")).replace(/=+$/, ""),
    encodeURIComponent(secret),
    hex,
    hex.toUpperCase(),
    basic.replace(/=+$/, ""),
  ];
  return [...new Set(variants)].filter((v) => v.length >= MIN_FRAGMENT_LENGTH || v === secret);
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches the value even when whitespace (line wraps, spaces) was inserted between characters. */
const spacedPattern = (value: string): RegExp =>
  new RegExp([...value].map(escapeRegExp).join("\\s*"), "g");

/** A function that removes secrets from text. */
export type Redact = (text: string) => string;

/**
 * Builds a redactor for known secret values (all their encoded forms) plus
 * token-shaped strings. Apply it before any truncation, so a secret cut in
 * half cannot leak its first part.
 */
export function makeRedactor(secrets: readonly (string | undefined)[]): Redact {
  const values = secrets.filter(
    (s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH,
  );
  const patterns = [...new Set(values.flatMap(secretVariants))]
    // Longest first, so a value containing another is replaced whole.
    .sort((a, b) => b.length - a.length)
    .map(spacedPattern);
  return (text) => {
    let out = text;
    for (const pattern of patterns) out = out.replace(pattern, REDACTED);
    for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
    return out;
  };
}

export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  return makeRedactor(secrets)(text);
}

/** Redacts every string inside a JSON-like value (records, arrays, nested objects). */
export function redactDeep<T>(value: T, redact: Redact): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item: unknown) => redactDeep(item, redact)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, redact)]),
    ) as T;
  }
  return value;
}
