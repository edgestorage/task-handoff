import assert from "node:assert/strict";
import test from "node:test";

import { remoteDesktopSignalOriginAllowed } from "../src/control-plane/remote-desktop/signal-origin.ts";

test("secure browser signaling requires the Control Plane origin", () => {
  const base = {
    requestProtocol: "https",
    host: "control.example.com",
    publicBaseUrl: "https://control.example.com",
    allowInsecurePrivateNetwork: false,
  };
  assert.equal(remoteDesktopSignalOriginAllowed({ ...base, origin: "https://control.example.com" }), true);
  assert.equal(remoteDesktopSignalOriginAllowed({ ...base, origin: "https://evil.example.com" }), false);
});

test("authenticated native signaling may omit Origin", () => {
  assert.equal(remoteDesktopSignalOriginAllowed({
    requestProtocol: "https",
    host: "control.example.com",
    publicBaseUrl: "https://control.example.com",
    allowInsecurePrivateNetwork: false,
  }), true);
});

test("private LAN HTTP requires the deployment opt-in and a literal private address", () => {
  const input = {
    requestProtocol: "http",
    host: "192.168.139.109:8081",
    publicBaseUrl: "http://192.168.139.109:8081",
    remoteAddress: "192.168.139.50",
  };
  assert.equal(remoteDesktopSignalOriginAllowed({ ...input, allowInsecurePrivateNetwork: true }), true);
  assert.equal(remoteDesktopSignalOriginAllowed({ ...input, allowInsecurePrivateNetwork: true, origin: "http://192.168.139.109:8081" }), true);
  assert.equal(remoteDesktopSignalOriginAllowed({ ...input, allowInsecurePrivateNetwork: true, origin: "http://evil.example.com" }), false);
  assert.equal(remoteDesktopSignalOriginAllowed({ ...input, allowInsecurePrivateNetwork: false }), false);
  assert.equal(remoteDesktopSignalOriginAllowed({ ...input, allowInsecurePrivateNetwork: true, remoteAddress: "203.0.113.8" }), false);
  assert.equal(remoteDesktopSignalOriginAllowed({ ...input, allowInsecurePrivateNetwork: true, host: "control.local:8081", publicBaseUrl: "http://control.local:8081" }), false);
});

test("loopback signaling remains available without the private LAN opt-in", () => {
  assert.equal(remoteDesktopSignalOriginAllowed({
    requestProtocol: "http",
    host: "127.0.0.1:18082",
    remoteAddress: "127.0.0.1",
    allowInsecurePrivateNetwork: false,
  }), true);
  assert.equal(remoteDesktopSignalOriginAllowed({
    requestProtocol: "http",
    host: "127.0.0.1:18082",
    remoteAddress: "192.168.139.50",
    allowInsecurePrivateNetwork: false,
  }), false);
});
