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

test("Control Plane events declare list delta demand separately from detail timeline demand", () => {
  assert.match(source, /const messageDeltaDemand = aiSessionMessageDeltaDemand\.value/);
  assert.match(source, /messageDeltas: instanceId[\s\S]*scopedMessageDeltaDemanded \? \[instanceId\] : \[\]/);
  assert.match(source, /timelineSessions: aiSessionTimelineDemand\.value\.filter/);
  assert.match(source, /watch\(\[aiSessionMessageDeltaDemand, aiSessionTimelineDemand, aiSessionTransientReplaySince\]/);
  assert.match(source, /if \(replaySince\) \{[\s\S]*invalidateQueries/);
  assert.doesNotMatch(source, /messageDeltas: \{ allInstances: true/);
});

test("new Control Plane clients advertise precise transient subscription support in the socket URL", () => {
  assert.match(source, /url\.searchParams\.set\("aiSessionTransient", "1"\)/);
});
