export interface VersionResponse {
  service: string;
  /** First 7 characters of the deployed commit, or null outside Vercel. */
  commit: string | null;
  branch: string | null;
}

type Env = Record<string, string | undefined>;

const present = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** Reads the commit and branch Vercel injects at build and run time. */
export function buildVersion(service: string, env: Env): VersionResponse {
  const sha = present(env.VERCEL_GIT_COMMIT_SHA);
  return {
    service,
    commit: sha ? sha.slice(0, 7) : null,
    branch: present(env.VERCEL_GIT_COMMIT_REF),
  };
}
