import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlaneUserService } from "../src/control-plane/auth/user-service.ts";
import { SYSTEM_ROLE_IDS } from "../src/control-plane/auth/user-store.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";

function serviceFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-user-service-"));
  const service = new ControlPlaneUserService(controlPlaneStorePaths(dataDir));
  return { dataDir, service, dispose: async () => { await service.store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); } };
}

test("bootstrap creates one stable user with local identity and admin access", async () => {
  const fixture = serviceFixture();
  try {
    const admin = await fixture.service.bootstrapAdmin({ username: "Admin", password: "password123" });
    assert.equal(admin.primaryUsername, "admin");
    assert.equal(admin.identities.length, 1);
    assert.equal(admin.identities[0].kind, "local-password");
    assert.deepEqual(admin.accessGrant.roleIds, [SYSTEM_ROLE_IDS.admin]);
    assert.equal("passwordHash" in admin.identities[0], false);
    await assert.rejects(() => fixture.service.bootstrapAdmin({ username: "other", password: "password123" }), { code: "AUTH_BOOTSTRAP_ALREADY_DONE" });
  } finally {
    await fixture.dispose();
  }
});

test("user lifecycle keeps authorization on user and protects the last admin", async () => {
  const fixture = serviceFixture();
  try {
    const admin = await fixture.service.bootstrapAdmin({ username: "admin", password: "password123" });
    const viewer = await fixture.service.createLocalUser({
      username: "Alice",
      password: "password123",
      roleIds: [SYSTEM_ROLE_IDS.viewer],
      nodeScope: { kind: "selected", nodeIds: ["node_b", "node_a", "node_a"] },
      requirePasswordChange: true,
    });
    assert.deepEqual(viewer.accessGrant.nodeScope, { kind: "selected", nodeIds: ["node_a", "node_b"] });
    assert.equal(fixture.service.authorization(viewer.id).permissionIds.every((id) => id.endsWith(":read")), true);
    const disabled = await fixture.service.updateUser(viewer.id, { status: "disabled" });
    assert.equal(disabled.status, "disabled");
    assert.throws(() => fixture.service.authorization(viewer.id), { code: "CONTROL_PLANE_USER_DISABLED" });
    await assert.rejects(() => fixture.service.updateUser(admin.id, { status: "disabled" }), { code: "CONTROL_PLANE_LAST_ACTIVE_ADMIN" });
  } finally {
    await fixture.dispose();
  }
});

test("authorization revisions are optimistic and password reset exposes no secret", async () => {
  const fixture = serviceFixture();
  try {
    await fixture.service.bootstrapAdmin({ username: "admin", password: "password123" });
    const user = await fixture.service.createLocalUser({
      username: "operator",
      password: "password123",
      roleIds: [SYSTEM_ROLE_IDS.operator],
      nodeScope: { kind: "selected", nodeIds: ["node_1"] },
    });
    const updated = await fixture.service.setAccess(user.id, {
      roleIds: [SYSTEM_ROLE_IDS.operator, SYSTEM_ROLE_IDS.viewer],
      nodeScope: { kind: "selected", nodeIds: ["node_2"] },
      expectedAuthorizationRevision: 1,
    });
    assert.equal(updated.accessGrant.authorizationRevision, 2);
    await assert.rejects(() => fixture.service.setAccess(user.id, {
      roleIds: [SYSTEM_ROLE_IDS.viewer],
      nodeScope: { kind: "all" },
      expectedAuthorizationRevision: 1,
    }), { code: "CONTROL_PLANE_AUTHORIZATION_REVISION_CONFLICT" });
    const identity = await fixture.service.resetLocalPassword(user.id, "new-password-123");
    assert.equal(identity.requiresPasswordChange, true);
    assert.equal("passwordHash" in identity, false);
  } finally {
    await fixture.dispose();
  }
});

test("custom roles validate catalog permissions and protect referenced roles", async () => {
  const fixture = serviceFixture();
  try {
    await fixture.service.bootstrapAdmin({ username: "admin", password: "password123" });
    const role = await fixture.service.createRole({ name: "Node reader", permissionIds: ["nodes:read", "instances:read"] });
    assert.equal(role.system, false);
    await assert.rejects(async () => fixture.service.createLocalUser({
      username: "reader",
      password: "password123",
      roleIds: [role.id],
      nodeScope: { kind: "selected", nodeIds: ["node_1"] },
    }).then((user) => {
      return fixture.service.archiveRole(role.id).then(() => user);
    }), { code: "CONTROL_PLANE_ROLE_IN_USE" });
    await assert.rejects(() => fixture.service.createRole({ name: "bad", permissionIds: ["unknown:permission"] }));
    await assert.rejects(() => fixture.service.archiveRole(SYSTEM_ROLE_IDS.admin), { code: "CONTROL_PLANE_SYSTEM_ROLE_IMMUTABLE" });
  } finally {
    await fixture.dispose();
  }
});

test("recovery replaces one local identity and revokes its sessions", async () => {
  const fixture = serviceFixture();
  try {
    const admin = await fixture.service.bootstrapAdmin({ username: "admin", password: "password123" });
    const recovered = await fixture.service.recoverLocalCredentials({ username: "root", password: "new-password-123" });
    assert.equal(recovered.id, admin.id);
    assert.equal(recovered.primaryUsername, "root");
    assert.equal(recovered.accessGrant.authorizationRevision, admin.accessGrant.authorizationRevision + 1);
  } finally {
    await fixture.dispose();
  }
});

test("external identity subject is unique within its provider", async () => {
  const fixture = serviceFixture();
  try {
    const admin = await fixture.service.bootstrapAdmin({ username: "admin", password: "password123" });
    const timestamp = new Date().toISOString();
    await fixture.service.store.providers.put({
      id: "idp_github",
      name: "GitHub",
      kind: "github",
      status: "enabled",
      loginPolicy: "existing-only",
      clientId: "id",
      clientSecretCiphertext: "encrypted",
      callbackUrl: "https://cp.example.com/callback",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await fixture.service.bindExternalIdentity(admin.id, { providerId: "idp_github", subject: "123", kind: "oauth" });
    await assert.rejects(() => fixture.service.bindExternalIdentity(admin.id, { providerId: "idp_github", subject: "123", kind: "oauth" }), { code: "CONTROL_PLANE_EXTERNAL_IDENTITY_CONFLICT" });
  } finally {
    await fixture.dispose();
  }
});
