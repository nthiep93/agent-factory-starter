/** DI token for {@link GitHubClient}. */
export const GITHUB_CLIENT = Symbol("GITHUB_CLIENT");

export interface CreatePullRequestInput {
  title: string;
  head: string;
  base: string;
  body: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
}

/** A non-2xx answer from GitHub. The message never contains the token. */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/** The GitHub calls the orchestrator makes, always with its own token. */
export interface GitHubClient {
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef>;
  /** The open PR whose head is `branch` in this repository, if any. */
  findOpenPullRequest(branch: string): Promise<PullRequestRef | null>;
  commentOnIssue(issueNumber: number, body: string): Promise<void>;
}
