// Acceptance scenarios for the web home page, run against a live server whose
// NEXT_PUBLIC_API_URL points at a running API.
//   API_URL=... WEB_URL=http://localhost:3000 node --test holdout/
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VERSION_TEXT, baseUrl, get, visibleText } from "./helpers.mjs";

const web = baseUrl("WEB_URL");

async function home() {
  const res = await get(`${web}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  return visibleText(await res.text());
}

describe("web home page", () => {
  it("server-renders the web and api status as ok", async () => {
    const text = await home();
    assert.match(text, /web: ok \(\d+(h|m|s)/, "web status line");
    assert.match(text, /api: ok \(\d+(h|m|s)/, "api status line");
    assert.doesNotMatch(text, /unreachable/, "no unreachable service");
  });

  it("shows the running versions of web and api", async () => {
    const text = await home();
    const section = text.split("Phiên bản đang chạy")[1];
    assert.ok(section !== undefined, 'heading "Phiên bản đang chạy" is present');
    assert.match(section, new RegExp(`web: ${VERSION_TEXT}`), "web version");
    assert.match(section, new RegExp(`api: ${VERSION_TEXT}`), "api version");
  });
});
