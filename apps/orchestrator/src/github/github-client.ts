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

/** The GitHub calls the orchestrator makes, always with its own token. */
export interface GitHubClient {
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef>;
  commentOnIssue(issueNumber: number, body: string): Promise<void>;
}
