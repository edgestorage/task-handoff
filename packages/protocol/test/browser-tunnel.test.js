import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  BROWSER_TUNNEL_INITIAL_WINDOW_BYTES,
  BROWSER_TUNNEL_MAX_DATA_BYTES,
  BROWSER_TUNNEL_PROTOCOL_VERSION,
  BrowserTunnelFrameType,
  decodeBrowserTunnelFrame,
  decodeBrowserTunnelOpen,
  decodeBrowserTunnelWindowUpdate,
  encodeBrowserTunnelFrame,
  encodeBrowserTunnelHello,
  encodeBrowserTunnelOpen,
  encodeBrowserTunnelWindowUpdate,
} from "../src/browser-tunnel.ts";
import { normalizeControlledInstanceCapabilities, supportsBrowserTunnel } from "../src/control-plane.ts";
import { ControlPlaneInstanceDirectoryCapabilitiesSchema, supportsDirectoryBrowserTunnel } from "../src/control-plane-directory.ts";

test("browser tunnel protocol uses a date-only independent version", () => {
  assert.match(BROWSER_TUNNEL_PROTOCOL_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(JSON.parse(encodeBrowserTunnelHello()).initialWindowBytes, BROWSER_TUNNEL_INITIAL_WINDOW_BYTES);
});

test("browser tunnel frames preserve binary data and strict lengths", () => {
  const encoded = encodeBrowserTunnelFrame({ type: BrowserTunnelFrameType.Data, streamId: 7, payload: Buffer.from([0, 1, 255]) });
  assert.deepEqual(decodeBrowserTunnelFrame(encoded), { type: BrowserTunnelFrameType.Data, streamId: 7, payload: Buffer.from([0, 1, 255]) });
  assert.throws(() => decodeBrowserTunnelFrame(encoded.subarray(0, -1)), /length is invalid/);
  assert.throws(() => encodeBrowserTunnelFrame({ type: BrowserTunnelFrameType.Data, streamId: 1, payload: Buffer.alloc(BROWSER_TUNNEL_MAX_DATA_BYTES + 1) }), /exceeds/);
});

test("browser tunnel validates open targets and credit windows", () => {
  const open = decodeBrowserTunnelFrame(encodeBrowserTunnelOpen(9, { host: "127.0.0.1", port: 3000 }));
  assert.deepEqual(decodeBrowserTunnelOpen(open), { host: "127.0.0.1", port: 3000 });
  assert.throws(() => encodeBrowserTunnelOpen(9, { host: "https://other", port: 443 }), /hostname/);
  const update = decodeBrowserTunnelFrame(encodeBrowserTunnelWindowUpdate(9, 4096));
  assert.equal(decodeBrowserTunnelWindowUpdate(update), 4096);
  assert.throws(() => encodeBrowserTunnelWindowUpdate(9, 0), /invalid/);
});

test("browser tunnel capability sanitizes N-1 and unknown documents", () => {
  assert.equal(supportsBrowserTunnel(undefined), false);
  assert.equal(supportsBrowserTunnel({ features: { browserTunnel: true, future: "ignored" }, futureDocument: true }), true);
  assert.equal(supportsBrowserTunnel({ features: { browserTunnel: "yes" } }), false);
  assert.equal(normalizeControlledInstanceCapabilities({ features: { browserTunnel: true } }).features.browserTunnel, true);
});

test("mobile directory browser capability is additive and N-1 safe", () => {
  assert.equal(supportsDirectoryBrowserTunnel(undefined), false);
  assert.equal(supportsDirectoryBrowserTunnel({ aiSessionTimeline: {}, browserTunnel: true, future: "ignored" }), true);
  assert.equal(supportsDirectoryBrowserTunnel({ browserTunnel: "yes" }), false);
  assert.equal(ControlPlaneInstanceDirectoryCapabilitiesSchema.parse({ aiSessionTimeline: {} }).browserTunnel, undefined);
});

test("native Browser Tunnel fixtures match the TypeScript wire authority", () => {
  const fixture = JSON.parse(fs.readFileSync(
    new URL("../../../apps/mobile/modules/task-handoff-browser/shared/browser-tunnel-fixtures.json", import.meta.url),
    "utf8",
  ));
  assert.equal(fixture.protocolVersion, BROWSER_TUNNEL_PROTOCOL_VERSION);
  assert.equal(fixture.limits.initialWindowBytes, BROWSER_TUNNEL_INITIAL_WINDOW_BYTES);
  assert.equal(fixture.frameTypes.Data, BrowserTunnelFrameType.Data);
  assert.equal(fixture.hello, encodeBrowserTunnelHello());
  assert.equal(fixture.vectors.openLocalhost3000, encodeBrowserTunnelOpen(1, { host: "127.0.0.1", port: 3000 }).toString("hex"));
  assert.equal(fixture.vectors.dataStream7, encodeBrowserTunnelFrame({
    type: BrowserTunnelFrameType.Data,
    streamId: 7,
    payload: Buffer.from([0, 1, 255]),
  }).toString("hex"));
  assert.equal(fixture.vectors.windowUpdate4096, encodeBrowserTunnelWindowUpdate(9, 4096).toString("hex"));
});
