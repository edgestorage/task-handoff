import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RELAY_SESSION_PROTOCOL_VERSION, RELAY_SESSION_RESUME_CAPABILITY, RelaySessionAudience } from "@task-handoff/cloud-contracts";
import { CloudAccountSessionService } from "../src/control-plane/cloud-connectivity/account-session.ts";
import { CloudConnectivityBackgroundRuntime } from "../src/control-plane/cloud-connectivity/coordinator-runtime.ts";

const ISO = (ms) => new Date(ms).toISOString();
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cloud-account-"));

test("an account session belongs to one service origin and a mismatch discards it", () => {
  const dir = tempDir();
  const statePath = path.join(dir, "cloud-account-session.json");
  const now = Date.parse("2026-08-10T00:00:00Z");
  const staging = new CloudAccountSessionService({ statePath, serviceOrigin: "https://staging.cloud.example.test", clock: () => now });
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

function runtimeHarness({ fetchImpl, accountRenewalIntervalMs, accountRequestPollMs, bindingId, pendingRevocation = false, rejectCredentialRegistration = false, roleCatalog, catalogRevision = 1, runtimeOptions = {} } = {}) {
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
  let currentCatalogRevision = catalogRevision;
  let catalogPublication;
  const state = {
    snapshot: () => ({
      status,
      scopes: status === "pending-revocation" ? { deviceAccess: false, nodeRelay: false } : { deviceAccess: true, nodeRelay: Boolean(currentBindingId) },
      remoteAccessEnabled: status !== "pending-revocation",
      serviceOrigin: "https://cloud.example.test",
      identity: identity.publicIdentity(),
      ...(currentBindingId ? { accountId: "account_a", bindingId: currentBindingId, bindingRevision: 1 } : {}),
      catalogRevision: currentCatalogRevision,
      ...(catalogPublication ? { catalogPublication } : {}),
    }),
    backgroundCredential: () => status === "active" && currentBindingId ? "c".repeat(43) : undefined,
    revocationCredential: () => status === "pending-revocation" && currentBindingId ? "c".repeat(43) : undefined,
    confirmRevocation: () => { status = "unbound"; currentBindingId = undefined; return state.snapshot(); },
    nextConnectionEpoch: () => 1,
    activate: () => ({ status: "active" }), consumeChallenge: () => ({ challengeId: "challenge_a" }),
    setCloudControlPlaneId: (cloudControlPlaneId) => { state.cloudControlPlaneId = cloudControlPlaneId; },
    catalogRevision: () => currentCatalogRevision,
    markCatalogChanged: () => {
      currentCatalogRevision += 1;
      catalogPublication = { status: "pending", revision: currentCatalogRevision };
      return currentCatalogRevision;
    },
    recordCatalogPublication: (input) => {
      catalogPublication = input.errorCode
        ? { status: "failed", revision: input.revision, errorCode: input.errorCode }
        : { status: "published", revision: input.revision, publishedAt: input.publishedAt };
      if (!input.errorCode) currentCatalogRevision = Math.max(currentCatalogRevision, input.revision);
    },
  };
  const runtime = new CloudConnectivityBackgroundRuntime({
    state, accountSession, identity, webSocket: FakeSocket, accountRenewalIntervalMs, accountRequestPollMs,
    roleCatalog,
    cloudRelaySessionsPath: path.join(dir, "cloud-relay-sessions.json"),
    relayConnector: { async connect() { throw new Error("unexpected relay connection"); }, async resume() { throw new Error("unexpected relay resume"); } },
    fetch: async (url, init) => { fetchCalls.push({ url, body: JSON.parse(init.body) }); return fetchImpl ? fetchImpl(url, init) : { ok: false, status: 500 }; },
    ...runtimeOptions,
  });
  runtime.start();
  return { runtime, accountSession, sockets, fetchCalls, state };
}

async function waitFor(predicate, message, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function runtimeRelaySessionGrant(now) {
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 15 * 60_000).toISOString();
  const identity = {
    allocationId: "allocation_rate_limited",
    sessionId: "session_rate_limited",
    relayId: "relay_rate_limited",
    relayUrl: "wss://relay.example.test/connect",
    accountId: "account_a",
    deviceSessionId: "device_a",
    controlPlaneId: "control_plane_test",
    bindingId: "binding_a",
    bindingRevision: 1,
    targetPublicKeyFingerprint: `sha256:${"a".repeat(43)}`,
  };
  const access = { ownerAccountId: identity.accountId, accessMode: "owner", accessRoleId: "role_admin" };
  return {
    protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
    audience: RelaySessionAudience.Grant,
    sessionId: identity.sessionId,
    grantId: "grant_rate_limited_1",
    generation: 1,
    accessTicketId: "access_ticket_rate_limited",
    ...identity,
    relayRegion: "cn-north-test-1",
    clientProofPublicKey: "b".repeat(43),
    controlPlaneProofPublicKey: "c".repeat(43),
    trafficClass: "interactive",
    ...access,
    sessionTranscriptTicket: {
      protocolVersion: RELAY_SESSION_PROTOCOL_VERSION,
      audience: RelaySessionAudience.Transcript,
      transcriptTicketId: "transcript_ticket_rate_limited",
      accountId: identity.accountId,
      deviceSessionId: identity.deviceSessionId,
      controlPlaneId: identity.controlPlaneId,
      bindingId: identity.bindingId,
      bindingRevision: identity.bindingRevision,
      targetPublicKeyFingerprint: identity.targetPublicKeyFingerprint,
      nonce: "transcript-nonce-rate-limited",
      issuedAt,
      expiresAt,
      ...access,
    },
    revocationEpoch: 0,
    issuedAt,
    expiresAt,
    signature: "s".repeat(64),
  };
}

test("Control Plane always advertises resumable Relay sessions", async () => {
  const names = ["TASK_HANDOFF_RELAY_SESSION_RESUME", "FEATURE_RELAY_SESSION_RESUME"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = "0";
  let runtime;
  try {
    const harness = runtimeHarness({ bindingId: "binding_a" });
    runtime = harness.runtime;
    const { sockets } = harness;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let attempt = 0; attempt < 100 && !sockets[0]?.sent?.some((message) => message.type === "register"); attempt += 1) await wait(5);
    const register = sockets[0].sent.find((message) => message.type === "register");
    assert.ok(register, "the bound Control Plane must register with the Coordinator");
    assert.ok(register.registration.capabilities.includes(RELAY_SESSION_RESUME_CAPABILITY));
  } finally {
    await runtime?.stop();
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("an active binding publishes its complete role catalog immediately after registration", async () => {
  const roles = [
    { roleId: "role_admin", name: "Admin", system: true, status: "active" },
    { roleId: "role_custom_reader", name: "Reader", description: "Read-only custom role", system: false, status: "active" },
    { roleId: "role_viewer", name: "Viewer", system: true, status: "archived" },
  ];
  const { runtime, sockets, state } = runtimeHarness({ bindingId: "binding_a", catalogRevision: 4, roleCatalog: async () => roles });
  try {
    const request = await waitFor(
      () => sockets[0]?.sent?.find((message) => message.type === "request" && message.operation === "publish-access-role-catalog"),
      "registration did not publish the role catalog",
    );
    assert.equal(request.payload.bindingId, "binding_a");
    assert.equal(request.payload.catalogRevision, 4);
    assert.deepEqual(request.payload.roles, roles);
    assert.equal(JSON.stringify(request.payload).includes("permissionIds"), false);
    sockets[0].respond(request.requestId, { applied: true, catalogRevision: 4 });
    await waitFor(() => state.snapshot().catalogPublication?.status === "published", "catalog publication was not recorded");
    assert.equal(state.snapshot().catalogPublication.revision, 4);
    assert.equal(state.cloudControlPlaneId, "control_plane_test");
  } finally {
    await runtime.stop();
  }
});

test("a failed catalog publication retries the same revision and a role mutation advances it", async () => {
  let roles = [{ roleId: "role_admin", name: "Admin", system: true, status: "active" }];
  const { runtime, sockets, state } = runtimeHarness({ bindingId: "binding_a", catalogRevision: 3, roleCatalog: async () => roles });
  try {
    const first = await waitFor(
      () => sockets[0]?.sent?.filter((message) => message.operation === "publish-access-role-catalog").at(-1),
      "registration did not start the first catalog publication",
    );
    sockets[0].receive({ type: "response", requestId: first.requestId, error: { code: "CATALOG_REJECTED", message: "catalog rejected" } });
    await waitFor(() => state.snapshot().catalogPublication?.status === "failed", "catalog failure was not recorded");
    assert.deepEqual(state.snapshot().catalogPublication, { status: "failed", revision: 3, errorCode: "CATALOG_REJECTED" });

    const retry = runtime.publishAccessRoleCatalog();
    const retried = await waitFor(
      () => sockets[0].sent.filter((message) => message.operation === "publish-access-role-catalog").at(-1)?.requestId !== first.requestId
        && sockets[0].sent.filter((message) => message.operation === "publish-access-role-catalog").at(-1),
      "catalog retry was not sent",
    );
    assert.equal(retried.payload.catalogRevision, 3);
    sockets[0].respond(retried.requestId, { applied: true, catalogRevision: 3 });
    await retry;
    await waitFor(() => state.snapshot().catalogPublication?.status === "published", "catalog retry was not recorded");

    roles = [...roles, { roleId: "role_custom_reader", name: "Reader", system: false, status: "active" }];
    const changed = runtime.notifyAccessRoleCatalogChanged();
    const next = await waitFor(
      () => sockets[0].sent.filter((message) => message.operation === "publish-access-role-catalog").at(-1)?.payload?.catalogRevision === 4
        && sockets[0].sent.filter((message) => message.operation === "publish-access-role-catalog").at(-1),
      "role mutation was not published",
    );
    assert.deepEqual(next.payload.roles, roles);
    sockets[0].respond(next.requestId, { applied: true, catalogRevision: 4 });
    await changed;
    assert.equal(state.snapshot().catalogRevision, 4);
    assert.equal(state.snapshot().catalogPublication.status, "published");
  } finally {
    await runtime.stop();
  }
});

test("a reconnect republishes the current catalog revision without minting a new one", async () => {
  const roles = [{ roleId: "role_admin", name: "Admin", system: true, status: "active" }];
  const { runtime, sockets } = runtimeHarness({ bindingId: "binding_a", catalogRevision: 7, roleCatalog: async () => roles });
  try {
    const initial = await waitFor(
      () => sockets[0]?.sent?.find((message) => message.operation === "publish-access-role-catalog"),
      "initial registration did not publish the catalog",
    );
    sockets[0].respond(initial.requestId, { applied: true, catalogRevision: 7 });

    sockets[0].close(1006, "network-lost");
    const republished = await waitFor(
      () => sockets[1]?.sent?.find((message) => message.operation === "publish-access-role-catalog"),
      "reconnect did not republish the catalog",
    );
    assert.equal(republished.payload.catalogRevision, 7);
    assert.deepEqual(republished.payload.roles, roles);
    sockets[1].respond(republished.requestId, { applied: true, catalogRevision: 7 });
  } finally {
    await runtime.stop();
  }
});

test("a transient Relay grant failure keeps the control socket connected for data-plane retry", async () => {
  const logs = [];
  let resumeCalls = 0;
  const { runtime, sockets } = runtimeHarness({
    bindingId: "binding_a",
    runtimeOptions: {
      logger: { warn: (entry) => logs.push(entry) },
      verifyRelaySessionGrant: async (input) => ({
        allocationId: input.grant.allocationId,
        relayUrl: input.grant.relayUrl,
        epoch: 1,
        channelKind: "access",
        grant: input.grant,
      }),
      relayConnector: {
        async connect() { throw new Error("unexpected relay connection"); },
        async resume() {
          resumeCalls += 1;
          throw Object.assign(new Error("Unexpected server response: 429"), { statusCode: 429 });
        },
      },
    },
  });
  try {
    await waitFor(() => sockets[0]?.sent?.some((message) => message.type === "register"), "control socket did not register");
    sockets[0].receive({
      type: "event",
      event: {
        type: "relay-session-grant",
        grant: runtimeRelaySessionGrant(Date.now()),
      },
    });
    await waitFor(() => resumeCalls > 0, "Relay grant was not attempted");
    await waitFor(
      () => logs.some((entry) => entry.code === "CLOUD_RELAY_SESSION_APPLY_FAILED" && entry.allocationId === "allocation_rate_limited"),
      "Relay grant failure was not logged",
    );
    assert.equal(sockets[0].readyState, 1);
    assert.equal(sockets.length, 1, "the Control Plane must not reconnect because of a data-plane failure");
  } finally {
    await runtime.stop();
  }
});

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

test("the existing account-node directory advertises sharing before claiming through the unchanged RPC", () => {
  const source = fs.readFileSync(new URL("../src/control-plane/cloud-connectivity/coordinator-runtime.ts", import.meta.url), "utf8");
  assert.match(source, /accountRequest\("\/api\/v1\/nodes"/);
  assert.match(source, /\[RESOURCE_SHARING_CAPABILITY_HEADER\]: RESOURCE_SHARING_CLIENT_CAPABILITY/);
  assert.match(source, /claim-node-relay-node/);
  assert.match(source, /nodeRelayBindingPayload\(\{ nodeHandle \}\)/);
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
