import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CloudAccountSessionService } from "../src/control-plane/cloud-connectivity/account-session.ts";
import { CloudConnectivityBackgroundRuntime } from "../src/control-plane/cloud-connectivity/coordinator-runtime.ts";

const ISO = (ms) => new Date(ms).toISOString();
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cloud-account-"));

test("an account session belongs to one service origin and a mismatch discards it", () => {
  const dir = tempDir();
  const statePath = path.join(dir, "cloud-account-session.json");
  const now = Date.parse("2026-08-10T00:00:00Z");
  const staging = new CloudAccountSessionService({ statePath, serviceOrigin: "https://th.aaasu.com", clock: () => now });
  staging.init();
  assert.equal(staging.snapshot().signedIn, false);
  assert.equal(staging.snapshot().pendingRequest, undefined);

  const production = new CloudAccountSessionService({ statePath, serviceOrigin: "https://cloud.thandoff.com", clock: () => now });
  production.init();
  assert.equal(production.snapshot().signedIn, false);
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
});

test("a pending request expires and never leaks into a signed-in snapshot", () => {
  const dir = tempDir();
  let now = Date.parse("2026-08-10T00:00:00Z");
  const service = new CloudAccountSessionService({ statePath: path.join(dir, "session.json"), serviceOrigin: "https://cloud.example.test", clock: () => now });
  service.init();
  service.beginRequest({ requestId: "request_a", authorizationUrl: "https://cloud.example.test/authorize/control-plane?request=request_a", scope: "account:sign-in", expiresAt: ISO(now + 60_000) });
  assert.equal(service.hasPendingRequest(), true);
  assert.equal(service.pendingRequest().scope, "account:sign-in");

  now += 120_000;
  const reopened = new CloudAccountSessionService({ statePath: path.join(dir, "session.json"), serviceOrigin: "https://cloud.example.test", clock: () => now });
  reopened.init();
  assert.equal(reopened.hasPendingRequest(), false);
  assert.deepEqual(reopened.snapshot(), { signedIn: false, accountId: undefined, email: undefined, sessionExpiresAt: undefined, pendingRequest: undefined });
});

test("a binding request while signed in keeps the session and resolves back to signed-in", () => {
  const dir = tempDir();
  const now = Date.parse("2026-08-10T00:00:00Z");
  const service = new CloudAccountSessionService({ statePath: path.join(dir, "session.json"), serviceOrigin: "https://cloud.example.test", clock: () => now });
  service.init();
  service.complete({ accountId: "account_a", email: "owner@example.test", deviceSessionId: "session_a", refreshCredential: "a".repeat(40) });
  assert.equal(service.snapshot().signedIn, true);

  service.beginRequest({ requestId: "bind_a", authorizationUrl: "https://cloud.example.test/authorize/control-plane?request=bind_a", scope: "control-plane:bind", expiresAt: ISO(now + 60_000) });
  const pending = service.snapshot();
  assert.equal(pending.signedIn, true);
  assert.equal(pending.pendingRequest.scope, "control-plane:bind");
  assert.equal(service.refreshCredential(), "a".repeat(40));

  service.resolveRequest({ requestId: "bind_a", status: "delivered" });
  const resolved = service.snapshot();
  assert.equal(resolved.signedIn, true);
  assert.equal(resolved.accountId, "account_a");
  assert.equal(resolved.pendingRequest, undefined);
});

function runtimeHarness({ fetchImpl } = {}) {
  const dir = tempDir();
  const accountSession = new CloudAccountSessionService({ statePath: path.join(dir, "session.json"), serviceOrigin: "https://cloud.example.test" });
  accountSession.init();
  const sockets = [];
  const fetchCalls = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = FakeSocket.OPEN;
    listeners = new Map();
    constructor(url) { this.url = url; sockets.push(this); queueMicrotask(() => this.emit("open")); }
    on(event, listener) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); }
    send(data) {
      const message = JSON.parse(data);
      this.sent = [...(this.sent ?? []), message];
      if (message.type === "register") queueMicrotask(() => this.emit("message", { toString: () => JSON.stringify({ type: "registered", controlPlaneId: "control_plane_test" }) }));
    }
    close(code, reason) { this.readyState = 3; queueMicrotask(() => this.emit("close", code, reason)); }
    emit(event, ...args) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args); }
    receive(value) { this.emit("message", { toString: () => JSON.stringify(value) }); }
    respond(requestId, data) { this.receive({ type: "response", requestId, data }); }
  }
  const identity = { publicIdentity: () => ({ controlPlaneId: "control_plane_test", publicKey: "key", fingerprint: "sha256:fingerprint" }), signCloudOutboundRegistration: () => "signature" };
  const state = {
    snapshot: () => ({ status: "unbound", remoteAccessEnabled: true, serviceOrigin: "https://cloud.example.test", identity: identity.publicIdentity() }),
    backgroundCredential: () => undefined, nextConnectionEpoch: () => 1,
    activate: () => ({ status: "active" }), consumeChallenge: () => ({ challengeId: "challenge_a" }),
  };
  const runtime = new CloudConnectivityBackgroundRuntime({
    state, accountSession, identity, webSocket: FakeSocket,
    fetch: async (url, init) => { fetchCalls.push({ url, body: JSON.parse(init.body) }); return fetchImpl ? fetchImpl(url, init) : { ok: false, status: 500 }; },
  });
  runtime.start();
  return { runtime, accountSession, sockets, fetchCalls };
}

test("the runtime records a created request and completes the local session from the delivered credential", async () => {
  const { runtime, accountSession, sockets } = runtimeHarness();
  const created = runtime.beginAccountRequest({ scope: "account:sign-in" });
  await new Promise((resolve) => setImmediate(resolve));
  const request = sockets[0].sent.find((message) => message.type === "request" && message.operation === "create-control-plane-request");
  assert.equal(request.payload.scope, "account:sign-in");
  sockets[0].respond(request.requestId, { requestId: "request_a", scope: "account:sign-in", expiresAt: new Date(Date.now() + 900_000).toISOString(), authorizationUrl: "https://cloud.example.test/authorize/control-plane?request=request_a" });
  assert.equal((await created).requestId, "request_a");
  assert.equal(accountSession.pendingRequest().requestId, "request_a");

  const response = await new Promise((resolve) => {
    const seen = sockets[0].sent.filter((message) => message.type === "response").length;
    const timer = setInterval(() => { const replies = sockets[0].sent.filter((message) => message.type === "response"); if (replies.length > seen) { clearInterval(timer); resolve(replies.at(-1)); } }, 5);
    // Inbound push from the Coordinator.
    sockets[0].receive({ type: "request", requestId: "push_1", operation: "deliver-account-credential", payload: { requestId: "request_a", accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"a".repeat(40)}`, expiresAt: "2026-09-09T00:00:00.000Z", email: "owner@example.test", accessToken: "access_token_value", accessExpiresIn: 300 } });
  });
  assert.equal(response.requestId, "push_1");
  assert.deepEqual(accountSession.snapshot(), { signedIn: true, accountId: "account_a", email: "owner@example.test", sessionExpiresAt: "2026-09-09T00:00:00.000Z", pendingRequest: undefined });
  assert.equal(accountSession.pendingRequest(), undefined);
});

test("concurrent credential refreshes share one rotation and read the official response envelope", async () => {
  const { runtime, accountSession, fetchCalls } = runtimeHarness({
    fetchImpl: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return { ok: true, status: 200, json: async () => ({ data: { accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"b".repeat(40)}`, accessToken: "access_token_value", accessExpiresIn: 300 } }) }; },
  });
  accountSession.complete({ accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"a".repeat(40)}`, email: "owner@example.test" });
  await Promise.all([runtime.refreshAccountCredential(), runtime.refreshAccountCredential(), runtime.refreshAccountCredential()]);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://cloud.example.test/api/v1/auth/refresh");
  assert.equal(fetchCalls[0].body.deviceSessionId, "control_plane_session_a");
  assert.equal(accountSession.refreshCredential(), `${"b".repeat(40)}`);
  assert.equal(accountSession.snapshot().signedIn, true);
  assert.equal(accountSession.snapshot().email, "owner@example.test");
});

test("a delivered credential suppresses the reconnect rotation", async () => {
  const { runtime, accountSession, sockets, fetchCalls } = runtimeHarness();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  void runtime.beginAccountRequest({ scope: "account:sign-in" }).catch(() => undefined);
  await wait(20);
  // The credential the Coordinator just pushed carries a usable access token.
  sockets[0].receive({ type: "request", requestId: "push_1", operation: "deliver-account-credential", payload: { accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"a".repeat(40)}`, accessToken: "access_token_value", accessExpiresIn: 300 } });
  await wait(10);
  assert.equal(accountSession.snapshot().signedIn, true);
  sockets[0].close(1000, "test-restart");
  await wait(10);
  void runtime.beginAccountRequest({ scope: "account:sign-in" }).catch(() => undefined);
  await wait(30);
  assert.equal(fetchCalls.length, 0, "a usable delivered access token must not trigger an immediate rotation");
  assert.equal(accountSession.refreshCredential(), `${"a".repeat(40)}`);
});

test("a replayed refresh credential signs the local session out", async () => {
  const { runtime, accountSession } = runtimeHarness({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { code: "REFRESH_REPLAYED" } }) }) });
  accountSession.complete({ accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"a".repeat(40)}` });
  await runtime.refreshAccountCredential();
  assert.equal(accountSession.snapshot().signedIn, false);
  assert.equal(accountSession.refreshCredential(), undefined);
});

test("a transient refresh failure keeps the local session", async () => {
  const { runtime, accountSession } = runtimeHarness({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: { code: "OFFICIAL_DATABASE_UNAVAILABLE" } }) }) });
  accountSession.complete({ accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"a".repeat(40)}` });
  await runtime.refreshAccountCredential();
  assert.equal(accountSession.snapshot().signedIn, true);
  assert.equal(accountSession.refreshCredential(), `${"a".repeat(40)}`);
});

test("an unreachable cloud keeps the local session", async () => {
  const { runtime, accountSession } = runtimeHarness({ fetchImpl: async () => { throw new Error("network down"); } });
  accountSession.complete({ accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"a".repeat(40)}` });
  await runtime.refreshAccountCredential();
  assert.equal(accountSession.snapshot().signedIn, true);
});
