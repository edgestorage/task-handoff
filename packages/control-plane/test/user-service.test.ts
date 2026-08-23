import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ControlPlaneUserService } from "../src/control-plane/auth/user-service.ts";
import { ControlPlaneIdentityProviderService } from "../src/control-plane/auth/identity-provider-service.ts";
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
    assert.deepEqual(viewer.accessGrant.instanceScope, { kind: "inherit-node-scope" });
    assert.equal((await fixture.service.authorization(viewer.id)).permissionIds.every((id) => id.endsWith(":read")), true);
    const disabled = await fixture.service.updateUser(viewer.id, { status: "disabled" });
    assert.equal(disabled.status, "disabled");
    await assert.rejects(() => fixture.service.authorization(viewer.id), { code: "CONTROL_PLANE_USER_DISABLED" });
    const archived = await fixture.service.updateUser(viewer.id, { status: "archived" });
    assert.equal(archived.status, "archived");
    assert.equal("archivedAt" in archived, false);
    assert.equal("archivedAt" in (await fixture.service.list({ includeArchived: true })).find((user) => user.id === viewer.id)!, false);
    await assert.rejects(() => fixture.service.updateUser(admin.id, { status: "disabled" }), { code: "CONTROL_PLANE_LAST_ACTIVE_ADMIN" });
  } finally {
    await fixture.dispose();
  }
});

test("local usernames are normalized and remain unique when administrators rename users", async () => {
  const fixture = serviceFixture();
  try {
    await fixture.service.bootstrapAdmin({ username: "admin", password: "password123" });
    const alice = await fixture.service.createLocalUser({
      username: "alice",
      password: "password123",
      roleIds: [SYSTEM_ROLE_IDS.viewer],
      nodeScope: { kind: "all" },
    });
    const bob = await fixture.service.createLocalUser({
      username: "bob",
      password: "password123",
      roleIds: [SYSTEM_ROLE_IDS.viewer],
      nodeScope: { kind: "all" },
    });

    const renamed = await fixture.service.updateUser(alice.id, { displayName: "Alice Doe", username: "Alice.New" });
    assert.equal(renamed.displayName, "Alice Doe");
    assert.equal(renamed.primaryUsername, "alice.new");
    assert.equal(renamed.identities.find((identity) => identity.kind === "local-password")?.loginName, "alice.new");
    await assert.rejects(() => fixture.service.updateUser(bob.id, { username: "ALICE.NEW" }), { code: "CONTROL_PLANE_USERNAME_CONFLICT" });
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
      instanceScope: { kind: "selected", instanceIds: ["instance_2", "instance_1", "instance_2"] },
      expectedAuthorizationRevision: 1,
    });
    assert.equal(updated.accessGrant.authorizationRevision, 2);
    assert.deepEqual(updated.accessGrant.instanceScope, { kind: "selected", instanceIds: ["instance_1", "instance_2"] });
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

test("deleting an instance removes stale instance scope grants and revokes sessions", async () => {
  const fixture = serviceFixture();
  try {
    await fixture.service.bootstrapAdmin({ username: "admin", password: "password123" });
    const user = await fixture.service.createLocalUser({
      username: "scoped-user",
      password: "temporary-password",
      roleIds: [SYSTEM_ROLE_IDS.viewer],
      nodeScope: { kind: "selected", nodeIds: [] },
      instanceScope: { kind: "selected", instanceIds: ["instance-a", "instance-b"] },
    });
    const createdAt = new Date().toISOString();
    await fixture.service.store.sessions.put({
      id: "session_scoped_user",
      userId: user.id,
      identityId: user.identities[0].id,
      tokenHash: "hash",
      clientType: "web",
      authorizationRevision: user.accessGrant.authorizationRevision,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const affected = await fixture.service.removeInstanceFromAccessScopes("instance-a");

    assert.deepEqual(affected, [user.id]);
    assert.deepEqual((await fixture.service.authorization(user.id)).instanceScope, { kind: "selected", instanceIds: ["instance-b"] });
    assert.equal(await fixture.service.store.sessions.get("session_scoped_user"), undefined);
    assert.equal((await fixture.service.authorization(user.id)).authorizationRevision, user.accessGrant.authorizationRevision + 1);
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

test("archived role names can be reused and archived again", async () => {
  const fixture = serviceFixture();
  try {
    await fixture.service.bootstrapAdmin({ username: "admin", password: "password123" });
    const first = await fixture.service.createRole({ name: "Node reader", permissionIds: ["nodes:read"] });
    await fixture.service.archiveRole(first.id);

    const replacement = await fixture.service.createRole({ name: "node READER", permissionIds: ["nodes:read"] });
    await assert.rejects(
      () => fixture.service.createRole({ name: "NODE READER", permissionIds: ["nodes:read"] }),
      { code: "CONTROL_PLANE_ROLE_NAME_CONFLICT" },
    );
    const archived = await fixture.service.archiveRole(replacement.id);
    assert.equal(archived.status, "archived");
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

test("local password identities are immutable while external identities can be unbound", async () => {
  const fixture = serviceFixture();
  try {
    const admin = await fixture.service.bootstrapAdmin({ username: "admin", password: "password123" });
    const paths = controlPlaneStorePaths(fixture.dataDir);
    const providers = new ControlPlaneIdentityProviderService(paths, fixture.service);
    providers.init();
    const provider = await providers.create({
      name: "GitHub",
      kind: "github",
      status: "enabled",
      clientId: "id",
      clientSecret: "secret",
      callbackUrl: "https://cp.example.com/callback",
    });
    const timestamp = new Date().toISOString();
    await fixture.service.store.identities.put({ id: "identity_github_admin", userId: admin.id, providerId: provider.id, subject: "admin-subject", kind: "oauth", createdAt: timestamp, updatedAt: timestamp });
    const local = admin.identities[0];

    const storedProvider = (await fixture.service.store.providers.get(provider.id))!;
    await fixture.service.store.providers.put({ ...storedProvider, status: "disabled", updatedAt: new Date().toISOString() });
    await assert.rejects(() => fixture.service.unbindExternalIdentity(admin.id, local.id), {
      code: "CONTROL_PLANE_LOCAL_IDENTITY_IMMUTABLE",
    });
    await fixture.service.store.providers.put({ ...storedProvider, status: "enabled", updatedAt: new Date().toISOString() });
    await assert.rejects(() => fixture.service.unbindExternalIdentity(admin.id, local.id), { code: "CONTROL_PLANE_LOCAL_IDENTITY_IMMUTABLE" });
    assert.deepEqual(await fixture.service.unbindExternalIdentity(admin.id, "identity_github_admin"), { unbound: true });
  } finally {
    await fixture.dispose();
  }
});
