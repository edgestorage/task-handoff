const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
  ControlPlaneProxyErrorCode,
} = require("../packages/protocol/src/control-plane-proxy.ts");
const {
  ControlPlaneProxyService,
} = require("../packages/control-plane/src/control-plane/proxy/service.ts");
const {
  ControlPlaneProxyStore,
} = require("../packages/control-plane/src/control-plane/proxy/store.ts");

const credential = "a_generated_binding_credential_0123456789";

function target(id, overrides = {}) {
  return {
    id,
    name: `Target ${id}`,
    status: "online",
    health: "ok",
    capabilities: {},
    manageable: true,
    ...overrides,
  };
}

function fixture(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-proxy-"));
  const authorityFile = path.join(dataDir, "proxy", "authority.json");
  const targets = new Map([
    ["node_a", target("node_a")],
    ["node_b", target("node_b")],
  ]);
  const warnings = [];
  const store = new ControlPlaneProxyStore(authorityFile, (message, details) => warnings.push({ message, details }));
  const service = new ControlPlaneProxyService(store, { get: (nodeId) => targets.get(nodeId) }, {
    proxyOrigin: "https://proxy.example.test",
    ...options,
  });
  service.init();
  return { authorityFile, dataDir, service, store, targets, warnings };
}

function claim(invite, overrides = {}) {
  return {
    protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
    inviteToken: invite.token,
    claimId: "claim_a",
    sourceControlPlaneId: "control_plane_a",
    targetNodeId: "node_a",
    bindingKeyId: "binding_key_a",
    credential,
    ...overrides,
  };
}

function assertCode(code) {
  return (error) => error?.code === code;
}

test("invite creation requires an explicitly reachable HTTPS proxy origin", () => {
  const { service } = fixture({ proxyOrigin: undefined });
  assert.throws(
    () => service.createInvite({ targetNodeId: "node_a" }, "user_admin"),
    assertCode(ControlPlaneProxyErrorCode.Unavailable),
  );
});

test("invite creation reads the current proxy origin and rejects malformed settings without crashing", () => {
  let proxyOrigin;
  const { service } = fixture({
    proxyOrigin: undefined,
    proxyOriginProvider: () => proxyOrigin,
  });

  assert.throws(
    () => service.createInvite({ targetNodeId: "node_a" }, "user_admin"),
    assertCode(ControlPlaneProxyErrorCode.Unavailable),
  );

  proxyOrigin = "https://proxy.example.test/control-plane";
  assert.throws(
    () => service.createInvite({ targetNodeId: "node_a" }, "user_admin"),
    assertCode(ControlPlaneProxyErrorCode.Unavailable),
  );

  proxyOrigin = "https://new-proxy.example.test";
  assert.equal(
    service.createInvite({ targetNodeId: "node_a" }, "user_admin").proxyOrigin,
    proxyOrigin,
  );
});

test("explicit proxy origin keeps precedence over the dynamic settings provider", () => {
  let proxyOrigin = "https://settings.example.test";
  const { service } = fixture({ proxyOriginProvider: () => proxyOrigin });
  proxyOrigin = "https://changed-settings.example.test";
  assert.equal(
    service.createInvite({ targetNodeId: "node_a" }, "user_admin").proxyOrigin,
    "https://proxy.example.test",
  );
});

test("proxy invite is target-bound and returns plaintext only in its creation result", () => {
  const { authorityFile, service, store, targets } = fixture();
  const created = service.createInvite({ targetNodeId: "node_a" }, "user_admin");

  assert.ok(created.token.length >= 24);
  assert.equal(created.proxyOrigin, "https://proxy.example.test");
  assert.equal(created.invite.targetNodeId, "node_a");
  assert.equal(created.invite.tokenHash, undefined);
  assert.equal(service.listInvites()[0].token, undefined);

  const persisted = JSON.parse(fs.readFileSync(authorityFile, "utf8")).invites[0];
  assert.equal(persisted.token, undefined);
  assert.equal(persisted.tokenHash, crypto.createHash("sha256").update(created.token).digest("base64url"));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.dirname(authorityFile)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(authorityFile).mode & 0o777, 0o600);
  }

  targets.set("node_offline", target("node_offline", { status: "offline", manageable: false }));
  assert.throws(
    () => service.createInvite({ targetNodeId: "node_offline" }, "user_admin"),
    (error) => error.code === ControlPlaneProxyErrorCode.TargetUnavailable && error.retryable === true,
  );
  assert.throws(
    () => service.createInvite({ targetNodeId: "node_missing" }, "user_admin"),
    (error) => error.code === ControlPlaneProxyErrorCode.TargetUnavailable && error.retryable === false,
  );
});

test("claim stores only the A-generated credential hash and exposes only public records", () => {
  const { service, store } = fixture();
  const invite = service.createInvite({ targetNodeId: "node_a" }, "user_admin");
  const result = service.claimInvite(claim(invite));

  assert.equal(result.binding.targetNodeId, "node_a");
  assert.equal(result.binding.sourceControlPlaneId, "control_plane_a");
  assert.equal(result.target.id, "node_a");
  assert.equal(result.binding.credentialHash, undefined);
  assert.equal(result.target.manageable, undefined);
  assert.equal(service.listBindings()[0].credentialHash, undefined);
  assert.equal(store.getInvite(invite.invite.id).status, "consumed");

  const persisted = store.snapshot().bindings[0];
  assert.equal(persisted.credential, undefined);
  assert.equal(persisted.credentialHash, crypto.createHash("sha256").update(credential).digest("base64url"));
  assert.equal(JSON.stringify(result).includes(credential), false);
});

test("claim is exactly idempotent and rejects target or identity substitution without partial writes", async () => {
  const { service, store } = fixture();
  const invite = service.createInvite({ targetNodeId: "node_a" }, "user_admin");
  const input = claim(invite);
  const [first, replay] = await Promise.all([
    Promise.resolve().then(() => service.claimInvite(input)),
    Promise.resolve().then(() => service.claimInvite(input)),
  ]);

  assert.equal(first.binding.id, replay.binding.id);
  const { inviteToken: _inviteToken, ...recoveryInput } = input;
  assert.equal(service.claimInvite(recoveryInput).binding.id, first.binding.id);
  assert.equal(store.listBindings().length, 1);
  assert.equal(store.getInvite(invite.invite.id).consumedByClaimId, input.claimId);

  for (const changed of [
    { sourceControlPlaneId: "control_plane_attacker" },
    { bindingKeyId: "binding_key_attacker" },
    { credential: "attacker_generated_binding_credential_012345" },
  ]) {
    assert.throws(
      () => service.claimInvite({ ...input, ...changed }),
      assertCode(ControlPlaneProxyErrorCode.BindingIdentityConflict),
    );
  }
  assert.throws(
    () => service.claimInvite({ ...input, targetNodeId: "node_b" }),
    assertCode(ControlPlaneProxyErrorCode.TargetMismatch),
  );
  assert.equal(store.listBindings().length, 1);

  assert.throws(
    () => service.claimInvite({ ...input, claimId: "claim_replay" }),
    assertCode(ControlPlaneProxyErrorCode.BindingIdentityConflict),
  );
  const secondInvite = service.createInvite({ targetNodeId: "node_a" }, "user_admin");
  assert.throws(
    () => service.claimInvite({ ...input, inviteToken: secondInvite.token }),
    assertCode(ControlPlaneProxyErrorCode.BindingIdentityConflict),
  );
  assert.equal(store.listBindings().length, 1);
});

test("expired and revoked invites fail deterministically without creating bindings", () => {
  let now = new Date("2026-08-01T00:00:00.000Z");
  const { service, store } = fixture({ now: () => now });
  const expired = service.createInvite({ targetNodeId: "node_a", expiresInSeconds: 60 }, "user_admin");
  now = new Date("2026-08-01T00:01:01.000Z");
  assert.throws(() => service.claimInvite(claim(expired)), assertCode(ControlPlaneProxyErrorCode.InviteExpired));

  const revoked = service.createInvite({ targetNodeId: "node_a" }, "user_admin");
  service.revokeInvite(revoked.invite.id);
  assert.throws(
    () => service.claimInvite(claim(revoked, { claimId: "claim_revoked" })),
    assertCode(ControlPlaneProxyErrorCode.InviteRevoked),
  );
  assert.equal(store.listBindings().length, 0);
});

test("claim commits invite consumption and binding in one authority revision", () => {
  const { authorityFile, service, store } = fixture();
  const invite = service.createInvite({ targetNodeId: "node_a" }, "user_admin");
  const before = store.snapshot().revision;
  const result = service.claimInvite(claim(invite, { claimId: "claim_atomic" }));
  const authority = JSON.parse(fs.readFileSync(authorityFile, "utf8"));
  assert.equal(authority.revision, before + 1);
  assert.equal(authority.invites[0].status, "consumed");
  assert.equal(authority.invites[0].consumedByClaimId, "claim_atomic");
  assert.equal(authority.bindings.length, 1);
  assert.equal(authority.bindings[0].id, result.binding.id);
});

test("binding authentication is isolated by binding, source, key and credential and respects revocation", () => {
  const { service } = fixture();
  const inviteA = service.createInvite({ targetNodeId: "node_a" }, "user_admin");
  const inviteB = service.createInvite({ targetNodeId: "node_b" }, "user_admin");
  const bindingA = service.claimInvite(claim(inviteA)).binding;
  const credentialB = "second_target_binding_credential_0123456789";
  const bindingB = service.claimInvite(claim(inviteB, {
    claimId: "claim_b",
    targetNodeId: "node_b",
    bindingKeyId: "binding_key_b",
    credential: credentialB,
  })).binding;

  assert.equal(service.authenticateBinding(bindingA.id, {
    sourceControlPlaneId: "control_plane_a",
    bindingKeyId: "binding_key_a",
    credential,
  }).targetNodeId, "node_a");
  assert.throws(() => service.authenticateBinding(bindingA.id, {
    sourceControlPlaneId: "control_plane_a",
    bindingKeyId: "binding_key_b",
    credential: credentialB,
  }), assertCode(ControlPlaneProxyErrorCode.AuthenticationFailed));
  assert.equal(service.authenticateBinding(bindingB.id, {
    sourceControlPlaneId: "control_plane_a",
    bindingKeyId: "binding_key_b",
    credential: credentialB,
  }).targetNodeId, "node_b");

  const revoked = service.revokeBinding(bindingA.id);
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revision, 2);
  assert.deepEqual(service.revokeBinding(bindingA.id), revoked);
  assert.throws(() => service.authenticateBinding(bindingA.id, {
    sourceControlPlaneId: "control_plane_a",
    bindingKeyId: "binding_key_a",
    credential,
  }), assertCode(ControlPlaneProxyErrorCode.BindingRevoked));
});

test("target deletion revokes only related authorization and does not mutate the target directory", () => {
  const { service, targets } = fixture();
  const bindingA = service.claimInvite(claim(service.createInvite({ targetNodeId: "node_a" }, "user_admin"))).binding;
  const pendingA = service.createInvite({ targetNodeId: "node_a" }, "user_admin");
  const credentialB = "second_target_binding_credential_0123456789";
  const bindingB = service.claimInvite(claim(service.createInvite({ targetNodeId: "node_b" }, "user_admin"), {
    claimId: "claim_b",
    targetNodeId: "node_b",
    bindingKeyId: "binding_key_b",
    credential: credentialB,
  })).binding;

  const result = service.revokeTarget("node_a");
  assert.deepEqual(result.bindings.map((binding) => binding.id), [bindingA.id]);
  assert.deepEqual(result.invites.map((invite) => invite.id), [pendingA.invite.id]);
  assert.equal(targets.has("node_a"), true);
  assert.equal(service.listBindings().find((binding) => binding.id === bindingB.id).status, "active");
});

test("stored proxy records sanitize future fields before strict parsing", () => {
  const { authorityFile, service } = fixture();
  const invite = service.createInvite({ targetNodeId: "node_a" }, "user_admin");
  const persisted = JSON.parse(fs.readFileSync(authorityFile, "utf8"));
  persisted.futureAuthorityField = true;
  persisted.invites[0].futureField = true;
  fs.writeFileSync(authorityFile, JSON.stringify(persisted));

  const warnings = [];
  const restarted = new ControlPlaneProxyStore(authorityFile, (message, details) => warnings.push({ message, details }));
  restarted.init();
  assert.equal(restarted.getInvite(invite.invite.id).id, invite.invite.id);
  assert.equal(warnings.some((warning) => warning.details.fields?.includes("futureField")), true);
});
