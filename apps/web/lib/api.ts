import type { HealthResponse, VersionResponse } from "@repo/shared";

export type ApiResult<T> = { reachable: true; data: T } | { reachable: false; reason: string };

export type ApiHealth = ApiResult<HealthResponse>;
export type ApiVersion = ApiResult<VersionResponse>;

/**
 * API base URL for server-side fetches. `API_URL` is read at run time;
 * `NEXT_PUBLIC_API_URL` is inlined by Next at build time when it is set then,
 * so it cannot be changed by the environment of `next start`. Callers pass
 * both explicitly (`process.env.X`) so Next still inlines the public one.
 */
export function resolveApiUrl(
  runtimeUrl: string | undefined,
  publicUrl: string | undefined,
): string | undefined {
  return runtimeUrl?.trim() || publicUrl?.trim() || undefined;
}

/** GETs a JSON endpoint of the API. Never throws, so the page always renders. */
async function fetchApi<T>(
  baseUrl: string | undefined,
  path: string,
  fetchImpl: typeof fetch,
): Promise<ApiResult<T>> {
  if (!baseUrl) return { reachable: false, reason: "API_URL / NEXT_PUBLIC_API_URL is not set" };

  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}${path}`, { cache: "no-store" });
    if (!res.ok) return { reachable: false, reason: `API responded ${res.status}` };
    return { reachable: true, data: (await res.json()) as T };
  } catch (error) {
    return { reachable: false, reason: error instanceof Error ? error.message : "Unknown error" };
  }
}

export function fetchApiHealth(baseUrl: string | undefined, fetchImpl: typeof fetch = fetch) {
  return fetchApi<HealthResponse>(baseUrl, "/health", fetchImpl);
}

export function fetchApiVersion(baseUrl: string | undefined, fetchImpl: typeof fetch = fetch) {
  return fetchApi<VersionResponse>(baseUrl, "/version", fetchImpl);
}

/** "abc1234 (main)", or "local" when not deployed on Vercel. */
export function describeVersion(version: VersionResponse): string {
  if (!version.commit) return "local";
  return version.branch ? `${version.commit} (${version.branch})` : version.commit;
}
