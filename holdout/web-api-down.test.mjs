// Degraded mode: the web page must still render when its API is down.
// Needs a web instance whose API_URL points at a port where nothing listens,
// given as WEB_DEAD_API_URL. CI starts a second web server for this; locally
// you can stop the API and reuse the normal web server.
// Outside CI it is skipped (reported as skipped) when WEB_DEAD_API_URL is
// unset; in CI (CI env var set) a missing WEB_DEAD_API_URL is a failure.
import assert from "node:assert/strict";
import { it } from "node:test";
import { get, visibleText } from "./helpers.mjs";

const deadApiWeb = process.env.WEB_DEAD_API_URL?.replace(/\/+$/, "");

if (!deadApiWeb && process.env.CI) {
  it("WEB_DEAD_API_URL is set in CI", () => {
    assert.fail("WEB_DEAD_API_URL must be set in CI; the API-down scenario cannot be skipped");
  });
}

it(
  "web home still renders and reports the api as unreachable when the API is down",
  { skip: deadApiWeb ? false : "WEB_DEAD_API_URL is not set" },
  async () => {
    const res = await get(`${deadApiWeb}/`);
    assert.equal(res.status, 200);
    const text = visibleText(await res.text());
    assert.match(text, /web: ok \(/, "web status still rendered");
    assert.match(text, /api: unreachable: \S/, "api status explains why it is unreachable");
    // "... is not set" means the server never got an API URL: that is a
    // misconfigured server, not the API-down case this scenario is about.
    assert.doesNotMatch(text, /unreachable: [^\n]*is not set/, "an API URL was configured");
    const section = text.split("Phiên bản đang chạy")[1];
    assert.ok(section !== undefined, "version section still rendered");
    assert.match(section, /api: unreachable: \S/, "api version explains why it is unreachable");
  },
);
