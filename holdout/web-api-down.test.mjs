// Degraded mode: the web page must still render when its API is down.
// Needs a web instance whose NEXT_PUBLIC_API_URL points at a port where
// nothing listens, given as WEB_DEAD_API_URL. CI starts a second web server
// for this; locally you can stop the API and reuse the normal web server.
// Skipped (reported as skipped, not passed) when WEB_DEAD_API_URL is unset.
import assert from "node:assert/strict";
import { it } from "node:test";
import { get, visibleText } from "./helpers.mjs";

const deadApiWeb = process.env.WEB_DEAD_API_URL?.replace(/\/+$/, "");

it(
  "web home still renders and reports the api as unreachable when the API is down",
  { skip: deadApiWeb ? false : "WEB_DEAD_API_URL is not set" },
  async () => {
    const res = await get(`${deadApiWeb}/`);
    assert.equal(res.status, 200);
    const text = visibleText(await res.text());
    assert.match(text, /web: ok \(/, "web status still rendered");
    assert.match(text, /api: unreachable: \S/, "api status explains why it is unreachable");
    const section = text.split("Phiên bản đang chạy")[1];
    assert.ok(section !== undefined, "version section still rendered");
    assert.match(section, /api: unreachable: \S/, "api version explains why it is unreachable");
  },
);
