import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify, { type FastifyRequest } from "fastify";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { createControlPlaneDeviceTrustStore } from "../src/control-plane/device-trust/repository.ts";
import {
  CloudDeviceTrustService,
  type CloudDeviceTrustActor,
  type CloudDeviceTrustResolvedRole,
} from "../src/control-plane/device-trust/service.ts";
import {
  fingerprintDevicePublicKey,
  type CloudClientAuthContext,
} from "../src/control-plane/cloud-connectivity/client-auth.ts";
import { registerDeviceTrustRoutes } from "../src/control-plane/http/device-trust-routes.ts";

const START = Date.parse("2026-10-26T08:00:00.000Z");
const BINDING_ID = "binding_routes";
const ADMIN_ROLE: CloudDeviceTrustResolvedRole = {
  roleIds: ["role_admin"],
  permissionIds: ["settings:manage", "ai-sessions:read"],
  authorizationRevision: 1,
};
const OPERATOR_ROLE: CloudDeviceTrustResolvedRole = {
  roleIds: ["role_operator"],
  permissionIds: ["ai-sessions:read"],
  authorizationRevision: 2,
};

function authContext(devicePublicKey: string, overrides: { shareGrantId?: string } = {}): CloudClientAuthContext {
  return {
    ticket: { shareRevision: 1 },
    grant: {},
    device: { name: `Device ${devicePublicKey.slice(0, 1)}`, kind: "mobile", platform: "android", version: "1.0.0" },
    devicePublicKey,
    deviceFingerprint: fingerprintDevicePublicKey(devicePublicKey),
    comparisonCode: "AAAA-BBBB-CCCC-DDDD",
    accessContext: {
      bindingId: BINDING_ID,
      accountId: "account_guest",
      ownerAccountId: "account_owner",
      accessMode: "shared",
      shareGrantId: overrides.shareGrantId ?? "share_docs",
      cloudAccessRoleId: "role_cloud_use",
      devicePublicKey,
    },
    trustRetry: false,
  } as unknown as CloudClientAuthContext;
}

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-device-trust-routes-"));
  const database = await createControlPlaneDatabase(controlPlaneStorePaths(root));
  const seededAt = new Date(START).toISOString();
  await database.roles.put({
    id: "role_admin",
    name: "Admin",
    system: false,
    status: "active",
    permissionIds: ["settings:manage", "ai-sessions:read"],
    createdAt: seededAt,
    updatedAt: seededAt,
  });
  await database.roles.put({
    id: "role_operator",
    name: "Operator",
    system: false,
    status: "active",
    permissionIds: ["ai-sessions:read"],
    createdAt: seededAt,
    updatedAt: seededAt,
  });
  const closedPins: Array<{ pinId: string; reason: string }> = [];
  const service = new CloudDeviceTrustService(
    createControlPlaneDeviceTrustStore(database),
    async (roleId) => roleId === "role_admin" ? ADMIN_ROLE : roleId === "role_operator" ? OPERATOR_ROLE : { roleIds: [], permissionIds: [], authorizationRevision: 1 },
    {
      clock: () => START,
      closePinSessions: (pin, reason) => { closedPins.push({ pinId: pin.id, reason }); },
    },
  );
  const actors = new Map<string, CloudDeviceTrustActor>([
    ["local-admin", { type: "user", id: "user_admin", roleIds: ["role_admin"], permissionIds: ["settings:manage"] }],
    ["local-operator", { type: "user", id: "user_operator", roleIds: ["role_operator"], permissionIds: ["ai-sessions:read"] }],
    ["cloud-admin-unpinned", { type: "cloud-account", id: "cloud-account:account_owner", roleIds: ["role_admin"], permissionIds: ["settings:manage"] }],
  ]);
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const value = error as Error & { code?: string; statusCode?: number };
    reply.code(value.statusCode ?? 500).send({ error: { code: value.code ?? "INTERNAL_ERROR", message: value.message } });
  });
  registerDeviceTrustRoutes(app, {
    service,
    actor: (request: FastifyRequest) => {
      const key = String(request.headers["x-test-actor"] ?? "local-admin");
      const actor = actors.get(key);
      if (!actor) throw Object.assign(new Error("Unknown test actor."), { code: "TEST_ACTOR_UNKNOWN", statusCode: 401 });
      return actor;
    },
    bindingId: () => BINDING_ID,
    roles: async () => [
      { roleId: "role_admin", name: "Admin", status: "active", isAdmin: true },
      { roleId: "role_operator", name: "Operator", status: "active", isAdmin: false },
    ],
  });
  return {
    app,
    actors,
    service,
    closedPins,
    async approvePending(devicePublicKey: string, roleId = "role_admin") {
      const pending = await service.observeClient(authContext(devicePublicKey));
      assert.equal(pending.kind, "pending");
      if (pending.kind !== "pending") throw new Error("Expected a pending device request.");
      return service.approve({
        requestId: pending.request.id,
        expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
        expectedRevision: pending.request.revision,
        roleId,
        actor: actors.get("local-admin")!,
      });
    },
    async cleanup() {
      await app.close();
      await database.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("device trust routes require an admin and reject unpinned cloud administrators", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext("A".repeat(43)));
    assert.equal(pending.kind, "pending");

    const localOperator = await fixture.app.inject({ method: "GET", url: "/api/device-trust", headers: { "x-test-actor": "local-operator" } });
    assert.equal(localOperator.statusCode, 403, localOperator.body);
    assert.equal(localOperator.json().error.code, "CLOUD_DEVICE_TRUST_ADMIN_REQUIRED");

    const unpinnedCloudAdmin = await fixture.app.inject({ method: "GET", url: "/api/device-trust", headers: { "x-test-actor": "cloud-admin-unpinned" } });
    assert.equal(unpinnedCloudAdmin.statusCode, 403, unpinnedCloudAdmin.body);
    assert.equal(unpinnedCloudAdmin.json().error.code, "CLOUD_DEVICE_TRUST_ADMIN_REQUIRED");

    const localAdmin = await fixture.app.inject({ method: "GET", url: "/api/device-trust", headers: { "x-test-actor": "local-admin" } });
    assert.equal(localAdmin.statusCode, 200, localAdmin.body);
    assert.equal(localAdmin.json().data.requests.filter((request: { status: string }) => request.status === "pending").length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("a pinned cloud admin can decide another device while a pinned operator cannot", async () => {
  const fixture = await createFixture();
  try {
    const approvingDevice = await fixture.approvePending("B".repeat(43));
    const operatorDevice = await fixture.approvePending("C".repeat(43), "role_operator");
    fixture.actors.set("cloud-admin-pinned", {
      type: "cloud-account",
      id: "cloud-account:account_owner",
      roleIds: ["role_admin"],
      permissionIds: ["settings:manage"],
      deviceTrustPinId: approvingDevice.pin.id,
    });
    fixture.actors.set("cloud-operator-pinned", {
      type: "cloud-account",
      id: "cloud-account:account_operator",
      roleIds: ["role_operator"],
      permissionIds: ["ai-sessions:read"],
      deviceTrustPinId: operatorDevice.pin.id,
    });
    const pending = await fixture.service.observeClient(authContext("D".repeat(43)));
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;

    const operatorDenied = await fixture.app.inject({
      method: "GET",
      url: "/api/device-trust",
      headers: { "x-test-actor": "cloud-operator-pinned" },
    });
    assert.equal(operatorDenied.statusCode, 403, operatorDenied.body);

    const decision = await fixture.app.inject({
      method: "POST",
      url: `/api/device-trust/requests/${encodeURIComponent(pending.request.id)}/decision`,
      headers: { "x-test-actor": "cloud-admin-pinned" },
      payload: {
        decision: "approve",
        expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
        expectedRevision: pending.request.revision,
        roleId: "role_operator",
      },
    });
    assert.equal(decision.statusCode, 200, decision.body);
    assert.equal(decision.json().data.trustedDevices.some((device: { pinId: string }) => device.pinId === approvingDevice.pin.id), true);
    assert.equal(decision.json().data.requests.find((request: { requestId: string }) => request.requestId === pending.request.id)?.status, "approved");
  } finally {
    await fixture.cleanup();
  }
});

test("device trust decisions fail closed on stale revisions and revocation closes the exact pin", async () => {
  const fixture = await createFixture();
  try {
    const approved = await fixture.approvePending("E".repeat(43));
    const staleRevoke = await fixture.app.inject({
      method: "POST",
      url: `/api/device-trust/pins/${encodeURIComponent(approved.pin.id)}/revoke`,
      payload: { expectedRevision: approved.pin.revision + 1 },
    });
    assert.equal(staleRevoke.statusCode, 409, staleRevoke.body);
    assert.equal(staleRevoke.json().error.code, "CLOUD_DEVICE_TRUST_REVISION_CONFLICT");

    const revoked = await fixture.app.inject({
      method: "POST",
      url: `/api/device-trust/pins/${encodeURIComponent(approved.pin.id)}/revoke`,
      payload: { expectedRevision: approved.pin.revision, reason: "lost device" },
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal(revoked.json().data.trustedDevices.find((device: { pinId: string }) => device.pinId === approved.pin.id)?.status, "revoked");
    assert.deepEqual(fixture.closedPins, [{ pinId: approved.pin.id, reason: "device-trust-revoked" }]);
  } finally {
    await fixture.cleanup();
  }
});

test("reject decisions require the fingerprint shown to the administrator", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext("F".repeat(43)));
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const mismatched = await fixture.app.inject({
      method: "POST",
      url: `/api/device-trust/requests/${encodeURIComponent(pending.request.id)}/decision`,
      payload: {
        decision: "reject",
        expectedFingerprint: fingerprintDevicePublicKey("G".repeat(43)),
        expectedRevision: pending.request.revision,
        reason: "wrong device",
      },
    });
    assert.equal(mismatched.statusCode, 409, mismatched.body);
    assert.equal(mismatched.json().error.code, "CLOUD_DEVICE_TRUST_FINGERPRINT_CONFLICT");
    assert.equal((await fixture.service.list(BINDING_ID)).requests.find((request) => request.id === pending.request.id)?.status, "pending");

    const rejected = await fixture.app.inject({
      method: "POST",
      url: `/api/device-trust/requests/${encodeURIComponent(pending.request.id)}/decision`,
      payload: {
        decision: "reject",
        expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
        expectedRevision: pending.request.revision,
        reason: "wrong device",
      },
    });
    assert.equal(rejected.statusCode, 200, rejected.body);
    assert.equal(rejected.json().data.requests.find((request: { requestId: string }) => request.requestId === pending.request.id)?.status, "rejected");
  } finally {
    await fixture.cleanup();
  }
});
