import assert from "node:assert/strict";
import test from "node:test";
import { browserFailureTarget, browserLoadFailureKey, isBrowserPageLoadFailure } from "../src/apps/control-plane/instance-detail/browserLoadFailure.ts";

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

test("subframe cancellations and aborted navigations do not replace the page with an error", () => {
  assert.equal(isBrowserPageLoadFailure({ isMainFrame: false, errorCode: -3, validatedURL: "about://srcdoc" }), false);
  assert.equal(isBrowserPageLoadFailure({ isMainFrame: false, errorCode: -105, validatedURL: "https://example.com/frame" }), false);
  assert.equal(isBrowserPageLoadFailure({ isMainFrame: true, errorCode: -3, validatedURL: "https://challenges.cloudflare.com/" }), false);
  assert.equal(isBrowserPageLoadFailure({ isMainFrame: true, errorCode: -105, validatedURL: "about:srcdoc" }), false);
  assert.equal(isBrowserPageLoadFailure({ isMainFrame: true, errorCode: -105, validatedURL: "https://missing.example/" }), true);
});
