// Shared helpers for holdout scenarios. Not a test file: node --test only
// runs files matching *.test.mjs.

/** Base URL from an env var, without a trailing slash. Throws if unset. */
export function baseUrl(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (for example ${name}=http://localhost:3001)`);
  return value.replace(/\/+$/, "");
}

/** fetch with a timeout so a hung server fails the scenario instead of the job. */
export function get(url, init = {}) {
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
}

/** Visible text of server-rendered HTML: tags and React's <!-- --> markers removed. */
export function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ");
}

/** A short commit, optionally with "(branch)", or "local" outside Vercel. */
export const VERSION_TEXT = "(?:local|[0-9a-f]{7,40}(?: \\([^)]+\\))?)";
