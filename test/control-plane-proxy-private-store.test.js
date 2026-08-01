const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  ControlPlaneProxyPrivateStore,
  controlPlaneProxyPrivateStorePaths,
  publicPendingProxyClaim,
} = require("../packages/control-plane/src/control-plane/nodes/control-plane-proxy-private-store.ts");

const now = "2026-08-01T00:00:00.000Z";

function pending(overrides = {}) {
  return {
    id: "pending_1",
    claimId: "claim_1",
    proxyOrigin: "https://proxy.example.test",
    sourceControlPlaneId: "control_plane_a",
    targetNodeId: "target_b",
    bindingKeyId: "binding_key_1",
    credential: "c".repeat(48),
    status: "pending",
    createdAt: now,
    updatedAt: now,
    expiresAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

function nodeCredential(overrides = {}) {
  return {
    id: "credential_1",
    nodeId: "node_b",
    proxyOrigin: "https://proxy.example.test",
    proxyBindingId: "binding_1",
    targetNodeId: "target_b",
    sourceControlPlaneId: "control_plane_a",
    bindingKeyId: "binding_key_1",
    credential: "c".repeat(48),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("proxy private store uses private modes and public receipts never expose credentials", { skip: process.platform === "win32" }, () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-proxy-private-"));
  const paths = controlPlaneProxyPrivateStorePaths(dataDir);
  const store = new ControlPlaneProxyPrivateStore(paths);
  store.init(Date.parse(now));
  const record = store.pendingClaims.put(pending());
  store.nodeCredentials.put(nodeCredential());

  assert.equal(fs.statSync(paths.pendingClaimsDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.nodeCredentialsDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.pendingClaims.filePath(record.id)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(store.nodeCredentials.filePath("credential_1")).mode & 0o777, 0o600);
  const receipt = publicPendingProxyClaim(record);
  assert.equal("credential" in receipt, false);
  assert.equal(JSON.stringify(store.publicPendingClaims()).includes(record.credential), false);
});

test("proxy private store sanitizes unknown persisted fields and reports a warning", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-proxy-sanitize-"));
  const paths = controlPlaneProxyPrivateStorePaths(dataDir);
  const warnings = [];
  fs.mkdirSync(paths.pendingClaimsDir, { recursive: true });
  fs.writeFileSync(path.join(paths.pendingClaimsDir, "pending_1.json"), JSON.stringify({ ...pending(), futureField: true }));
  const store = new ControlPlaneProxyPrivateStore(paths, (message, details) => warnings.push({ message, details }));

  assert.equal(store.pendingClaims.get("pending_1").claimId, "claim_1");
  assert.equal("futureField" in store.pendingClaims.get("pending_1"), false);
  assert.deepEqual(warnings[0].details.fields, ["futureField"]);
});

test("proxy pending claim promotion is identity-exact and persists credential before removing receipt", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-proxy-promote-"));
  const store = new ControlPlaneProxyPrivateStore(controlPlaneProxyPrivateStorePaths(dataDir));
  store.pendingClaims.put(pending());

  assert.throws(
    () => store.promotePendingClaim("claim_1", nodeCredential({ bindingKeyId: "different_key" })),
    (error) => error.code === "CONTROL_PLANE_PROXY_BINDING_IDENTITY_CONFLICT",
  );
  assert.ok(store.pendingClaimByClaimId("claim_1"));
  assert.equal(store.nodeCredential("node_b"), undefined);

  const saved = store.promotePendingClaim("claim_1", nodeCredential());
  assert.equal(saved.proxyBindingId, "binding_1");
  assert.equal(store.pendingClaimByClaimId("claim_1"), undefined);
  assert.equal(store.nodeCredential("node_b").credential, "c".repeat(48));
});

test("proxy pending claim retries reuse one stable identity and promotion may resolve an invited target", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-proxy-idempotent-"));
  const store = new ControlPlaneProxyPrivateStore(controlPlaneProxyPrivateStorePaths(dataDir));
  const first = store.putPendingClaim(pending({ targetNodeId: undefined }));
  assert.equal(store.putPendingClaim({ ...first, id: "duplicate_record" }).id, first.id);
  assert.throws(
    () => store.putPendingClaim({ ...first, id: "conflict", credential: "d".repeat(48) }),
    (error) => error.code === "CONTROL_PLANE_PROXY_BINDING_IDENTITY_CONFLICT",
  );
  assert.equal(store.pendingClaims.list().length, 1);
  assert.equal(store.promotePendingClaim(first.claimId, nodeCredential()).targetNodeId, "target_b");
});

test("proxy pending claim TTL cleanup retains compensation work", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-proxy-gc-"));
  const store = new ControlPlaneProxyPrivateStore(controlPlaneProxyPrivateStorePaths(dataDir));
  store.pendingClaims.put(pending({ id: "expired", claimId: "expired", expiresAt: "2026-07-31T00:00:00.000Z" }));
  store.pendingClaims.put(pending({ id: "future", claimId: "future" }));
  store.pendingClaims.put(pending({ id: "compensate", claimId: "compensate", status: "compensation-required", expiresAt: "2026-07-31T00:00:00.000Z" }));

  assert.deepEqual(store.gcPendingClaims(Date.parse(now)), ["expired"]);
  assert.equal(store.pendingClaims.get("expired"), undefined);
  assert.ok(store.pendingClaims.get("future"));
  assert.ok(store.pendingClaims.get("compensate"));
});

test("proxy pending claim cancellation preserves credentials until required compensation completes", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-proxy-cancel-"));
  const store = new ControlPlaneProxyPrivateStore(controlPlaneProxyPrivateStorePaths(dataDir));
  store.putPendingClaim(pending({ id: "local_only", claimId: "local_only" }));
  store.putPendingClaim(pending({ id: "remote_unknown", claimId: "remote_unknown" }));

  assert.deepEqual(store.cancelPendingClaim("local_only", false), { deleted: true, compensationRequired: false });
  assert.deepEqual(store.cancelPendingClaim("remote_unknown", true), { deleted: false, compensationRequired: true });
  assert.equal(store.pendingClaimByClaimId("remote_unknown").credential, "c".repeat(48));
  assert.equal(store.completePendingClaimCompensation("remote_unknown"), true);
  assert.equal(store.pendingClaimByClaimId("remote_unknown"), undefined);
});

test("proxy node credential storage rejects a different binding for an existing node", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-proxy-node-conflict-"));
  const store = new ControlPlaneProxyPrivateStore(controlPlaneProxyPrivateStorePaths(dataDir));
  const first = store.putNodeCredential(nodeCredential());
  assert.equal(store.putNodeCredential({ ...first, id: "duplicate" }).id, first.id);
  assert.throws(
    () => store.putNodeCredential(nodeCredential({ id: "other", proxyBindingId: "binding_2" })),
    (error) => error.code === "CONTROL_PLANE_PROXY_NODE_IDENTITY_CONFLICT" && error.statusCode === 409,
  );
});
