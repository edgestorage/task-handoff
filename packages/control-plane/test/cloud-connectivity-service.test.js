import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlaneIdentityService } from "../src/control-plane/identity/service.ts";
import { CloudConnectivityService } from "../src/control-plane/cloud-connectivity/service.ts";
import { can } from "../src/control-plane/auth/authorization.ts";
import { CloudControlConnectionManager } from "../src/control-plane/cloud-connectivity/connections.ts";
import { CloudConnectivityBackgroundRuntime } from "../src/control-plane/cloud-connectivity/coordinator-runtime.ts";
import { CloudAccountSessionService } from "../src/control-plane/cloud-connectivity/account-session.ts";
import { CloudConnectivityLifecycle } from "../src/control-plane/cloud-connectivity/lifecycle.ts";
import { createControlPlaneApp, trustedCloudCoordinatorOrigins, trustedCloudServiceOrigin } from "../src/control-plane/http/server.ts";
import { resolveCloudEnvironment } from "../../../shared/cloud-environments.cjs";
import { cloudClientTrustOutcomeSigningInput } from "@task-handoff/cloud-contracts";

const PRODUCTION_ENVIRONMENT = resolveCloudEnvironment("production", undefined, {
  TASK_HANDOFF_CLOUD_ENV: "production",
  TASK_HANDOFF_CLOUD_SERVICE_ORIGIN: "https://cloud.example.test",
  TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES: "example.test",
  TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES: "relay.example.test",
});
const STAGING_ENVIRONMENT = resolveCloudEnvironment("staging", undefined, {
  TASK_HANDOFF_CLOUD_ENV: "staging",
  TASK_HANDOFF_CLOUD_SERVICE_ORIGIN: "https://staging.example.test",
  TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES: "staging.example.test",
  TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES: "staging.example.test",
});

function fixture(now = Date.parse("2026-08-10T00:00:00Z")) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-connectivity-"));
  const identity = new ControlPlaneIdentityService(path.join(root, "identity.json"), () => "control_plane_a");
  identity.init();
  const service = new CloudConnectivityService({ statePath: path.join(root, "binding.json"), identity, serviceOrigin: "https://cloud.example.test", clock: () => now });
  service.init();
  return { root, identity, service };
}

test("Control Plane identity is private, stable across restart and has a public fingerprint", () => {
  const { root, identity } = fixture();
  const before = identity.publicIdentity();
  const stored = path.join(root, "identity.json");
  assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
  const restarted = new ControlPlaneIdentityService(stored, () => "control_plane_a");
  restarted.init();
  assert.deepEqual(restarted.publicIdentity(), before);
  assert.doesNotMatch(JSON.stringify(restarted.publicIdentity()), /privateKey/);
});

test("Control Plane identity signs pending device trust outcomes", () => {
  const { identity, service } = fixture();
  service.setCloudControlPlaneId("cp_cloud_a");
  const issuedAt = "2026-08-10T00:00:00.000Z";
  const outcome = identity.signCloudClientTrustOutcome({
    state: "pending",
    reason: "first-seen",
    requestId: "devtrust_a",
    controlPlaneId: "cp_cloud_a",
    bindingId: "binding_a",
    ticketId: "rtt_ticket_a",
    accountId: "account_a",
    deviceSessionId: "device_a",
    device: { name: "Phone", kind: "mobile", platform: "android", version: "1.0.0" },
    devicePublicKeyFingerprint: `sha256:${"a".repeat(43)}`,
    comparisonCode: "ABCD-EFGH-JKMN-NPQR",
    issuedAt,
    expiresAt: "2026-08-11T00:00:00.000Z",
  });
  assert.equal(outcome.state, "pending");
  assert.equal(outcome.controlPlaneId, "cp_cloud_a");
  assert.equal(crypto.verify(
    null,
    Buffer.from(cloudClientTrustOutcomeSigningInput(outcome)),
    crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: outcome.controlPlanePublicKey }, format: "jwk" }),
    Buffer.from(outcome.signature, "base64url"),
  ), true);
});

test("cloud identity is persisted separately from the local Control Plane identity", () => {
  const { root, identity, service } = fixture();
  service.setCloudControlPlaneId("cp_cloud_a");
  assert.equal(service.snapshot().identity.controlPlaneId, "control_plane_a");
  assert.equal(service.snapshot().cloudControlPlaneId, "cp_cloud_a");
  const restarted = new CloudConnectivityService({ statePath: path.join(root, "binding.json"), identity, serviceOrigin: "https://cloud.example.test" });
  restarted.init();
  assert.equal(restarted.cloudControlPlaneId(), "cp_cloud_a");
});

test("N-1 node-relay state migrates to the binding-derived value", () => {
  const { root, identity } = fixture();
  const statePath = path.join(root, "binding.json");
  const stored = JSON.parse(fs.readFileSync(statePath, "utf8"));
  fs.writeFileSync(statePath, JSON.stringify({
    ...stored,
    status: "active",
    accountId: "account_a",
    bindingId: "binding_a",
    bindingRevision: 1,
    backgroundCredential: "c".repeat(43),
    scopes: { deviceAccess: false, nodeRelay: false },
  }));
  const restarted = new CloudConnectivityService({ statePath, identity, serviceOrigin: "https://cloud.example.test" });
  restarted.init();
  assert.deepEqual(restarted.snapshot().scopes, { deviceAccess: false, nodeRelay: true });
  assert.equal(restarted.backgroundCredential(), "c".repeat(43), "device access being off must not stop node claims");
});

test("role catalog revision is monotonic, persisted, and keeps publication failures retryable", () => {
  const { root, identity, service } = fixture();
  assert.equal(service.catalogRevision(), 1);
  assert.equal(service.catalogPublication(), undefined);

  const first = service.markCatalogChanged();
  assert.equal(first, 2);
  assert.deepEqual(service.catalogPublication(), { status: "pending", revision: 2 });
  service.recordCatalogPublication({ revision: first, errorCode: "CATALOG_UNAVAILABLE" });
  assert.deepEqual(service.catalogPublication(), { status: "failed", revision: 2, errorCode: "CATALOG_UNAVAILABLE" });
  assert.equal(service.catalogRevision(), 2);

  service.recordCatalogPublication({ revision: first, publishedAt: "2026-08-10T00:00:01.000Z" });
  assert.deepEqual(service.catalogPublication(), { status: "published", revision: 2, publishedAt: "2026-08-10T00:00:01.000Z" });
  assert.equal(service.markCatalogChanged(), 3);

  const restarted = new CloudConnectivityService({ statePath: path.join(root, "binding.json"), identity, serviceOrigin: "https://cloud.example.test" });
  restarted.init();
  assert.equal(restarted.catalogRevision(), 3);
  assert.deepEqual(restarted.catalogPublication(), { status: "pending", revision: 3 });
});

test("binding challenge is target-bound, one-time, memory-only and restart-invalidated", () => {
  const { root, identity, service } = fixture();
  const issued = service.createChallenge();
  const hostname = os.hostname().trim().slice(0, 160);
  assert.equal(issued.payload.hostname, hostname || undefined);
  assert.equal(new URL(issued.authorizationUrl).search, "");
  assert.doesNotMatch(fs.readFileSync(path.join(root, "binding.json"), "utf8"), new RegExp(issued.challengeCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.throws(() => service.consumeChallenge({ challengeCode: issued.challengeCode, controlPlaneId: "control_plane_b", fingerprint: issued.payload.publicKeyFingerprint }), { code: "BINDING_IDENTITY_CONFLICT" });
  assert.throws(() => service.consumeChallenge({ challengeCode: issued.challengeCode, controlPlaneId: "control_plane_a", fingerprint: issued.payload.publicKeyFingerprint }), { code: "BINDING_CHALLENGE_INVALID_OR_CONSUMED" });

  const after = service.createChallenge();
  const restarted = new CloudConnectivityService({ statePath: path.join(root, "binding.json"), identity, serviceOrigin: "https://cloud.example.test" });
  restarted.init();
  assert.throws(() => restarted.consumeChallenge({ challengeCode: after.challengeCode, controlPlaneId: "control_plane_a", fingerprint: after.payload.publicKeyFingerprint }), { code: "BINDING_CHALLENGE_INVALID_OR_CONSUMED" });
});

test("local state enforces one active account, idempotency and revoke-before-switch", () => {
  const { service } = fixture();
  service.setCloudControlPlaneId("cp_cloud_a");
  const challenge = service.createChallenge();
  service.consumeChallenge({ challengeCode: challenge.challengeCode, controlPlaneId: challenge.payload.controlPlaneId, fingerprint: challenge.payload.publicKeyFingerprint });
  service.activate({ accountId: "account_a", bindingId: "binding_a", bindingRevision: 1, backgroundCredential: "c".repeat(43) });
  assert.equal(service.backgroundCredential(), "c".repeat(43));
  assert.throws(() => service.activate({ accountId: "account_b", bindingId: "binding_b", bindingRevision: 1, backgroundCredential: "d".repeat(43) }), { code: "CONTROL_PLANE_ALREADY_BOUND" });
  service.beginRevocation();
  assert.equal(service.backgroundCredential(), undefined);
  assert.throws(() => service.createChallenge(), { code: "BINDING_STATE_CONFLICT" });
  service.confirmRevocation();
  assert.equal(service.snapshot().status, "unbound");
  assert.equal(service.snapshot().cloudControlPlaneId, "cp_cloud_a");
  assert.doesNotMatch(JSON.stringify(service.snapshot()), /backgroundCredential/);
});

test("clone conflict quarantines credentials and remote access", () => {
  const { service } = fixture();
  service.createChallenge();
  const state = service.markCloneConflict();
  assert.equal(state.status, "clone-conflict");
  assert.equal(state.remoteAccessEnabled, false);
  assert.equal(service.backgroundCredential(), undefined);
});

test("settings mutation follows the authoritative permission projection", () => {
  const actor = (userId, permissionIds) => ({ type: "user", userId, identityId: `identity-${userId}`, roleIds: [], permissionIds, nodeScope: { kind: "all" }, authorizationRevision: 1 });
  assert.equal(can(actor("admin", ["settings:manage"]), "manage-settings", { type: "control-plane-settings" }), true);
  assert.equal(can(actor("operator", ["settings:read"]), "manage-settings", { type: "control-plane-settings" }), false);
  assert.equal(can(actor("viewer", []), "manage-settings", { type: "control-plane-settings" }), false);
});

test("service outage keeps local disable and pending revocation instead of allowing account overwrite", async () => {
  const { service } = fixture();
  const challenge = service.createChallenge();
  service.consumeChallenge({ challengeCode: challenge.challengeCode, controlPlaneId: challenge.payload.controlPlaneId, fingerprint: challenge.payload.publicKeyFingerprint });
  service.activate({ accountId: "account_a", bindingId: "binding_a", bindingRevision: 1, backgroundCredential: "c".repeat(43) });
  const stopped = [];
  const lifecycle = new CloudConnectivityLifecycle({
    state: service,
    connections: { async stop(reason) { stopped.push(reason); } },
    remote: { async revoke() { throw new Error("unreachable"); }, async setRemoteAccess() { throw new Error("unreachable"); } },
  });
  const disabled = await lifecycle.setRemoteAccess({ deviceAccess: false, nodeRelay: false });
  assert.equal(disabled.remoteAccessEnabled, false);
  assert.equal(disabled.remoteResult, "unknown");
  const pending = await lifecycle.disconnect();
  assert.equal(pending.status, "pending-revocation");
  assert.throws(() => service.createChallenge(), { code: "BINDING_STATE_CONFLICT" });
  // Device access is independent from node relay, so the outbound control
  // connection stays available for both node claims and the revoke retry.
  assert.deepEqual(stopped, []);
  assert.equal(service.revocationCredential(), "c".repeat(43));
});

test("disconnect confirms the remote revoke before dropping the control connection", async () => {
  const { service } = fixture();
  const challenge = service.createChallenge();
  service.consumeChallenge({ challengeCode: challenge.challengeCode, controlPlaneId: challenge.payload.controlPlaneId, fingerprint: challenge.payload.publicKeyFingerprint });
  service.activate({ accountId: "account_a", bindingId: "binding_a", bindingRevision: 1, backgroundCredential: "c".repeat(43) });
  const calls = [];
  const lifecycle = new CloudConnectivityLifecycle({
    state: service,
    connections: {
      async ensure() { calls.push("ensure"); },
      async stop(reason) { calls.push(`stop:${reason}`); },
    },
    remote: {
      async revoke(input) { calls.push(`revoke:${input.bindingId}`); return { status: "revoked" }; },
      async setRemoteAccess() { throw new Error("unexpected setRemoteAccess"); },
    },
  });
  const result = await lifecycle.disconnect();
  assert.equal(result.status, "unbound");
  assert.equal(service.revocationCredential(), undefined);
  assert.deepEqual(calls, ["ensure", "revoke:binding_a", "stop:binding-revoked"]);
});

test("turning device access off notifies the cloud without stopping node relay", async () => {
  const { service } = fixture();
  const challenge = service.createChallenge();
  service.consumeChallenge({ challengeCode: challenge.challengeCode, controlPlaneId: challenge.payload.controlPlaneId, fingerprint: challenge.payload.publicKeyFingerprint });
  service.activate({ accountId: "account_a", bindingId: "binding_a", bindingRevision: 1, backgroundCredential: "c".repeat(43) });
  const calls = [];
  const lifecycle = new CloudConnectivityLifecycle({
    state: service,
    connections: { async stop(reason) { calls.push(`stop:${reason}`); } },
    remote: { async revoke() { throw new Error("unexpected revoke"); }, async setRemoteAccess(input) { calls.push(`remote:${input.scopes.deviceAccess}:${input.scopes.nodeRelay}`); } },
  });
  const result = await lifecycle.setRemoteAccess({ deviceAccess: false, nodeRelay: false });
  assert.equal(result.remoteResult, "confirmed");
  assert.deepEqual(calls, ["remote:false:true"]);
});

test("changing device access keeps the control connection and reconnects before notifying the cloud", async () => {
  const { service } = fixture();
  const challenge = service.createChallenge();
  service.consumeChallenge({ challengeCode: challenge.challengeCode, controlPlaneId: challenge.payload.controlPlaneId, fingerprint: challenge.payload.publicKeyFingerprint });
  service.activate({ accountId: "account_a", bindingId: "binding_a", bindingRevision: 1, backgroundCredential: "c".repeat(43) });
  const calls = [];
  const lifecycle = new CloudConnectivityLifecycle({
    state: service,
    connections: {
      async stop(reason) { calls.push(`stop:${reason}`); },
      async ensure() { calls.push(`ensure:${service.snapshot().scopes.deviceAccess}:${service.snapshot().scopes.nodeRelay}`); },
    },
    remote: { async revoke() { throw new Error("unexpected revoke"); }, async setRemoteAccess(input) { calls.push(`remote:${input.scopes.deviceAccess}:${input.scopes.nodeRelay}`); } },
  });
  await lifecycle.setRemoteAccess({ deviceAccess: false, nodeRelay: false });
  calls.length = 0;
  const result = await lifecycle.setRemoteAccess({ deviceAccess: true, nodeRelay: true });
  assert.equal(result.remoteResult, "confirmed");
  assert.deepEqual(calls, ["ensure:true:true", "remote:true:true"]);
});

test("production Control Plane pins the cloud service origin while isolated builds require explicit trust", () => {
  const production = PRODUCTION_ENVIRONMENT;
  const local = resolveCloudEnvironment(undefined, undefined, {});
  assert.equal(trustedCloudServiceOrigin(undefined, { production: true, environment: production }), production.serviceOrigin);
  for (const suffix of production.coordinatorHostSuffixes) {
    const origin = `https://coordinator.${suffix}`;
    assert.equal(trustedCloudServiceOrigin(origin, { production: true, environment: production }), origin);
  }
  assert.throws(() => trustedCloudServiceOrigin("https://outside.test", { production: true, environment: production }), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
  assert.throws(() => trustedCloudServiceOrigin("https://self-hosted.example", { production: true, allowNonProduction: true, environment: production }), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
  assert.throws(() => trustedCloudServiceOrigin("https://staging.example", { environment: local }), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
  assert.equal(trustedCloudServiceOrigin("https://staging.example/path", { allowNonProduction: true, environment: local }), "https://staging.example");
});

test("staging Control Plane trusts only the test environment domains", () => {
  const environment = STAGING_ENVIRONMENT;
  const coordinatorOrigin = `https://coordinator.${environment.coordinatorHostSuffixes[0]}`;
  const excludedProductionSuffix = PRODUCTION_ENVIRONMENT.coordinatorHostSuffixes.find((suffix) => !environment.coordinatorHostSuffixes.includes(suffix));
  assert.equal(trustedCloudServiceOrigin(undefined, { environment }), environment.serviceOrigin);
  assert.equal(trustedCloudServiceOrigin(`${environment.serviceOrigin}/path`, { environment }), environment.serviceOrigin);
  assert.equal(trustedCloudServiceOrigin(coordinatorOrigin, { environment }), coordinatorOrigin);
  assert.throws(() => trustedCloudServiceOrigin("https://staging.example", { environment }), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
  if (excludedProductionSuffix) {
    assert.throws(() => trustedCloudServiceOrigin(`https://coordinator.${excludedProductionSuffix}`, { environment }), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
  }
});

test("Coordinator fallbacks follow the configured main-domain suffixes", () => {
  const production = PRODUCTION_ENVIRONMENT;
  const coordinators = production.coordinatorHostSuffixes.map((suffix) => `https://coordinator.${suffix}`);
  const expected = [production.serviceOrigin, ...coordinators.filter((origin) => origin !== production.serviceOrigin)];
  assert.deepEqual(trustedCloudCoordinatorOrigins(coordinators, production.serviceOrigin, { production: true, environment: production }), expected);
  const untrustedSuffix = production.coordinatorHostSuffixes[0];
  assert.throws(() => trustedCloudCoordinatorOrigins([
    `https://${untrustedSuffix}.evil.test`,
  ], production.serviceOrigin, { production: true, environment: production }), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
});

test("v0.0.46 unbound state can switch clouds without retaining cloud identity", () => {
  const { root, identity, service } = fixture();
  service.setCloudControlPlaneId("cp_old_cloud");
  service.createChallenge();
  const changed = new CloudConnectivityService({ statePath: path.join(root, "binding.json"), identity, serviceOrigin: STAGING_ENVIRONMENT.serviceOrigin });
  changed.init();
  const snapshot = changed.snapshot();
  assert.equal(snapshot.serviceOrigin, STAGING_ENVIRONMENT.serviceOrigin);
  assert.equal(snapshot.status, "unbound");
  assert.equal(snapshot.originConflict, undefined);
  assert.equal(snapshot.cloudControlPlaneId, undefined);
  assert.equal(changed.createChallenge().payload.serviceOrigin, STAGING_ENVIRONMENT.serviceOrigin);
});

for (const status of ["active", "pending-revocation", "clone-conflict"]) {
  test(`v0.0.46 ${status} binding survives an origin conflict, blocks every Coordinator and can recover locally`, async () => {
    const { root, identity, service } = fixture();
    service.createChallenge();
    service.activate({ accountId: "account_a", bindingId: "binding_a", bindingRevision: 1, backgroundCredential: "c".repeat(43) });
    service.setCloudControlPlaneId("cp_old_cloud");
    if (status === "pending-revocation") service.beginRevocation();
    if (status === "clone-conflict") service.markCloneConflict();
    const statePath = path.join(root, "binding.json");
    const before = fs.readFileSync(statePath, "utf8");
    const changed = new CloudConnectivityService({ statePath, identity, serviceOrigin: STAGING_ENVIRONMENT.serviceOrigin });
    changed.init();
    assert.equal(fs.readFileSync(statePath, "utf8"), before);
    assert.equal(changed.snapshot().status, status);
    assert.deepEqual(changed.snapshot().originConflict, { configuredServiceOrigin: STAGING_ENVIRONMENT.serviceOrigin });
    assert.equal(changed.snapshot().serviceOrigin, PRODUCTION_ENVIRONMENT.serviceOrigin);
    const restored = new CloudConnectivityService({ statePath, identity, serviceOrigin: `${PRODUCTION_ENVIRONMENT.serviceOrigin}/path` });
    restored.init();
    assert.equal(restored.snapshot().originConflict, undefined);
    assert.equal(restored.snapshot().status, status);
    assert.equal(restored.backgroundCredential(), status === "active" ? "c".repeat(43) : undefined);
    assert.equal(fs.readFileSync(statePath, "utf8"), before);
    assert.equal("backgroundCredential" in changed.snapshot(), false);
    assert.throws(() => changed.createChallenge(), { code: "CLOUD_SERVICE_ORIGIN_CHANGED" });
    let connects = 0;
    const manager = new CloudControlConnectionManager({ state: changed, coordinatorOrigins: [STAGING_ENVIRONMENT.serviceOrigin], connector: { async connect() { connects++; throw new Error("unexpected connect"); } }, onEvent() {} });
    await assert.rejects(manager.connectOnce(), { code: "CLOUD_SERVICE_ORIGIN_CHANGED" });
    assert.equal(connects, 0);
    const calls = [];
    const lifecycle = new CloudConnectivityLifecycle({ state: changed,
      connections: { async stop() { calls.push("stop"); }, async ensure() { throw Object.assign(new Error("blocked"), { code: "CLOUD_SERVICE_ORIGIN_CHANGED" }); } },
      dataConnections: { async closeByKind(kind) { calls.push(kind); } },
      nodeChannels: { closeAll() { calls.push("nodes"); } },
      remote: { async revoke() { assert.fail("must not revoke at another cloud"); }, async setRemoteAccess() { assert.fail(); } },
    });
    // The legacy operation must not pretend the old cloud confirmed revocation.
    assert.equal((await lifecycle.disconnect()).status, "pending-revocation");
    const recovered = await lifecycle.resetConflictingBinding();
    assert.equal(recovered.status, "unbound");
    assert.equal(recovered.serviceOrigin, STAGING_ENVIRONMENT.serviceOrigin);
    assert.equal(recovered.originConflict, undefined);
    for (const key of ["bindingId", "accountId", "cloudControlPlaneId"]) assert.equal(recovered[key], undefined);
    assert.equal(recovered.hasBackgroundCredential, false);
    assert.equal(changed.revocationCredential(), undefined);
    assert.ok(calls.includes("stop") && calls.includes("access") && calls.includes("node") && calls.includes("nodes"));
    await assert.rejects(lifecycle.resetConflictingBinding(), { code: "BINDING_STATE_CONFLICT" });
    assert.equal(changed.createChallenge().payload.serviceOrigin, STAGING_ENVIRONMENT.serviceOrigin);
    changed.activate({ accountId: "account_new", bindingId: "binding_new", bindingRevision: 1, backgroundCredential: "n".repeat(43) });
    const restarted = new CloudConnectivityService({ statePath, identity, serviceOrigin: STAGING_ENVIRONMENT.serviceOrigin });
    restarted.init();
    assert.equal(restarted.snapshot().accountId, "account_new");
    assert.equal(restarted.snapshot().originConflict, undefined);
  });
}

test("origin conflict leaves local HTTP healthy and exposes diagnostics and explicit recovery", async () => {
  const { root, service } = fixture();
  service.createChallenge();
  service.activate({ accountId: "account_a", bindingId: "binding_a", bindingRevision: 1, backgroundCredential: "c".repeat(43) });
  fs.copyFileSync(path.join(root, "binding.json"), path.join(root, "cloud-connectivity.json"));
  const app = await createControlPlaneApp({ dataDir: root, staticDir: path.join(root, "missing-ui"), logger: false, auth: { mode: "disabled" }, cloudServiceOrigin: STAGING_ENVIRONMENT.serviceOrigin, allowNonProductionCloudOrigin: true });
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
    const response = await app.inject({ method: "GET", url: "/api/cloud-connectivity" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.originConflict.configuredServiceOrigin, STAGING_ENVIRONMENT.serviceOrigin);
    const binding = await app.inject({ method: "POST", url: "/api/cloud-connectivity/binding-requests", payload: {} });
    assert.equal(binding.json().error.code, "CLOUD_SERVICE_ORIGIN_CHANGED");
    const recovered = await app.inject({ method: "POST", url: "/api/cloud-connectivity/reset-binding", payload: {} });
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().data.status, "unbound");
    assert.equal(recovered.json().data.hasBackgroundCredential, false);
    const repeated = await app.inject({ method: "POST", url: "/api/cloud-connectivity/reset-binding", payload: {} });
    assert.equal(repeated.statusCode, 409);
    assert.equal(repeated.json().error.code, "BINDING_STATE_CONFLICT");
  } finally { await app.close(); }
});

test("origin conflict suppresses account refresh, persisted relay resume and registration at startup", async () => {
  const { root, identity, service } = fixture();
  service.createChallenge();
  service.activate({ accountId: "account_a", bindingId: "binding_a", bindingRevision: 1, backgroundCredential: "c".repeat(43) });
  const changed = new CloudConnectivityService({ statePath: path.join(root, "binding.json"), identity, serviceOrigin: STAGING_ENVIRONMENT.serviceOrigin });
  changed.init();
  const accountSession = new CloudAccountSessionService({ statePath: path.join(root, "account.json"), serviceOrigin: STAGING_ENVIRONMENT.serviceOrigin });
  accountSession.init();
  accountSession.complete({ accountId: "account_new", deviceSessionId: "device_new", refreshCredential: "r".repeat(43) });
  const calls = [];
  const runtime = new CloudConnectivityBackgroundRuntime({ state: changed, accountSession, identity,
    webSocket: class { constructor() { calls.push("socket"); throw new Error("unexpected socket"); } },
    fetch: async () => { calls.push("fetch"); throw new Error("unexpected fetch"); },
  });
  runtime.dataConnections.resumePersistedSessions = async () => { calls.push("resume"); return []; };
  try {
    runtime.start();
    await assert.rejects(runtime.beginAccountRequest({ scope: "account:sign-in" }), { code: "CLOUD_SERVICE_ORIGIN_CHANGED" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, []);
  } finally { await runtime.stop(); }
});

test("cloud connectivity feature flag disables only cloud routes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-connectivity-disabled-"));
  const app = await createControlPlaneApp({ dataDir: root, staticDir: path.join(root, "missing-ui"), logger: false, auth: { mode: "disabled" }, cloudConnectivityEnabled: false });
  try {
    const cloud = await app.inject({ method: "GET", url: "/api/cloud-connectivity" });
    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(cloud.statusCode, 503);
    // HTTP 5xx details are intentionally redacted by controlPlaneErrorPayload.
    assert.equal(cloud.json().error.code, "CONTROL_PLANE_INTERNAL_ERROR");
    assert.equal(health.statusCode, 200);
  } finally { await app.close(); }
});

test("Control Plane resolves the cloud service through TXT discovery before starting", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-discovery-startup-"));
  const names = ["TASK_HANDOFF_CLOUD_ENV", "TASK_HANDOFF_CLOUD_SERVICE_ORIGIN", "TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES", "TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES", "TASK_HANDOFF_CLOUD_DISCOVERY_RECORD", "TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    TASK_HANDOFF_CLOUD_ENV: "production",
    TASK_HANDOFF_CLOUD_SERVICE_ORIGIN: "https://primary.example.test",
    TASK_HANDOFF_CLOUD_COORDINATOR_HOST_SUFFIXES: "example.test",
    TASK_HANDOFF_CLOUD_RELAY_HOST_SUFFIXES: "example.test",
    TASK_HANDOFF_CLOUD_DISCOVERY_RECORD: "_cloud.example.test",
    TASK_HANDOFF_CLOUD_DISCOVERY_FALLBACK_ORIGIN: "https://primary.example.test",
  });
  const calls = [];
  let app;
  try {
    app = await createControlPlaneApp({
      dataDir: root,
      staticDir: path.join(root, "missing-ui"),
      logger: false,
      auth: { mode: "disabled" },
      cloudConnectivityEnabled: false,
      cloudDiscoveryFetch: async (input) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        calls.push(url.href);
        if (url.hostname === "dns.alidns.com") {
          return new Response(JSON.stringify({ Answer: [{ type: 16, data: "v1 backup.example.test" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("", { status: 200 });
      },
    });
    assert.ok(calls.some((url) => url.startsWith("https://dns.alidns.com/")));
    const cache = JSON.parse(fs.readFileSync(path.join(root, "cloud-discovery.json"), "utf8"));
    assert.deepEqual(cache.origins, ["https://backup.example.test"]);
  } finally {
    await app?.close();
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
