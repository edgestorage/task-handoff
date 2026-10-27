import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ControlPlanePermissionId } from "@task-handoff/protocol/control-plane-access";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { createControlPlaneDeviceTrustStore } from "../src/control-plane/device-trust/repository.ts";
import {
  CLOUD_DEVICE_TRUST_REQUEST_TTL_MS,
  CloudDeviceTrustService,
  type CloudDeviceTrustActor,
  type CloudDeviceTrustResolvedRole,
  type CloudDeviceTrustRoleResolver,
} from "../src/control-plane/device-trust/service.ts";
import {
  fingerprintDevicePublicKey,
  type CloudClientAuthContext,
} from "../src/control-plane/cloud-connectivity/client-auth.ts";
import {
  CloudDevicePinRecordSchema,
  CloudDeviceTrustRequestRecordSchema,
  parseStoredCloudDevicePinRecord,
  parseStoredCloudDeviceTrustRequestRecord,
} from "../src/control-plane/auth/database/cloud-device-trust-records.ts";

const START = Date.parse("2026-10-26T08:00:00.000Z");
const BINDING_ID = "binding_a";
const DEVICE_PUBLIC_KEY = "A".repeat(43);

const adminRole: CloudDeviceTrustResolvedRole = {
  roleIds: ["role_admin"],
  permissionIds: ["settings:manage", "ai-sessions:read"],
  authorizationRevision: 1,
};
const operatorRole: CloudDeviceTrustResolvedRole = {
  roleIds: ["role_operator"],
  permissionIds: ["ai-sessions:read"],
  authorizationRevision: 2,
};
const adminActor: CloudDeviceTrustActor = {
  type: "user",
  id: "user_admin",
  roleIds: ["role_admin"],
  permissionIds: ["settings:manage"],
};

type AuthOverrides = {
  accessMode?: "owner" | "shared";
  accountId?: string;
  ownerAccountId?: string;
  shareGrantId?: string;
  shareRevision?: number;
  cloudAccessRoleId?: string;
  devicePublicKey?: string;
  deviceName?: string;
  deviceVersion?: string | null;
};

function authContext(overrides: AuthOverrides = {}): CloudClientAuthContext {
  const accessMode = overrides.accessMode ?? "shared";
  const accountId = overrides.accountId ?? (accessMode === "shared" ? "account_guest" : "account_owner");
  const ownerAccountId = overrides.ownerAccountId ?? "account_owner";
  const devicePublicKey = overrides.devicePublicKey ?? DEVICE_PUBLIC_KEY;
  const shareGrantId = accessMode === "shared" ? overrides.shareGrantId ?? "share_docs" : undefined;
  const shareRevision = accessMode === "shared" ? overrides.shareRevision ?? 2 : undefined;
  return {
    ticket: { shareRevision },
    grant: {},
    device: {
      name: overrides.deviceName ?? "Pixel test device",
      kind: "mobile",
      platform: "android",
      ...(overrides.deviceVersion === null ? {} : { version: overrides.deviceVersion ?? "1.0.0" }),
    },
    devicePublicKey,
    deviceFingerprint: fingerprintDevicePublicKey(devicePublicKey),
    comparisonCode: "AAAA-BBBB-CCCC-DDDD",
    accessContext: {
      bindingId: BINDING_ID,
      accountId,
      ownerAccountId,
      accessMode,
      ...(shareGrantId === undefined ? {} : { shareGrantId }),
      cloudAccessRoleId: overrides.cloudAccessRoleId ?? "role_admin",
      devicePublicKey,
    },
    trustRetry: false,
  } as unknown as CloudClientAuthContext;
}

function authContextWith(overrides: AuthOverrides, accessContext: Partial<CloudClientAuthContext["accessContext"]>): CloudClientAuthContext {
  const context = authContext(overrides);
  return { ...context, accessContext: { ...context.accessContext, ...accessContext } };
}

const isolatedAccessContextCases: Array<{
  name: string;
  context(): CloudClientAuthContext;
  expected: "pending" | "authorization-stale";
}> = [
  { name: "forged device key", context: () => authContext({ devicePublicKey: "B".repeat(43) }), expected: "pending" },
  { name: "tampered account", context: () => authContext({ accountId: "account_other_guest" }), expected: "pending" },
  { name: "tampered binding", context: () => authContextWith({}, { bindingId: "binding_other" }), expected: "pending" },
  { name: "tampered owner", context: () => authContext({ ownerAccountId: "account_other_owner" }), expected: "pending" },
  { name: "owner-mode escalation", context: () => authContext({ accessMode: "owner", accountId: "account_owner", ownerAccountId: "account_owner" }), expected: "pending" },
  { name: "tampered share grant", context: () => authContext({ shareGrantId: "share_other" }), expected: "pending" },
  { name: "cloud role escalation", context: () => authContext({ cloudAccessRoleId: "role_cloud_admin" }), expected: "pending" },
  { name: "stale share revision", context: () => authContext({ shareRevision: 1 }), expected: "authorization-stale" },
];

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-device-trust-"));
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
  let now = START;
  let resolveRole: CloudDeviceTrustRoleResolver = async (roleId): Promise<CloudDeviceTrustResolvedRole> => {
    if (roleId === "role_admin") return adminRole;
    if (roleId === "role_operator") return operatorRole;
    return { roleIds: [], permissionIds: [], authorizationRevision: 1 };
  };
  const changes: { bindingId: string; revision: number }[] = [];
  const closedPins: { pinId: string; reason: string }[] = [];
  const service = new CloudDeviceTrustService(
    createControlPlaneDeviceTrustStore(database),
    (roleId, repository) => resolveRole(roleId, repository),
    {
      clock: () => now,
      onChanged: (change) => { changes.push(change); },
      closePinSessions: (pin, reason) => { closedPins.push({ pinId: pin.id, reason }); },
    },
  );
  return {
    root,
    database,
    service,
    changes,
    closedPins,
    advance(milliseconds: number) { now += milliseconds; },
    setNow(milliseconds: number) { now = milliseconds; },
    setRoleResolver(resolver: CloudDeviceTrustRoleResolver) {
      resolveRole = resolver;
    },
    async cleanup() {
      await database.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("pending observation keeps one request and an absolute 24h expiry until explicit retry", async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.service.observeClient(authContext());
    assert.equal(first.kind, "pending");
    if (first.kind !== "pending") return;
    assert.equal(first.reason, "first-seen");
    assert.equal(Date.parse(first.request.expiresAt) - Date.parse(first.request.requestedAt), CLOUD_DEVICE_TRUST_REQUEST_TTL_MS);

    fixture.advance(5 * 60_000);
    const repeated = await fixture.service.observeClient(authContext({ deviceName: "Renamed phone" }));
    assert.equal(repeated.kind, "pending");
    if (repeated.kind !== "pending") return;
    assert.equal(repeated.request.id, first.request.id);
    assert.equal(repeated.request.expiresAt, first.request.expiresAt);
    assert.equal(repeated.request.lastSeenAt, new Date(START + 5 * 60_000).toISOString());
    assert.equal(repeated.request.reportedName, "Renamed phone");

    fixture.setNow(Date.parse(first.request.expiresAt) + 1);
    const expired = await fixture.service.observeClient(authContext());
    assert.equal(expired.kind, "expired");
    if (expired.kind !== "expired") return;
    assert.equal(expired.request.id, first.request.id);
    assert.equal((await fixture.service.list(BINDING_ID)).requests.length, 1);

    fixture.advance(1);
    const retried = await fixture.service.observeClient(authContext(), { explicitRetry: true });
    assert.equal(retried.kind, "pending");
    if (retried.kind !== "pending") return;
    assert.notEqual(retried.request.id, first.request.id);
    assert.ok((await fixture.service.list(BINDING_ID)).requests.some((request) => request.id === first.request.id && request.status === "expired"));
    assert.ok((await fixture.service.list(BINDING_ID)).audit.some((entry) => entry.action === "request-expired"));
  } finally {
    await fixture.cleanup();
  }
});

test("background reconnect refreshes pending lastSeen without moving its revision or publishing", async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.service.observeClient(authContext());
    assert.equal(first.kind, "pending");
    if (first.kind !== "pending") return;
    const eventCount = fixture.changes.length;
    const auditCount = (await fixture.service.list(BINDING_ID)).audit.length;

    fixture.advance(30_000);
    const repeated = await fixture.service.observeClient(authContext());
    assert.equal(repeated.kind, "pending");
    if (repeated.kind !== "pending") return;
    assert.equal(repeated.request.id, first.request.id);
    assert.equal(repeated.request.revision, first.request.revision);
    assert.equal(repeated.request.updatedAt, first.request.updatedAt);
    assert.equal(repeated.request.lastSeenAt, new Date(START + 30_000).toISOString());
    assert.equal(fixture.changes.length, eventCount);
    assert.equal((await fixture.service.list(BINDING_ID)).audit.length, auditCount);

    const approved = await fixture.service.approve({
      requestId: first.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(first.request.devicePublicKey),
      expectedRevision: first.request.revision,
      actor: adminActor,
    });
    assert.equal(approved.pin.status, "active");
  } finally {
    await fixture.cleanup();
  }
});

test("background reconnect refreshes trusted pin lastSeen without moving its revision or publishing", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const approved = await fixture.service.approve({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
    });
    const eventCount = fixture.changes.length;

    fixture.advance(30_000);
    const repeated = await fixture.service.observeClient(authContext());
    assert.equal(repeated.kind, "active");
    if (repeated.kind !== "active") return;
    assert.equal(repeated.pin.id, approved.pin.id);
    assert.equal(repeated.pin.revision, approved.pin.revision);
    assert.equal(repeated.pin.updatedAt, approved.pin.updatedAt);
    assert.equal(repeated.pin.lastSeenAt, new Date(START + 30_000).toISOString());
    assert.equal(fixture.changes.length, eventCount);
  } finally {
    await fixture.cleanup();
  }
});

test("record revisions advance within one millisecond and reject a stale approval revision", async () => {
  const fixture = await createFixture();
  try {
    const first = await fixture.service.observeClient(authContext());
    const repeated = await fixture.service.observeClient(authContext({ deviceName: "Renamed phone" }));
    assert.equal(first.kind, "pending");
    assert.equal(repeated.kind, "pending");
    if (first.kind !== "pending" || repeated.kind !== "pending") return;
    assert.equal(repeated.request.id, first.request.id);
    assert.equal(repeated.request.revision, first.request.revision + 1);

    await assert.rejects(() => fixture.service.approve({
      requestId: repeated.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(repeated.request.devicePublicKey),
      expectedRevision: first.request.revision,
      actor: adminActor,
    }), { code: "CLOUD_DEVICE_TRUST_REVISION_CONFLICT", statusCode: 409 });
    assert.equal((await fixture.service.list(BINDING_ID)).pins.length, 0);

    const approved = await fixture.service.approve({
      requestId: repeated.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(repeated.request.devicePublicKey),
      expectedRevision: repeated.request.revision,
      actor: adminActor,
    });
    assert.equal(approved.pin.status, "active");

    // The snapshot cursor is persisted independently from the in-process
    // service instance, so a restart cannot move the revision backwards behind
    // an event that clients already applied.
    const restarted = new CloudDeviceTrustService(
      createControlPlaneDeviceTrustStore(fixture.database),
      async (roleId) => roleId === "role_admin" ? adminRole : roleId === "role_operator" ? operatorRole : { roleIds: [], permissionIds: [], authorizationRevision: 1 },
      { clock: () => START },
    );
    const snapshot = await restarted.snapshot(BINDING_ID, []);
    const lastEventRevision = fixture.changes.at(-1)?.revision;
    assert.equal(typeof lastEventRevision, "number");
    assert.ok(snapshot.revision >= lastEventRevision);
  } finally {
    await fixture.cleanup();
  }
});

test("a stale share revision fails closed without refreshing or replacing the pending request", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext({ shareRevision: 4 }));
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const eventCount = fixture.changes.length;

    const stale = await fixture.service.observeClient(authContext({ shareRevision: 3 }));
    assert.deepEqual(stale, { kind: "authorization-stale" });
    assert.equal(fixture.changes.length, eventCount);

    const records = await fixture.service.list(BINDING_ID);
    assert.equal(records.requests.length, 1);
    assert.equal(records.requests[0].id, pending.request.id);
    assert.equal(records.requests[0].revision, pending.request.revision);
    assert.equal(records.requests[0].shareRevision, 4);
  } finally {
    await fixture.cleanup();
  }
});

test("approval persists one active pin, rejects stale revisions and prevents duplicate approval", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const request = pending.request;
    const expectedRevision = request.revision;
    const fingerprint = fingerprintDevicePublicKey(request.devicePublicKey);

    await assert.rejects(() => fixture.service.approve({
      requestId: request.id,
      expectedFingerprint: fingerprintDevicePublicKey("B".repeat(43)),
      expectedRevision,
      actor: adminActor,
    }), { code: "CLOUD_DEVICE_TRUST_FINGERPRINT_CONFLICT" });
    assert.equal((await fixture.service.list(BINDING_ID)).pins.length, 0);

    const approved = await fixture.service.approve({
      requestId: request.id,
      expectedFingerprint: fingerprint,
      expectedRevision,
      actor: adminActor,
    });
    assert.equal(approved.pin.status, "active");
    assert.equal(approved.pin.roleId, "role_admin");
    assert.equal(approved.pin.devicePublicKey, request.devicePublicKey);
    assert.equal(approved.pin.authorizationRevision, adminRole.authorizationRevision);
    assert.equal(approved.request.status, "approved");
    const persistedPin = await fixture.database.cloudDeviceTrust.getPin(approved.pin.id);
    assert.equal(persistedPin?.status, "active");
    assert.equal(persistedPin?.revokedAt, undefined);
    assert.equal(persistedPin?.revokeReason, undefined);

    await assert.rejects(() => fixture.service.approve({
      requestId: request.id,
      expectedFingerprint: fingerprint,
      expectedRevision,
      actor: adminActor,
    }), { code: "CLOUD_DEVICE_TRUST_REQUEST_NOT_PENDING" });

    fixture.advance(60_000);
    const active = await fixture.service.observeClient(authContext());
    assert.equal(active.kind, "active");
    if (active.kind !== "active") return;
    assert.equal(active.pin.id, approved.pin.id);
    assert.deepEqual(active.role.roleIds, ["role_admin"]);
    const records = await fixture.service.list(BINDING_ID);
    assert.equal(records.pins.length, 1);
    assert.ok(records.audit.some((entry) => entry.action === "request-approved"));
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent approval attempts produce only one active pin", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const decision = {
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
    };
    const results = await Promise.allSettled([
      fixture.service.approve(decision),
      fixture.service.approve(decision),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected?.status, "rejected");
    if (rejected?.status === "rejected") {
      assert.equal((rejected.reason as { code?: string }).code, "CLOUD_DEVICE_TRUST_REQUEST_NOT_PENDING");
    }
    assert.equal((await fixture.service.list(BINDING_ID)).pins.filter((pin) => pin.status === "active").length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("approval resolves the requested cloud role inside the decision transaction", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    fixture.setRoleResolver(async (roleId, repository) => {
      const role = await repository.roles.get(roleId);
      if (!role || role.status !== "active") {
        throw Object.assign(new Error("archived"), { code: "CONTROL_PLANE_ROLE_INACTIVE" });
      }
      return roleId === "role_admin" ? adminRole : operatorRole;
    });
    const admin = await fixture.database.roles.get("role_admin");
    assert.ok(admin);
    await fixture.database.roles.put({ ...admin, status: "archived", updatedAt: new Date(START + 1_000).toISOString() });

    await assert.rejects(() => fixture.service.approve({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
    }), { code: "CLOUD_DEVICE_TRUST_ROLE_UNAVAILABLE" });

    const records = await fixture.service.list(BINDING_ID);
    assert.equal(records.pins.length, 0);
    assert.equal(records.requests.find((request) => request.id === pending.request.id)?.status, "pending");
  } finally {
    await fixture.cleanup();
  }
});

test("rejection is terminal for background reconnects and explicit retry creates a new request", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const rejected = await fixture.service.reject({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
      reason: "not this phone",
    });
    assert.equal(rejected.status, "rejected");

    fixture.advance(60_000);
    const background = await fixture.service.observeClient(authContext());
    assert.equal(background.kind, "rejected");
    if (background.kind !== "rejected") return;
    assert.equal(background.request.id, pending.request.id);

    fixture.advance(60_000);
    const retried = await fixture.service.observeClient(authContext(), { explicitRetry: true });
    assert.equal(retried.kind, "pending");
    if (retried.kind !== "pending") return;
    assert.notEqual(retried.request.id, pending.request.id);
    assert.equal(retried.request.reason, "first-seen");
  } finally {
    await fixture.cleanup();
  }
});

test("reject validates the expected fingerprint before changing the request", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    await assert.rejects(() => fixture.service.reject({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey("B".repeat(43)),
      expectedRevision: pending.request.revision,
      actor: adminActor,
      reason: "stale UI",
    }), { code: "CLOUD_DEVICE_TRUST_FINGERPRINT_CONFLICT", statusCode: 409 });
    let records = await fixture.service.list(BINDING_ID);
    assert.equal(records.requests.find((request) => request.id === pending.request.id)?.status, "pending");

    const rejected = await fixture.service.reject({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
      reason: "not this phone",
    });
    assert.equal(rejected.status, "rejected");
    records = await fixture.service.list(BINDING_ID);
    assert.equal(records.requests.find((request) => request.id === pending.request.id)?.decisionReason, "not this phone");
  } finally {
    await fixture.cleanup();
  }
});

test("revocation closes only the exact pin and explicit retry starts a new trust request", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const approved = await fixture.service.approve({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
    });

    fixture.advance(1_000);
    const revoked = await fixture.service.revokePin({
      pinId: approved.pin.id,
      expectedRevision: approved.pin.revision,
      actor: adminActor,
      reason: "lost phone",
    });
    assert.equal(revoked.status, "revoked");
    assert.deepEqual(fixture.closedPins, [{ pinId: approved.pin.id, reason: "device-trust-revoked" }]);
    const records = await fixture.service.list(BINDING_ID);
    assert.equal(records.pins.find((pin) => pin.id === approved.pin.id)?.status, "revoked");
    assert.equal(records.pins.find((pin) => pin.id === approved.pin.id)?.revokeReason, "lost phone");
    assert.ok(records.audit.some((entry) => entry.action === "pin-revoked" && entry.pinId === approved.pin.id && entry.reason === "lost phone"));

    const observed = await fixture.service.observeClient(authContext());
    assert.equal(observed.kind, "revoked");
    if (observed.kind !== "revoked") return;
    assert.equal(observed.pin.id, approved.pin.id);

    fixture.advance(1_000);
    const retried = await fixture.service.observeClient(authContext(), { explicitRetry: true });
    assert.equal(retried.kind, "pending");
    if (retried.kind !== "pending") return;
    assert.equal(retried.request.reason, "first-seen");
  } finally {
    await fixture.cleanup();
  }
});

test("an unavailable local role revokes the old pin, closes its sessions and reopens approval", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const approved = await fixture.service.approve({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
    });

    fixture.setRoleResolver(async (roleId) => {
      if (roleId === "role_admin") throw Object.assign(new Error("archived"), { code: "CONTROL_PLANE_ROLE_INACTIVE" });
      return roleId === "role_operator" ? operatorRole : { roleIds: [], permissionIds: [], authorizationRevision: 1 };
    });
    fixture.advance(1_000);
    const unavailable = await fixture.service.observeClient(authContext());
    assert.equal(unavailable.kind, "pending");
    if (unavailable.kind !== "pending") return;
    assert.equal(unavailable.reason, "role-changed");
    assert.deepEqual(unavailable.revokedPins?.map((pin) => pin.id), [approved.pin.id]);
    assert.deepEqual(fixture.closedPins, [{ pinId: approved.pin.id, reason: "device-trust-reapproval-required" }]);
    const records = await fixture.service.list(BINDING_ID);
    assert.equal(records.pins.find((pin) => pin.id === approved.pin.id)?.status, "revoked");
    assert.equal(records.pins.find((pin) => pin.id === approved.pin.id)?.revokeReason, "local-role-unavailable");
    assert.ok(records.audit.some((entry) => entry.action === "pin-revoked" && entry.reason === "local-role-unavailable"));

    fixture.setRoleResolver(async (roleId) => roleId === "role_admin" ? adminRole : operatorRole);
    const selfActor: CloudDeviceTrustActor = {
      type: "cloud-account",
      id: "account_owner",
      roleIds: ["role_admin"],
      permissionIds: ["settings:manage"],
      deviceTrustPinId: approved.pin.id,
    };
    await assert.rejects(() => fixture.service.approve({
      requestId: unavailable.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(unavailable.request.devicePublicKey),
      expectedRevision: unavailable.request.revision,
      actor: selfActor,
    }), { code: "CLOUD_DEVICE_TRUST_ADMIN_REQUIRED" });
  } finally {
    await fixture.cleanup();
  }
});

test("a transient role lookup failure does not revoke a trusted pin or create a request", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const approved = await fixture.service.approve({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
    });

    const failure = Object.assign(new Error("database temporarily unavailable"), { code: "DATABASE_BUSY" });
    fixture.setRoleResolver(async () => { throw failure; });
    await assert.rejects(() => fixture.service.observeClient(authContext()), failure);

    const records = await fixture.service.list(BINDING_ID);
    assert.equal(records.pins.find((pin) => pin.id === approved.pin.id)?.status, "active");
    assert.equal(records.requests.filter((request) => request.status === "pending").length, 0);
    assert.equal(fixture.closedPins.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("a changed local role revision revokes the old pin before reopening approval", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const approved = await fixture.service.approve({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
    });

    fixture.setRoleResolver(async (roleId) => roleId === "role_admin" ? { ...adminRole, authorizationRevision: 2 } : operatorRole);
    fixture.advance(1_000);
    const changed = await fixture.service.observeClient(authContext());
    assert.equal(changed.kind, "pending");
    if (changed.kind !== "pending") return;
    assert.equal(changed.reason, "role-changed");
    assert.deepEqual(changed.revokedPins?.map((pin) => pin.id), [approved.pin.id]);
    assert.deepEqual(fixture.closedPins, [{ pinId: approved.pin.id, reason: "device-trust-reapproval-required" }]);
    const records = await fixture.service.list(BINDING_ID);
    assert.equal(records.pins.find((pin) => pin.id === approved.pin.id)?.status, "revoked");
    assert.equal(records.pins.find((pin) => pin.id === approved.pin.id)?.revokeReason, "local-role-changed");
    assert.ok(records.audit.some((entry) => entry.action === "pin-revoked" && entry.reason === "local-role-changed"));
  } finally {
    await fixture.cleanup();
  }
});

test("reapproval creates a new pin while retaining the superseded pin as revoked", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const approved = await fixture.service.approve({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
    });

    fixture.setRoleResolver(async (roleId) => roleId === "role_admin"
      ? { ...adminRole, authorizationRevision: adminRole.authorizationRevision + 1 }
      : operatorRole);
    fixture.advance(1_000);
    const changed = await fixture.service.observeClient(authContext());
    assert.equal(changed.kind, "pending");
    if (changed.kind !== "pending") return;
    const reapproved = await fixture.service.approve({
      requestId: changed.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(changed.request.devicePublicKey),
      expectedRevision: changed.request.revision,
      actor: adminActor,
    });

    assert.notEqual(reapproved.pin.id, approved.pin.id);
    assert.equal(reapproved.request.approvedPinId, reapproved.pin.id);
    assert.deepEqual(fixture.closedPins, [{ pinId: approved.pin.id, reason: "device-trust-reapproval-required" }]);
    const records = await fixture.service.list(BINDING_ID);
    assert.equal(records.pins.find((pin) => pin.id === approved.pin.id)?.status, "revoked");
    assert.equal(records.pins.find((pin) => pin.id === approved.pin.id)?.revokeReason, "local-role-changed");
    assert.equal(records.pins.filter((pin) => pin.status === "active").length, 1);
    assert.equal(records.pins.find((pin) => pin.status === "active")?.id, reapproved.pin.id);
  } finally {
    await fixture.cleanup();
  }
});

test("a changed share grant revokes the superseded pin and requires approval", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext({ shareGrantId: "share_original" }));
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const approved = await fixture.service.approve({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
    });

    fixture.advance(1_000);
    const changedGrant = await fixture.service.observeClient(authContext({ shareGrantId: "share_replacement" }));
    assert.equal(changedGrant.kind, "pending");
    if (changedGrant.kind !== "pending") return;
    assert.equal(changedGrant.reason, "share-role-changed");
    assert.deepEqual(changedGrant.revokedPins?.map((pin) => pin.id), [approved.pin.id]);
    assert.deepEqual(fixture.closedPins, [{ pinId: approved.pin.id, reason: "device-trust-reapproval-required" }]);

    const records = await fixture.service.list(BINDING_ID);
    assert.equal(records.requests.filter((request) => request.status === "pending").length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("a changed cloud role revokes the superseded pin and requires approval", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const approved = await fixture.service.approve({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
    });

    fixture.advance(1_000);
    const changedRole = await fixture.service.observeClient(authContext({ cloudAccessRoleId: "role_cloud_admin" }));
    assert.equal(changedRole.kind, "pending");
    if (changedRole.kind !== "pending") return;
    assert.equal(changedRole.reason, "role-changed");
    assert.deepEqual(changedRole.revokedPins?.map((pin) => pin.id), [approved.pin.id]);
    assert.deepEqual(fixture.closedPins, [{ pinId: approved.pin.id, reason: "device-trust-reapproval-required" }]);
  } finally {
    await fixture.cleanup();
  }
});

for (const variant of isolatedAccessContextCases) {
  test(`a ${variant.name} cannot inherit an approved device pin`, async () => {
    const fixture = await createFixture();
    try {
      const pending = await fixture.service.observeClient(authContext());
      assert.equal(pending.kind, "pending");
      if (pending.kind !== "pending") return;
      const approved = await fixture.service.approve({
        requestId: pending.request.id,
        expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
        expectedRevision: pending.request.revision,
        actor: adminActor,
      });

      fixture.advance(1_000);
      const observation = await fixture.service.observeClient(variant.context());
      assert.equal(observation.kind, variant.expected);
      assert.equal("role" in observation, false);
      if (variant.expected === "pending") assert.notEqual(observation.kind, "active");

      const records = await fixture.service.list(BINDING_ID);
      const changedPin = records.pins.find((pin) => pin.status === "active" && pin.id !== approved.pin.id);
      assert.equal(changedPin, undefined);
      if (variant.expected === "authorization-stale") {
        assert.equal(records.pins.find((pin) => pin.id === approved.pin.id)?.status, "active");
      }
    } finally {
      await fixture.cleanup();
    }
  });
}

test("a cloud admin approval records the approving device pin without conflating it with the target pin", async () => {
  const fixture = await createFixture();
  try {
    const approving = await fixture.service.observeClient(authContext({ devicePublicKey: "B".repeat(43) }));
    assert.equal(approving.kind, "pending");
    if (approving.kind !== "pending") return;
    const approver = await fixture.service.approve({
      requestId: approving.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(approving.request.devicePublicKey),
      expectedRevision: approving.request.revision,
      actor: adminActor,
    });

    const pending = await fixture.service.observeClient(authContext({ devicePublicKey: "C".repeat(43) }));
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const cloudActor: CloudDeviceTrustActor = {
      type: "cloud-account",
      id: "cloud-account:account_owner",
      roleIds: ["role_admin"],
      permissionIds: ["settings:manage"],
      deviceTrustPinId: approver.pin.id,
    };
    const approved = await fixture.service.approve({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: cloudActor,
    });

    const audit = (await fixture.service.list(BINDING_ID)).audit.find((entry) => (
      entry.action === "request-approved" && entry.requestId === pending.request.id
    ));
    assert.equal(audit?.actorId, "cloud-account:account_owner");
    assert.equal(audit?.details.actorDevicePinId, approver.pin.id);
    assert.equal(audit?.pinId, approved.pin.id);
  } finally {
    await fixture.cleanup();
  }
});

test("a trusted device cannot approve a pending request for its own public key", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext({ shareGrantId: "share_original" }));
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const approved = await fixture.service.approve({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
    });
    const timestamp = new Date(START + 1_000).toISOString();
    const selfRequestId = "devtrust_self_pending";
    await fixture.database.transaction(async (repository) => repository.cloudDeviceTrust.putRequest({
      id: selfRequestId,
      bindingId: BINDING_ID,
      accountId: "account_guest",
      ownerAccountId: "account_owner",
      accessMode: "shared",
      shareGrantId: "share_replacement",
      shareRevision: 3,
      cloudAccessRoleId: "role_admin",
      devicePublicKey: DEVICE_PUBLIC_KEY,
      reportedName: "Pixel test device",
      clientKind: "mobile",
      clientPlatform: "android",
      clientVersion: "1.0.0",
      status: "pending",
      reason: "share-role-changed",
      requestedAt: timestamp,
      lastSeenAt: timestamp,
      expiresAt: new Date(START + CLOUD_DEVICE_TRUST_REQUEST_TTL_MS).toISOString(),
      createdAt: timestamp,
      revision: 1,
      updatedAt: timestamp,
    }));
    const selfActor: CloudDeviceTrustActor = {
      type: "cloud-account",
      id: "cloud-account:account_guest",
      roleIds: ["role_admin"],
      permissionIds: ["settings:manage"],
      deviceTrustPinId: approved.pin.id,
    };
    await assert.rejects(() => fixture.service.approve({
      requestId: selfRequestId,
      expectedFingerprint: fingerprintDevicePublicKey(DEVICE_PUBLIC_KEY),
      expectedRevision: 1,
      actor: selfActor,
    }), { code: "CLOUD_DEVICE_TRUST_SELF_APPROVAL_FORBIDDEN", statusCode: 403 });
    const records = await fixture.service.list(BINDING_ID);
    assert.equal(records.requests.find((request) => request.id === selfRequestId)?.status, "pending");
  } finally {
    await fixture.cleanup();
  }
});

test("metadata refreshes on a trusted pin without changing its role and clears a stale version", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext({ deviceName: "Old name" }));
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const approved = await fixture.service.approve({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
    });

    fixture.advance(1_000);
    const changesBeforeRefresh = fixture.changes.length;
    const refreshed = await fixture.service.observeClient(authContext({ deviceName: "New name", deviceVersion: null }));
    assert.equal(refreshed.kind, "active");
    if (refreshed.kind !== "active") return;
    assert.equal(refreshed.pin.id, approved.pin.id);
    assert.equal(refreshed.pin.roleId, "role_admin");
    assert.equal(refreshed.pin.reportedName, "New name");
    assert.equal(refreshed.pin.clientVersion, undefined);
    assert.equal(fixture.changes.length, changesBeforeRefresh + 1);
    assert.equal(fixture.changes.at(-1)?.bindingId, BINDING_ID);
    assert.equal((await fixture.service.list(BINDING_ID)).pins.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("share revision growth converges the pin while a rollback fails closed without a new request", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext({ shareRevision: 2 }));
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const approved = await fixture.service.approve({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
    });
    assert.equal(approved.pin.shareRevision, 2);

    fixture.advance(1_000);
    const converged = await fixture.service.observeClient(authContext({ shareRevision: 3 }));
    assert.equal(converged.kind, "active");
    if (converged.kind !== "active") return;
    assert.equal(converged.pin.shareRevision, 3);
    assert.ok((await fixture.service.list(BINDING_ID)).audit.some((entry) => entry.action === "pin-revision-converged"));

    fixture.advance(1_000);
    const stale = await fixture.service.observeClient(authContext({ shareRevision: 1 }));
    assert.equal(stale.kind, "authorization-stale");
    const records = await fixture.service.list(BINDING_ID);
    assert.equal(records.requests.filter((request) => request.status === "pending").length, 0);
    assert.equal(records.pins[0]?.shareRevision, 3);
  } finally {
    await fixture.cleanup();
  }
});

test("proactive expiry records one audit entry and leaves a retryable expired result", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;

    fixture.setNow(Date.parse(pending.request.expiresAt) + 1);
    assert.equal(await fixture.service.expire(BINDING_ID), 1);
    assert.equal(await fixture.service.expire(BINDING_ID), 0);
    const expired = await fixture.service.observeClient(authContext());
    assert.equal(expired.kind, "expired");
    if (expired.kind !== "expired") return;
    assert.equal(expired.request.id, pending.request.id);
    const records = await fixture.service.list(BINDING_ID);
    assert.equal(records.requests.filter((request) => request.status === "expired").length, 1);
    assert.equal(records.audit.filter((entry) => entry.action === "request-expired").length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("admin snapshot expires pending requests before projecting them", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;

    fixture.setNow(Date.parse(pending.request.expiresAt) + 1);
    const snapshot = await fixture.service.snapshot(BINDING_ID, []);
    assert.equal(snapshot.requests[0]?.requestId, pending.request.id);
    assert.equal(snapshot.requests[0]?.status, "expired");
    assert.equal(snapshot.requests.filter((request) => request.status === "pending").length, 0);
    assert.equal(fixture.changes.at(-1)?.bindingId, BINDING_ID);

    const records = await fixture.service.list(BINDING_ID);
    assert.equal(records.requests.filter((request) => request.status === "expired").length, 1);
    assert.equal(records.audit.filter((entry) => entry.action === "request-expired").length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("stored device trust rows ignore unknown historical fields without leaking them", async () => {
  const fixture = await createFixture();
  try {
    const pending = await fixture.service.observeClient(authContext());
    assert.equal(pending.kind, "pending");
    if (pending.kind !== "pending") return;
    const approved = await fixture.service.approve({
      requestId: pending.request.id,
      expectedFingerprint: fingerprintDevicePublicKey(pending.request.devicePublicKey),
      expectedRevision: pending.request.revision,
      actor: adminActor,
    });
    const storedPin = parseStoredCloudDevicePinRecord({ ...approved.pin, futureOptionalField: { nested: true } });
    const storedRequest = parseStoredCloudDeviceTrustRequestRecord({ ...approved.request, futureOptionalField: "ignored" });
    assert.equal(storedPin.id, approved.pin.id);
    assert.equal(storedRequest.id, approved.request.id);
    assert.equal("futureOptionalField" in storedPin, false);
    assert.equal("futureOptionalField" in storedRequest, false);
    assert.equal(CloudDevicePinRecordSchema.safeParse({ ...approved.pin, futureOptionalField: true }).success, false);
    assert.equal(CloudDeviceTrustRequestRecordSchema.safeParse({ ...approved.request, futureOptionalField: true }).success, false);
  } finally {
    await fixture.cleanup();
  }
});
