import assert from "node:assert/strict";
import test from "node:test";
import {
  MOBILE_EVENT_STREAM_ROUTE,
  isReplayableRelaySessionMutation,
} from "../src/mobile-routes.ts";

test("mobile event stream route carries the transient and metrics scopes", () => {
  assert.equal(MOBILE_EVENT_STREAM_ROUTE, "/api/events?aiSessionTransient=1&resourceMetricsScope=1");
});

test("only idempotent Relay bootstrap and confirm requests are replayable", () => {
  const idempotent = { "Idempotency-Key": "relay_retry_123456" };
  assert.equal(isReplayableRelaySessionMutation("POST", "/api/v1/relay-sessions/bootstrap", idempotent), true);
  assert.equal(isReplayableRelaySessionMutation("POST", "/api/v1/relay-selections/selection_a/confirm", new Headers(idempotent)), true);
  assert.equal(isReplayableRelaySessionMutation("POST", "/api/v1/relay-sessions/session_a/renew", idempotent), false);
  assert.equal(isReplayableRelaySessionMutation("POST", "/api/v1/relay-sessions/bootstrap"), false);
  assert.equal(isReplayableRelaySessionMutation("PATCH", "/api/v1/relay-sessions/bootstrap", idempotent), false);
  assert.equal(isReplayableRelaySessionMutation("POST", "/api/v1/account/password", idempotent), false);
});
