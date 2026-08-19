import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/apps/control-plane/useControlPlaneEvents.ts", import.meta.url), "utf8");

test("Control Plane events reset reconnect backoff only after the authoritative hello", () => {
  const openHandler = source.match(/current\.addEventListener\("open",[\s\S]*?\n    \}\);/)?.[0] || "";
  const helloHandler = source.match(/if \(message\.type === SessionStreamsHelloEventType\)[\s\S]*?\n        return;/)?.[0] || "";
  assert.doesNotMatch(openHandler, /reconnectBackoff\.reset\(\)/);
  assert.match(helloHandler, /const hello = parsed\.data;[\s\S]*reconnectBackoff\.reset\(\)/);
});
