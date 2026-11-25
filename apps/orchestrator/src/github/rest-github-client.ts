import {
  GitHubApiError,
  type CreatePullRequestInput,
  type GitHubClient,
  type PullRequestRef,
} from "./github-client.js";

export { GitHubApiError };

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
  token: string;
  owner: string;
  repo: string;
  apiUrl?: string;
}

const MAX_ERROR_DETAIL = 500;

/** GitHub REST client over global fetch. Never includes the token in errors. */
export class RestGitHubClient implements GitHubClient {
  private readonly apiUrl: string;

  constructor(
    private readonly options: GitHubClientOptions,
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
  ) {
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
    const json = await this.request("POST", `/repos/${this.repoPath()}/pulls`, input);
    return toPullRequestRef(json);
  }

  async findOpenPullRequest(branch: string): Promise<PullRequestRef | null> {
    const head = encodeURIComponent(`${this.options.owner}:${branch}`);
    const json = await this.request(
      "GET",
      `/repos/${this.repoPath()}/pulls?head=${head}&state=open&per_page=1`,
    );
    const first = Array.isArray(json) ? (json[0] as unknown) : undefined;
    return first === undefined ? null : toPullRequestRef(first);
  }

  async commentOnIssue(issueNumber: number, body: string): Promise<void> {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(`Invalid issue number: ${issueNumber}`);
    }
    await this.request("POST", `/repos/${this.repoPath()}/issues/${issueNumber}/comments`, {
      body,
    });
  }

  private repoPath(): string {
    return `${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repo)}`;
  }

  private async request(method: "GET" | "POST", path: string, payload?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-factory-orchestrator",
    };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.fetchFn(this.apiUrl + path, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = this.redact(describeError(text)).slice(0, MAX_ERROR_DETAIL);
      throw new GitHubApiError(
        `GitHub API ${method} ${path.split("?")[0]} failed with ${response.status}: ${detail}`,
        response.status,
      );
    }
    return text ? (JSON.parse(text) as unknown) : {};
  }

  private redact(text: string): string {
    return this.options.token ? text.split(this.options.token).join("***") : text;
  }
}

function toPullRequestRef(json: unknown): PullRequestRef {
  const record = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const number = typeof record.number === "number" ? record.number : NaN;
  const url = typeof record.html_url === "string" ? record.html_url : "";
  if (!Number.isInteger(number) || !url) {
    throw new GitHubApiError("GitHub returned a pull request without number or html_url", 200);
  }
  return { number, url };
}

/** GitHub errors look like `{ message, errors: [{ message }] }`; fall back to raw text. */
function describeError(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as { message?: unknown; errors?: unknown };
      const parts: string[] = [];
      if (typeof record.message === "string") parts.push(record.message);
      if (Array.isArray(record.errors)) {
        for (const item of record.errors as unknown[]) {
          if (typeof item === "object" && item !== null && "message" in item) {
            const message = (item as { message: unknown }).message;
            if (typeof message === "string") parts.push(message);
          }
        }
      }
      if (parts.length > 0) return parts.join("; ");
    }
  } catch {
    // Not JSON: use the text as is.
  }
  return text.trim() || "(empty body)";
}
