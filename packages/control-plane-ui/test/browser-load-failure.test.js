import assert from "node:assert/strict";
import test from "node:test";
import { browserFailureTarget, browserLoadFailureKey } from "../src/apps/control-plane/instance-detail/browserLoadFailure.ts";

test("the tunnel failure code outranks Chromium's coarse SOCKS error", () => {
  assert.equal(
    browserLoadFailureKey({ chromiumCode: -120, tunnelCode: "BROWSER_TUNNEL_CONNECT_FAILED" }),
    "sessions.browser.loadFailedTargetUnavailable",
  );
  assert.equal(
    browserLoadFailureKey({ chromiumCode: -120, tunnelCode: "BROWSER_RELAY_UNAVAILABLE" }),
    "sessions.browser.loadFailedTunnel",
  );
  assert.equal(
    browserLoadFailureKey({ chromiumCode: -120, tunnelCode: "BROWSER_TUNNEL_CONNECT_TIMEOUT" }),
    "sessions.browser.loadFailedTimeout",
  );
});

test("Chromium error codes still produce actionable messages without a tunnel code", () => {
  assert.equal(browserLoadFailureKey({ chromiumCode: -120 }), "sessions.browser.loadFailedTargetUnavailable");
  assert.equal(browserLoadFailureKey({ chromiumCode: -121 }), "sessions.browser.loadFailedTargetUnavailable");
  assert.equal(browserLoadFailureKey({ chromiumCode: -105 }), "sessions.browser.loadFailedDns");
  assert.equal(browserLoadFailureKey({ chromiumCode: -106 }), "sessions.browser.loadFailedOffline");
  assert.equal(browserLoadFailureKey({ chromiumCode: -7 }), "sessions.browser.loadFailedTimeout");
  assert.equal(browserLoadFailureKey({ chromiumCode: -102 }), "sessions.browser.loadFailedTunnel");
  assert.equal(browserLoadFailureKey({}), "sessions.browser.loadFailed");
});

test("failure detail drops query strings and fragments before display", () => {
  assert.equal(browserFailureTarget("http://localhost:8080/admin/relays?token=secret#x"), "http://localhost:8080/admin/relays");
  assert.equal(browserFailureTarget(""), "");
});
