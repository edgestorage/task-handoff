import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../src/apps/control-plane/useControlPlaneEvents.ts", import.meta.url), "utf8");
const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");

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
  assert.match(source, /watch\(\(\) => JSON\.stringify\(toValue\(input\.resourceMetricInstanceIds \|\| \[\]\)\)[\s\S]*?sendSubscription\(socket\);/);
  assert.doesNotMatch(source, /replaySince[\s\S]{0,320}invalidateQueries/);
  assert.doesNotMatch(source, /messageDeltas: \{ allInstances: true/);
});

test("new Control Plane clients advertise precise transient subscription support in the socket URL", () => {
  assert.match(source, /url\.searchParams\.set\("aiSessionTransient", "1"\)/);
  assert.match(source, /url\.searchParams\.set\("resourceMetricsScope", "1"\)/);
});

test("Control Plane events keep the existing socket active in both directions", () => {
  assert.match(source, /startKeepalive\(current\)/);
  assert.match(source, /setInterval\([\s\S]*type: "ping"[\s\S]*20_000/);
  assert.match(source, /EventKeepalivePongSchema\.safeParse\(message\)\.success/);
  assert.match(source, /current\.addEventListener\("close",[\s\S]*stopKeepalive\(\)/);
  assert.match(source, /onBeforeUnmount\([\s\S]*stopKeepalive\(\)/);
});

test("fleet diagnostics are consumed locally while semantic content changes recover authoritative queries", () => {
  const handler = source.match(/if \(event\.type === "node\.fleet\.updated"\)[\s\S]*?\n    \}/)?.[0] || "";
  assert.match(handler, /applyNodeFleetState\(queryClient, state\.data\)/);
  assert.match(handler, /return state\.data\.contentChanged === false/);
});

test("current node connection events converge one cached node and legacy payloads retain query recovery", () => {
  const handler = source.match(/if \(event\.type === "node\.connection\.updated"[\s\S]*?\n    \}/)?.[0] || "";
  assert.match(handler, /NodeStateProjectionEventSchema/);
  assert.match(handler, /applyNodeStateProjection\(queryClient, state\.data\)/);
  assert.match(handler, /state\.success \?/);
});

test("AI and App Session operation receipts do not invalidate the instance board", () => {
  assert.match(source, /event\.type\?\.startsWith\("instance\.ai-session\."\)/);
  assert.match(source, /event\.type\?\.startsWith\("instance\.app-session\."\)/);
});

test("the session stream starts only after both initial authoritative snapshots settle", () => {
  assert.match(workbench, /const sessionEventsEnabled = computed\(\(\) => sessionQueriesEnabled\.value[\s\S]*!controlPlaneAiSessions\.isPending\.value[\s\S]*!controlPlaneAppSessions\.isPending\.value\)/);
  assert.match(workbench, /useControlPlaneEvents\(\{[\s\S]*enabled: sessionEventsEnabled/);
});

test("connecting fallback recovers each target instance without refetching the global board", () => {
  assert.match(workbench, /fetchInstanceBoardPayload\(undefined, instanceId\)/);
  assert.match(workbench, /applyInstanceBoardTargetSnapshot/);
  assert.doesNotMatch(workbench, /connectingRefreshTimer[\s\S]{0,500}refetchQueries/);
});
