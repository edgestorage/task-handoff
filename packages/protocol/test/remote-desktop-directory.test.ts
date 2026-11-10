import assert from "node:assert/strict";
import test from "node:test";

import {
  ControlPlaneInstanceDirectoryCapabilitiesSchema,
  directoryRemoteDesktopCapabilities,
  supportsDirectoryRemoteDesktop,
} from "../src/control-plane-directory.ts";
import {
  parseRemoteDesktopRelayPath,
  remoteDesktopRelaySubprotocol,
  unsupportedRemoteDesktopCapabilities,
} from "../src/remote-desktop.ts";

test("directory remote desktop capability is additive and N-1 safe", () => {
  assert.equal(directoryRemoteDesktopCapabilities(undefined), undefined);
  assert.equal(supportsDirectoryRemoteDesktop({ aiSessionTimeline: {}, future: "ignored" }), false);
  assert.equal(ControlPlaneInstanceDirectoryCapabilitiesSchema.parse({}).remoteDesktop, undefined);
});

test("directory remote desktop keeps a usable capability while ignoring future fields", () => {
  const capability = {
    ...unsupportedRemoteDesktopCapabilities(),
    available: true,
    status: "ready",
    platform: "linux",
    futureCodec: "h266",
  };
  const parsed = ControlPlaneInstanceDirectoryCapabilitiesSchema.parse({ remoteDesktop: capability, futureDocument: true });
  assert.equal(parsed.remoteDesktop?.available, true);
  assert.equal(parsed.remoteDesktop?.platform, "linux");
  assert.equal(parsed.remoteDesktop && "futureCodec" in parsed.remoteDesktop, false);
});

test("a malformed directory remote desktop document disables only this domain", () => {
  const parsed = ControlPlaneInstanceDirectoryCapabilitiesSchema.parse({
    browserTunnel: true,
    remoteDesktop: { available: "yes" },
  });
  assert.equal(parsed.browserTunnel, true);
  assert.equal(parsed.remoteDesktop?.available, false);
  assert.equal(parsed.remoteDesktop?.reason, "REMOTE_DESKTOP_UNSUPPORTED");
  assert.equal(supportsDirectoryRemoteDesktop({ remoteDesktop: { available: "yes" } }), false);
});

test("relay desktop paths are restricted to one-time signal and fallback WebSockets", () => {
  const signal = parseRemoteDesktopRelayPath("/api/controlled-instances/inst_a/remote-desktop-sessions/rdv_a/signal?ticket=ticket_a");
  assert.deepEqual(signal, { kind: "signal", instanceId: "inst_a", sessionId: "rdv_a", ticket: "ticket_a" });
  assert.equal(remoteDesktopRelaySubprotocol(signal!), "taskhandoff.remote-desktop.2026-11-05");
  const fallback = parseRemoteDesktopRelayPath("/api/controlled-instances/inst_a/remote-desktop-sessions/rdv_a/fallback/media?ticket=ticket_a");
  assert.deepEqual(fallback, { kind: "fallback", instanceId: "inst_a", sessionId: "rdv_a", role: "media", ticket: "ticket_a" });
  assert.equal(remoteDesktopRelaySubprotocol(fallback!), "taskhandoff.remote-desktop.fallback.media.v1");
  for (const value of [
    "https://control-plane.example/api/controlled-instances/inst_a/remote-desktop-sessions/rdv_a/signal?ticket=ticket_a",
    "//control-plane.example/api/controlled-instances/inst_a/remote-desktop-sessions/rdv_a/signal?ticket=ticket_a",
    "/api/controlled-instances/inst_a/remote-desktop-sessions/rdv_a/signal",
    "/api/controlled-instances/inst_a/remote-desktop-sessions/rdv_a/signal?ticket=a&ticket=b",
    "/api/controlled-instances/inst_a/remote-desktop-sessions/rdv_a/signal?ticket=a&path=/api/health",
    "/api/controlled-instances/inst_a/remote-desktop-sessions/rdv_a/fallback/input?ticket=a",
    "/api/controlled-instances/inst%2Fa/remote-desktop-sessions/rdv_a/signal?ticket=a",
    "/api/health?ticket=a",
  ]) assert.equal(parseRemoteDesktopRelayPath(value), undefined, value);
});
