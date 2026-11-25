/** Generic shapes of GitHub and Anthropic credentials, redacted even when not configured here. */
const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
];

/** Shorter values are too likely to appear in normal text to be replaced safely. */
const MIN_SECRET_LENGTH = 6;
export const REDACTED = "[REDACTED]";

/**
 * Removes known secret values and token-shaped strings. Applied to every
 * string that leaves the process: GitHub comments, PR bodies, job return
 * values, failure reasons and log lines.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  const values = secrets
    .filter((s): s is string => typeof s === "string" && s.length >= MIN_SECRET_LENGTH)
    // Longest first, so a secret containing another is replaced whole.
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.split(value).join(REDACTED);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** A redactor bound to a fixed set of secret values. */
export type Redact = (text: string) => string;

export const makeRedactor =
  (secrets: readonly (string | undefined)[]): Redact =>
  (text) =>
    redactSecrets(text, secrets);
