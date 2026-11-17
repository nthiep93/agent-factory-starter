export type HealthStatus = "ok" | "degraded";

export interface HealthResponse {
  status: HealthStatus;
  service: string;
  uptimeSeconds: number;
}

/** Builds the health payload shared by the API and the web app. */
export function buildHealth(service: string, uptimeSeconds: number): HealthResponse {
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) {
    return { status: "degraded", service, uptimeSeconds: 0 };
  }
  return { status: "ok", service, uptimeSeconds: Math.floor(uptimeSeconds) };
}
