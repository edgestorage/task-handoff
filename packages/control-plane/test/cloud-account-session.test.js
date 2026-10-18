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

test("a delivery-failed request clears pending and exposes a retryable failure", () => {
  const dir = tempDir();
  const now = Date.parse("2026-08-10T00:00:00Z");
  const service = new CloudAccountSessionService({ statePath: path.join(dir, "session.json"), serviceOrigin: "https://cloud.example.test", clock: () => now });
  service.init();
  service.beginRequest({ requestId: "request_a", authorizationUrl: "https://cloud.example.test/authorize/control-plane?request=request_a", scope: "account:sign-in", expiresAt: ISO(now + 60_000) });

  const failed = service.resolveRequest({ requestId: "request_a", status: "delivery-failed", errorCode: "CONTROL_PLANE_DELIVERY_FAILED" });
  assert.equal(failed.pendingRequest, undefined);
  assert.deepEqual(failed.requestFailure, { requestId: "request_a", scope: "account:sign-in", code: "CONTROL_PLANE_DELIVERY_FAILED" });
  assert.equal(service.hasPendingRequest(), false);

  service.beginRequest({ requestId: "request_b", authorizationUrl: "https://cloud.example.test/authorize/control-plane?request=request_b", scope: "account:sign-in", expiresAt: ISO(now + 60_000) });
  assert.equal(service.snapshot().requestFailure, undefined);
});

function runtimeHarness({ fetchImpl, accountRenewalIntervalMs, accountRequestPollMs, bindingId, pendingRevocation = false, rejectCredentialRegistration = false } = {}) {
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
      if (message.type === "register" && rejectCredentialRegistration && message.backgroundCredential) queueMicrotask(() => this.close(1008, "BACKGROUND_CREDENTIAL_INVALID"));
      else if (message.type === "register") queueMicrotask(() => this.emit("message", { toString: () => JSON.stringify({ type: "registered", controlPlaneId: "control_plane_test", reportedControlPlaneId: "control_plane_test", leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }) }));
    }
    close(code, reason) { this.readyState = 3; queueMicrotask(() => this.emit("close", code, reason)); }
    emit(event, ...args) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args); }
    receive(value) { this.emit("message", { toString: () => JSON.stringify(value) }); }
    respond(requestId, data) { this.receive({ type: "response", requestId, data }); }
  }
  const identity = { publicIdentity: () => ({ controlPlaneId: "control_plane_test", publicKey: "key", fingerprint: "sha256:fingerprint" }), signCloudOutboundRegistration: () => "signature" };
  let status = pendingRevocation ? "pending-revocation" : bindingId ? "active" : "unbound";
  let currentBindingId = bindingId;
  const state = {
    snapshot: () => ({
      status,
      scopes: status === "pending-revocation" ? { deviceAccess: false, nodeRelay: false } : { deviceAccess: true, nodeRelay: Boolean(currentBindingId) },
      remoteAccessEnabled: status !== "pending-revocation",
      serviceOrigin: "https://cloud.example.test",
      identity: identity.publicIdentity(),
      ...(currentBindingId ? { accountId: "account_a", bindingId: currentBindingId, bindingRevision: 1 } : {}),
    }),
    backgroundCredential: () => status === "active" && currentBindingId ? "c".repeat(43) : undefined,
    revocationCredential: () => status === "pending-revocation" && currentBindingId ? "c".repeat(43) : undefined,
    confirmRevocation: () => { status = "unbound"; currentBindingId = undefined; return state.snapshot(); },
    nextConnectionEpoch: () => 1,
    activate: () => ({ status: "active" }), consumeChallenge: () => ({ challengeId: "challenge_a" }),
    setCloudControlPlaneId: () => undefined,
  };
  const runtime = new CloudConnectivityBackgroundRuntime({
    state, accountSession, identity, webSocket: FakeSocket, accountRenewalIntervalMs, accountRequestPollMs,
    fetch: async (url, init) => { fetchCalls.push({ url, body: JSON.parse(init.body) }); return fetchImpl ? fetchImpl(url, init) : { ok: false, status: 500 }; },
  });
  runtime.start();
  return { runtime, accountSession, sockets, fetchCalls, state };
}

test("a pending revocation reconnects, revokes remotely and re-registers unbound for sign-in", async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { runtime, sockets, state } = runtimeHarness({ bindingId: "binding_a", pendingRevocation: true });

  for (let attempt = 0; attempt < 100 && !sockets[0]?.sent?.some((message) => message.operation === "revoke-binding"); attempt += 1) await wait(5);
  const firstRegister = sockets[0].sent.find((message) => message.type === "register");
  assert.equal(firstRegister.registration.bindingId, "binding_a");
  assert.equal(firstRegister.backgroundCredential, "c".repeat(43));

  const revoke = sockets[0].sent.find((message) => message.operation === "revoke-binding");
  assert.ok(revoke, "pending revocation must use the retained credential to reconnect");
  sockets[0].respond(revoke.requestId, { status: "revoked" });
  for (let attempt = 0; attempt < 100 && state.snapshot().status !== "unbound"; attempt += 1) await wait(5);
  assert.equal(state.snapshot().status, "unbound");

  const created = runtime.beginAccountRequest({ scope: "account:sign-in" });
  for (let attempt = 0; attempt < 100 && sockets.length < 2; attempt += 1) await wait(5);
  assert.equal(sockets.length, 2, "the bound socket must be replaced by an unbound one");
  const secondRegister = sockets[1].sent.find((message) => message.type === "register");
  assert.equal(secondRegister.registration.bindingId, undefined);
  assert.equal(secondRegister.backgroundCredential, undefined);
  const create = sockets[1].sent.find((message) => message.operation === "create-control-plane-request");
  assert.ok(create, "sign-in must be possible after the pending revocation is completed");
  sockets[1].respond(create.requestId, { requestId: "request_a", scope: "account:sign-in", expiresAt: new Date(Date.now() + 900_000).toISOString(), authorizationUrl: "https://cloud.example.test/authorize/control-plane?request=request_a" });
  assert.equal((await created).requestId, "request_a");
  await runtime.stop();
});

test("a pending revocation confirms locally when the revoked credential is rejected", async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { runtime, sockets, state } = runtimeHarness({ bindingId: "binding_a", pendingRevocation: true, rejectCredentialRegistration: true });

  for (let attempt = 0; attempt < 100 && state.snapshot().status !== "unbound"; attempt += 1) await wait(5);
  assert.equal(state.snapshot().status, "unbound");
  assert.equal(sockets.length, 2);
  const firstRegister = sockets[0].sent.find((message) => message.type === "register");
  const secondRegister = sockets[1].sent.find((message) => message.type === "register");
  assert.equal(firstRegister.backgroundCredential, "c".repeat(43));
  assert.equal(secondRegister.backgroundCredential, undefined);
  assert.equal(secondRegister.registration.bindingId, undefined);
  await runtime.stop();
});

test("node relay RPCs carry the active Control Plane binding", async () => {
  const { runtime, sockets } = runtimeHarness({ bindingId: "binding_a" });
  await new Promise((resolve) => setImmediate(resolve));
  const cases = [
    ["issue-node-relay-binding-token", () => runtime.issueNodeBindingToken({ displayName: "Test node" }), { tokenId: "token_a", expiresAt: new Date(Date.now() + 60_000).toISOString(), command: "cloud-bind" }],
    ["cancel-node-relay-binding-token", () => runtime.cancelNodeBindingToken("token_a"), { tokenId: "token_a", cancelled: true }],
    ["claim-node-relay-node", () => runtime.claimAccountNode("node_a"), { status: "pending" }],
    ["revoke-node-relay-claim", () => runtime.revokeAccountNodeClaim("node_a"), { revoked: true }],
  ];
  for (const [operation, call, response] of cases) {
    const pending = call();
    await new Promise((resolve) => setImmediate(resolve));
    const request = sockets[0].sent.filter((message) => message.type === "request" && message.operation === operation).at(-1);
    assert.ok(request, `missing ${operation} request`);
    assert.equal(request.payload.bindingId, "binding_a");
    sockets[0].respond(request.requestId, response);
    await pending;
  }
});

test("publishing an already-managed node omits the onboarding auto-claim hint", async () => {
  const { runtime, sockets } = runtimeHarness({ bindingId: "binding_a" });
  await new Promise((resolve) => setImmediate(resolve));
  const response = { tokenId: "token_a", expiresAt: new Date(Date.now() + 60_000).toISOString(), command: "cloud-bind" };

  const published = runtime.issueNodeBindingToken({ displayName: "Local Node", onboarding: false });
  await new Promise((resolve) => setImmediate(resolve));
  const publishRequest = sockets[0].sent.filter((message) => message.type === "request" && message.operation === "issue-node-relay-binding-token").at(-1);
  assert.equal(publishRequest.payload.onboarding, false);
  sockets[0].respond(publishRequest.requestId, response);
  await published;

  const installed = runtime.issueNodeBindingToken({ displayName: "New Node" });
  await new Promise((resolve) => setImmediate(resolve));
  const installRequest = sockets[0].sent.filter((message) => message.type === "request" && message.operation === "issue-node-relay-binding-token").at(-1);
  assert.equal(installRequest.payload.onboarding, true);
  sockets[0].respond(installRequest.requestId, response);
  await installed;
  await runtime.stop();
});

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

test("the runtime makes a delivery-failed authorization retryable", async () => {
  const { runtime, accountSession, sockets } = runtimeHarness({ accountRequestPollMs: 5 });
  void runtime.beginAccountRequest({ scope: "account:sign-in" }).catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  const create = sockets[0].sent.find((message) => message.type === "request" && message.operation === "create-control-plane-request");
  sockets[0].respond(create.requestId, { requestId: "request_a", scope: "account:sign-in", expiresAt: new Date(Date.now() + 900_000).toISOString(), authorizationUrl: "https://cloud.example.test/authorize/control-plane?request=request_a" });

  let poll;
  for (let attempt = 0; attempt < 100 && !poll; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    poll = sockets[0].sent.find((message) => message.type === "request" && message.operation === "poll-control-plane-request");
  }
  assert.ok(poll, "missing delivery-failed poll");
  sockets[0].respond(poll.requestId, { requestId: "request_a", scope: "account:sign-in", status: "delivery-failed", errorCode: "CONTROL_PLANE_DELIVERY_FAILED" });
  for (let attempt = 0; attempt < 100 && !accountSession.snapshot().requestFailure; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(accountSession.pendingRequest(), undefined);
  assert.deepEqual(accountSession.snapshot().requestFailure, { requestId: "request_a", scope: "account:sign-in", code: "CONTROL_PLANE_DELIVERY_FAILED" });
});

test("concurrent credential refreshes share one rotation and read the official response envelope", async () => {
  const { runtime, accountSession, fetchCalls } = runtimeHarness({
    fetchImpl: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); return { ok: true, status: 200, json: async () => ({ data: { accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"b".repeat(40)}`, accessToken: "access_token_value", accessExpiresIn: 300, sessionExpiresAt: "2026-09-09T00:00:00.000Z" } }) }; },
  });
  accountSession.complete({ accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"a".repeat(40)}`, email: "owner@example.test" });
  await Promise.all([runtime.refreshAccountCredential(), runtime.refreshAccountCredential(), runtime.refreshAccountCredential()]);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://cloud.example.test/api/v1/auth/refresh");
  assert.equal(fetchCalls[0].body.deviceSessionId, "control_plane_session_a");
  assert.equal(accountSession.refreshCredential(), `${"b".repeat(40)}`);
  assert.equal(accountSession.snapshot().signedIn, true);
  assert.equal(accountSession.snapshot().email, "owner@example.test");
  assert.equal(accountSession.snapshot().sessionExpiresAt, "2026-09-09T00:00:00.000Z");
});

test("a rotation response without a session expiry keeps the stored one", async () => {
  const { runtime, accountSession } = runtimeHarness({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: { accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"b".repeat(40)}`, accessExpiresIn: 300 } }) }),
  });
  accountSession.complete({ accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"a".repeat(40)}`, sessionExpiresAt: "2026-09-01T00:00:00.000Z" });
  await runtime.refreshAccountCredential();
  assert.equal(accountSession.refreshCredential(), `${"b".repeat(40)}`);
  assert.equal(accountSession.snapshot().sessionExpiresAt, "2026-09-01T00:00:00.000Z");
});

test("the runtime renews the account credential on its timer and adopts the new expiry", async () => {
  const { accountSession, fetchCalls } = runtimeHarness({
    accountRenewalIntervalMs: 5,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: { accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"b".repeat(40)}`, accessToken: "access_token_value", accessExpiresIn: 300, sessionExpiresAt: "2026-10-01T00:00:00.000Z" } }) }),
  });
  accountSession.complete({ accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"a".repeat(40)}`, sessionExpiresAt: "2026-09-01T00:00:00.000Z" });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 0; attempt < 100 && accountSession.snapshot().sessionExpiresAt !== "2026-10-01T00:00:00.000Z"; attempt += 1) await wait(10);
  assert.equal(fetchCalls.length > 0, true);
  assert.equal(accountSession.snapshot().sessionExpiresAt, "2026-10-01T00:00:00.000Z");
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
  assert.equal(accountSession.snapshot().reauthRequired, true);
  assert.equal(accountSession.refreshCredential(), undefined);

  accountSession.complete({ accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"c".repeat(40)}` });
  assert.equal(accountSession.snapshot().reauthRequired, undefined);
});

test("a lapsed stored session is signed out by the next renewal attempt", async () => {
  const { runtime, accountSession, fetchCalls } = runtimeHarness({ fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { code: "REFRESH_INVALID" } }) }) });
  accountSession.complete({ accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"a".repeat(40)}`, sessionExpiresAt: "2026-08-01T00:00:00.000Z" });
  // Renewal cannot revive a window that already lapsed: the cloud refuses it and the client signs out.
  runtime.start();
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 0; attempt < 100 && accountSession.snapshot().signedIn; attempt += 1) await wait(10);
  assert.equal(fetchCalls.length > 0, true);
  assert.equal(accountSession.snapshot().signedIn, false);
});

test("a transient refresh failure keeps the local session", async () => {
  const { runtime, accountSession } = runtimeHarness({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: { code: "OFFICIAL_DATABASE_UNAVAILABLE" } }) }) });
  accountSession.complete({ accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"a".repeat(40)}` });
  await runtime.refreshAccountCredential();
  assert.equal(accountSession.snapshot().signedIn, true);
  assert.equal(accountSession.snapshot().reauthRequired, undefined);
  assert.equal(accountSession.refreshCredential(), `${"a".repeat(40)}`);
});

test("an unreachable cloud keeps the local session", async () => {
  const { runtime, accountSession } = runtimeHarness({ fetchImpl: async () => { throw new Error("network down"); } });
  accountSession.complete({ accountId: "account_a", deviceSessionId: "control_plane_session_a", refreshCredential: `${"a".repeat(40)}` });
  await runtime.refreshAccountCredential();
  assert.equal(accountSession.snapshot().signedIn, true);
});
