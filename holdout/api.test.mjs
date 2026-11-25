// Acceptance scenarios for the API, run against a live server.
//   API_URL=http://localhost:3001 node --test holdout/
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseUrl, get } from "./helpers.mjs";

const api = baseUrl("API_URL");

async function getJson(path, init) {
  const res = await get(`${api}${path}`, init);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/, `${path} content-type`);
  return { res, body: await res.json() };
}

describe("API", () => {
  it("GET /health reports ok with a non-negative integer uptime", async () => {
    const { res, body } = await getJson("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["service", "status", "uptimeSeconds"]);
    assert.equal(body.status, "ok");
    assert.equal(body.service, "api");
    assert.ok(Number.isInteger(body.uptimeSeconds), "uptimeSeconds is an integer");
    assert.ok(body.uptimeSeconds >= 0, "uptimeSeconds >= 0");
  });

  it("GET /version names the api and gives commit/branch as string or null", async () => {
    const { res, body } = await getJson("/version");
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(body).sort(), ["branch", "commit", "service"]);
    assert.equal(body.service, "api");
    for (const key of ["commit", "branch"]) {
      assert.ok(
        body[key] === null || (typeof body[key] === "string" && body[key].length > 0),
        `${key} is null or a non-empty string, got ${JSON.stringify(body[key])}`,
      );
    }
    if (body.commit !== null) assert.match(body.commit, /^[0-9a-f]{7}$/, "commit is a short SHA");
  });

  it("an unknown route returns a 404 JSON error", async () => {
    const { res, body } = await getJson("/holdout-no-such-route");
    assert.equal(res.status, 404);
    assert.equal(body.statusCode, 404);
  });

  it("GET /health allows cross-origin requests from the web app", async () => {
    const res = await get(`${api}/health`, { headers: { Origin: "https://web.example.com" } });
    assert.equal(res.status, 200);
    const allow = res.headers.get("access-control-allow-origin");
    assert.ok(
      allow === "*" || allow === "https://web.example.com",
      `access-control-allow-origin is ${JSON.stringify(allow)}`,
    );
  });
});
