import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function source(path) {
  return fs.readFileSync(new URL(`../src/web/${path}`, import.meta.url), "utf8");
}

test("instance capability reports come from the browser service capabilities", () => {
  const status = source("status.ts");
  const server = source("server.ts");

  assert.match(status, /embeddedBrowserChannel,/);
  assert.match(status, /embeddedBrowserChannel\?: EmbeddedBrowserChannelCapabilities/);
  assert.equal((server.match(/browserControl\.capabilities\(\)/g) || []).length, 3);
});
