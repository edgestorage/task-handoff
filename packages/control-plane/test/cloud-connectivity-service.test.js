import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlaneIdentityService } from "../src/control-plane/identity/service.ts";
import { CloudConnectivityService } from "../src/control-plane/cloud-connectivity/service.ts";
import { can } from "../src/control-plane/auth/authorization.ts";
import { CloudConnectivityLifecycle } from "../src/control-plane/cloud-connectivity/lifecycle.ts";
import { createControlPlaneApp, trustedCloudCoordinatorOrigins, trustedCloudServiceOrigin } from "../src/control-plane/http/server.ts";
import { resolveCloudEnvironment } from "../../../shared/cloud-environments.cjs";

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
  // The outbound control connection is kept for the retry; only the scope
  // change stopped it before disconnect was attempted.
  assert.deepEqual(stopped, ["scope-disabled"]);
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

test("a persisted binding authority rejects a different environment service origin", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-origin-change-"));
  const identity = new ControlPlaneIdentityService(path.join(root, "identity.json"), () => "control_plane_a");
  identity.init();
  const statePath = path.join(root, "binding.json");
  const productionOrigin = PRODUCTION_ENVIRONMENT.serviceOrigin;
  new CloudConnectivityService({ statePath, identity, serviceOrigin: productionOrigin }).init();
  assert.throws(() => new CloudConnectivityService({ statePath, identity, serviceOrigin: STAGING_ENVIRONMENT.serviceOrigin }).init(), { code: "CLOUD_SERVICE_ORIGIN_CHANGED" });
  new CloudConnectivityService({ statePath, identity, serviceOrigin: `${productionOrigin}/path` }).init();
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
