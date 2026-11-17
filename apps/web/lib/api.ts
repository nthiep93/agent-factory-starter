import type { HealthResponse } from "@repo/shared";

export type ApiHealth =
  { reachable: true; data: HealthResponse } | { reachable: false; reason: string };

/** Fetches the API health endpoint. Never throws, so the page always renders. */
export async function fetchApiHealth(
  baseUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<ApiHealth> {
  if (!baseUrl) return { reachable: false, reason: "NEXT_PUBLIC_API_URL is not set" };

  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/health`, { cache: "no-store" });
    if (!res.ok) return { reachable: false, reason: `API responded ${res.status}` };
    return { reachable: true, data: (await res.json()) as HealthResponse };
  } catch (error) {
    return { reachable: false, reason: error instanceof Error ? error.message : "Unknown error" };
  }
}
