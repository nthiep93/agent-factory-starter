import type { CreatePullRequestInput, GitHubClient, PullRequestRef } from "./github-client.js";

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
  token: string;
  owner: string;
  repo: string;
  apiUrl?: string;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
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
    const json = await this.post(`/repos/${this.repoPath()}/pulls`, input);
    const number = typeof json.number === "number" ? json.number : NaN;
    const url = typeof json.html_url === "string" ? json.html_url : "";
    if (!Number.isInteger(number) || !url) {
      throw new GitHubApiError("GitHub returned a pull request without number or html_url", 200);
    }
    return { number, url };
  }

  async commentOnIssue(issueNumber: number, body: string): Promise<void> {
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      throw new Error(`Invalid issue number: ${issueNumber}`);
    }
    await this.post(`/repos/${this.repoPath()}/issues/${issueNumber}/comments`, { body });
  }

  private repoPath(): string {
    return `${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repo)}`;
  }

  private async post(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetchFn(this.apiUrl + path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "agent-factory-orchestrator",
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = this.redact(describeError(text)).slice(0, MAX_ERROR_DETAIL);
      throw new GitHubApiError(
        `GitHub API POST ${path} failed with ${response.status}: ${detail}`,
        response.status,
      );
    }
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  }

  private redact(text: string): string {
    return this.options.token ? text.split(this.options.token).join("***") : text;
  }
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
