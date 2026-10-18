import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlaneIdentityService } from "../src/control-plane/identity/service.ts";
import { CloudConnectivityService } from "../src/control-plane/cloud-connectivity/service.ts";
import { can } from "../src/control-plane/auth/authorization.ts";
import { CloudConnectivityLifecycle } from "../src/control-plane/cloud-connectivity/lifecycle.ts";
import { createControlPlaneApp, trustedCloudServiceOrigin } from "../src/control-plane/http/server.ts";
import { CLOUD_ENVIRONMENTS } from "../../../shared/cloud-environments.cjs";

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

test("cloud identity is persisted separately from the local Control Plane identity", () => {
  const { root, identity, service } = fixture();
  service.setCloudControlPlaneId("cp_cloud_a");
  assert.equal(service.snapshot().identity.controlPlaneId, "control_plane_a");
  assert.equal(service.snapshot().cloudControlPlaneId, "cp_cloud_a");
  const restarted = new CloudConnectivityService({ statePath: path.join(root, "binding.json"), identity, serviceOrigin: "https://cloud.example.test" });
  restarted.init();
  assert.equal(restarted.cloudControlPlaneId(), "cp_cloud_a");
});

test("binding challenge is target-bound, one-time, memory-only and restart-invalidated", () => {
  const { root, identity, service } = fixture();
  const issued = service.createChallenge();
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
  assert.deepEqual(stopped, ["scope-disabled", "binding-pending-revocation"]);
});

test("turning both relay scopes off notifies the cloud before stopping the outbound connection", async () => {
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
  assert.deepEqual(calls, ["remote:false:false", "stop:scope-disabled"]);
});

test("turning a relay scope back on reconnects before notifying the cloud", async () => {
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
  assert.equal(trustedCloudServiceOrigin(undefined, { production: true }), "https://cloud.thandoff.com");
  assert.throws(() => trustedCloudServiceOrigin("https://cloud.taskhandoff.com", { production: true }), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
  assert.throws(() => trustedCloudServiceOrigin("https://self-hosted.example", { production: true, allowNonProduction: true }), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
  assert.throws(() => trustedCloudServiceOrigin("https://staging.example"), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
  assert.equal(trustedCloudServiceOrigin("https://staging.example/path", { allowNonProduction: true }), "https://staging.example");
});

test("staging Control Plane trusts only the test environment domains", () => {
  const environment = CLOUD_ENVIRONMENTS.staging;
  assert.equal(trustedCloudServiceOrigin(undefined, { environment }), "https://th.aaasu.com");
  assert.equal(trustedCloudServiceOrigin("https://th.aaasu.com/path", { environment }), "https://th.aaasu.com");
  assert.throws(() => trustedCloudServiceOrigin("https://staging.example", { environment }), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
  assert.throws(() => trustedCloudServiceOrigin("https://cloud.thandoff.com", { environment }), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
  assert.throws(() => trustedCloudServiceOrigin("https://th.aaasu.com", { environment, production: true }), { code: "UNTRUSTED_CLOUD_SERVICE_ORIGIN" });
});

test("a persisted binding authority rejects a different environment service origin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-origin-change-"));
  const identity = new ControlPlaneIdentityService(path.join(root, "identity.json"), () => "control_plane_a");
  identity.init();
  const statePath = path.join(root, "binding.json");
  new CloudConnectivityService({ statePath, identity, serviceOrigin: "https://cloud.thandoff.com" }).init();
  assert.throws(() => new CloudConnectivityService({ statePath, identity, serviceOrigin: "https://th.aaasu.com" }).init(), { code: "CLOUD_SERVICE_ORIGIN_CHANGED" });
  new CloudConnectivityService({ statePath, identity, serviceOrigin: "https://cloud.thandoff.com/path" }).init();
});

test("cloud connectivity feature flag disables only cloud routes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-connectivity-disabled-"));
  const app = await createControlPlaneApp({ dataDir: root, staticDir: path.join(root, "missing-ui"), logger: false, auth: { mode: "disabled" }, cloudConnectivityEnabled: false });
  try {
    const cloud = await app.inject({ method: "GET", url: "/api/cloud-connectivity" });
    const health = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(cloud.statusCode, 503);
    assert.equal(cloud.json().error.code, "CLOUD_CONNECTIVITY_DISABLED");
    assert.equal(health.statusCode, 200);
  } finally { await app.close(); }
});
