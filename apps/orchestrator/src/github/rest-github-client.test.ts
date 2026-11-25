import { describe, expect, it } from "vitest";
import { GitHubApiError, RestGitHubClient, type FetchFn } from "./rest-github-client.js";

const TOKEN = "github_pat_supersecret";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, json: unknown): { fn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn: FetchFn = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fn, calls };
}

const client = (fn: FetchFn): RestGitHubClient =>
  new RestGitHubClient({ token: TOKEN, owner: "acme", repo: "widgets" }, fn);

describe("RestGitHubClient", () => {
  it("creates a pull request with the GitHub REST headers", async () => {
    const { fn, calls } = fakeFetch(201, {
      number: 12,
      html_url: "https://github.com/acme/widgets/pull/12",
    });

    const pr = await client(fn).createPullRequest({
      title: "Add thing",
      head: "agent/issue-7",
      base: "main",
      body: "Closes #7",
    });

    expect(pr).toEqual({ number: 12, url: "https://github.com/acme/widgets/pull/12" });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe("https://api.github.com/repos/acme/widgets/pulls");
    expect(call?.init.method).toBe("POST");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      title: "Add thing",
      head: "agent/issue-7",
      base: "main",
      body: "Closes #7",
    });
  });

  it("comments on an issue", async () => {
    const { fn, calls } = fakeFetch(201, { id: 1 });
    await client(fn).commentOnIssue(7, "picked up");
    expect(calls[0]?.url).toBe("https://api.github.com/repos/acme/widgets/issues/7/comments");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ body: "picked up" });
  });

  it("throws a clear error on non-2xx without leaking the token", async () => {
    const { fn } = fakeFetch(422, {
      message: "Validation Failed",
      errors: [{ message: "A pull request already exists for acme:agent/issue-7." }],
    });

    const error = await client(fn)
      .createPullRequest({ title: "t", head: "agent/issue-7", base: "main", body: "b" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GitHubApiError);
    const apiError = error as GitHubApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.message).toContain("POST /repos/acme/widgets/pulls");
    expect(apiError.message).toContain("422");
    expect(apiError.message).toContain("Validation Failed");
    expect(apiError.message).toContain("A pull request already exists");
    expect(apiError.message).not.toContain(TOKEN);
    expect(JSON.stringify(apiError)).not.toContain(TOKEN);
  });

  it("handles a non-JSON error body", async () => {
    const fn: FetchFn = async () => new Response("Bad gateway", { status: 502 });
    await expect(client(fn).commentOnIssue(1, "x")).rejects.toThrow(/502.*Bad gateway/);
  });

  it("rejects an invalid issue number before calling GitHub", async () => {
    const { fn, calls } = fakeFetch(201, {});
    await expect(client(fn).commentOnIssue(0, "x")).rejects.toThrow(/issue number/);
    expect(calls).toHaveLength(0);
  });
});
