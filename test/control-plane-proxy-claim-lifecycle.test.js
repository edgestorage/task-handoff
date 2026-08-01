const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CONTROL_PLANE_PROXY_AUTH_HEADERS,
  CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
  ControlPlaneProxyErrorCode,
} = require("../packages/protocol/src/control-plane-proxy.ts");
const { ControlPlaneService } = require("../packages/control-plane/src/control-plane/application/service.ts");
const { controlPlaneStorePaths } = require("../packages/control-plane/src/control-plane/persistence/paths.ts");
const {
  registerControlPlaneProxyManagementRoutes,
} = require("../packages/control-plane/src/control-plane/http/control-plane-proxy-management-routes.ts");
const { registerNodeRoutes } = require("../packages/control-plane/src/control-plane/http/node-routes.ts");

const timestamp = "2026-08-01T00:00:00.000Z";

function claimResult(body) {
  return {
    protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
    binding: {
      id: "proxy_binding_1",
      claimId: body.claimId,
      sourceControlPlaneId: body.sourceControlPlaneId,
      targetNodeId: "node_b",
      bindingKeyId: body.bindingKeyId,
      status: "active",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    target: {
      id: "node_b",
      name: "Node B",
      status: "online",
      health: "ok",
      capabilities: {},
    },
  };
}

function revokeReceipt(body) {
  return {
    data: {
      binding: {
        ...claimResult(body).binding,
        status: "revoked",
        revision: 2,
        revokedAt: timestamp,
        updatedAt: timestamp,
      },
      closed: { abortedRequests: 0, closedSockets: 0 },
    },
  };
}

function fixture(fetchImpl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-claim-lifecycle-"));
  const service = new ControlPlaneService(controlPlaneStorePaths(dataDir), { fetchImpl });
  service.init();
  return { dataDir, service };
}

test("a lost claim response resumes with the exact persisted identity and creates one local node", async () => {
  const requests = [];
  let first = true;
  const { service } = fixture(async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (first) {
      first = false;
      throw new Error("response lost after remote commit");
    }
    return Response.json({ data: claimResult(body) });
  });

  await assert.rejects(
    service.claimProxyNode({ proxyOrigin: "https://proxy.example.test", inviteToken: "i".repeat(32), name: "Remote B" }),
    (error) => error.code === ControlPlaneProxyErrorCode.Unavailable && error.retryable === true,
  );
  const receipt = service.listPendingProxyClaims()[0];
  assert.equal(receipt.status, "compensation-required");
  assert.equal(receipt.requestedName, "Remote B");
  assert.equal("credential" in receipt, false);
  const persisted = service.proxyPrivateStore.pendingClaimByClaimId(receipt.claimId);

  const resumed = await service.resumeProxyClaim(receipt.claimId);
  assert.equal(resumed.node.id, "node_b");
  assert.equal(resumed.node.name, "Remote B");
  assert.equal(service.listPendingProxyClaims().length, 0);
  assert.equal(service.listNodes().filter((node) => node.id === "node_b").length, 1);
  assert.equal(service.proxyPrivateStore.nodeCredential("node_b").credential, persisted.credential);
  assert.equal(requests[0].claimId, requests[1].claimId);
  assert.equal(requests[0].bindingKeyId, requests[1].bindingKeyId);
  assert.equal(requests[0].credential, requests[1].credential);
  assert.equal(requests[1].inviteToken, undefined);
});

test("cancel recovers a remotely committed binding, revokes it, then deletes the pending secret", async () => {
  const calls = [];
  let committedBody;
  const { service } = fixture(async (url, init) => {
    const parsedUrl = new URL(url);
    calls.push({ url: parsedUrl, init });
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      if (!committedBody) {
        committedBody = body;
        throw new Error("response lost after remote commit");
      }
      assert.equal(body.inviteToken, undefined);
      return Response.json({ data: claimResult(body) });
    }
    assert.equal(init.method, "DELETE");
    assert.equal(parsedUrl.pathname, "/api/node-proxy/bindings/proxy_binding_1");
    const headers = new Headers(init.headers);
    assert.equal(headers.get(CONTROL_PLANE_PROXY_AUTH_HEADERS.sourceControlPlaneId), committedBody.sourceControlPlaneId);
    assert.equal(headers.get(CONTROL_PLANE_PROXY_AUTH_HEADERS.bindingKeyId), committedBody.bindingKeyId);
    assert.equal(headers.get(CONTROL_PLANE_PROXY_AUTH_HEADERS.credential), committedBody.credential);
    return Response.json(revokeReceipt(committedBody));
  });

  await assert.rejects(service.claimProxyNode({
    proxyOrigin: "https://proxy.example.test",
    inviteToken: "i".repeat(32),
  }));
  const claimId = service.listPendingProxyClaims()[0].claimId;
  const canceled = await service.cancelProxyClaim(claimId);
  assert.deepEqual(canceled, { deleted: true, compensationRequired: false, remoteRevoke: "revoked" });
  assert.equal(service.proxyPrivateStore.pendingClaimByClaimId(claimId), undefined);
  assert.equal(calls.length, 3);
});

test("cancel retains a retryable compensation receipt when R is unavailable", async () => {
  const { service } = fixture(async () => { throw new Error("proxy offline"); });
  await assert.rejects(service.claimProxyNode({
    proxyOrigin: "https://proxy.example.test",
    inviteToken: "i".repeat(32),
  }));
  const receipt = service.listPendingProxyClaims()[0];

  await assert.rejects(
    service.cancelProxyClaim(receipt.claimId),
    (error) => error.code === "CONTROL_PLANE_PROXY_COMPENSATION_REQUIRED"
      && error.compensationRequired === true
      && error.retryable === true,
  );
  assert.equal(service.proxyPrivateStore.pendingClaimByClaimId(receipt.claimId).status, "compensation-required");
});

test("cancel retains compensation authority when R returns a mismatched 2xx revoke receipt", async () => {
  let committedBody;
  const { service } = fixture(async (_url, init) => {
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      if (!committedBody) {
        committedBody = body;
        throw new Error("response lost after remote commit");
      }
      return Response.json({ data: claimResult(body) });
    }
    return Response.json({ data: { binding: { ...revokeReceipt(committedBody).data.binding, targetNodeId: "wrong_target" }, closed: { abortedRequests: 0, closedSockets: 0 } } });
  });
  await assert.rejects(service.claimProxyNode({ proxyOrigin: "https://proxy.example.test", inviteToken: "i".repeat(32) }));
  const receipt = service.listPendingProxyClaims()[0];

  await assert.rejects(
    service.cancelProxyClaim(receipt.claimId),
    (error) => error.code === ControlPlaneProxyErrorCode.TransportFailed
      && error.compensationRequired === true
      && error.retryable === true,
  );
  assert.equal(service.proxyPrivateStore.pendingClaimByClaimId(receipt.claimId).status, "compensation-required");
});

test("a deterministic claim failure removes the pending credential", async () => {
  const { service } = fixture(async () => Response.json({
    error: { code: ControlPlaneProxyErrorCode.InviteExpired, message: "Invite expired.", retryable: false },
  }, { status: 410 }));

  await assert.rejects(
    service.claimProxyNode({ proxyOrigin: "https://proxy.example.test", inviteToken: "i".repeat(32) }),
    (error) => error.code === ControlPlaneProxyErrorCode.InviteExpired && error.retryable === false,
  );
  assert.equal(service.listPendingProxyClaims().length, 0);
});

test("force deleting a proxy node retries R and reports orphan risk only while R remains unavailable", async () => {
  let calls = 0;
  let mode = "claim";
  const { service } = fixture(async (_url, init) => {
    calls += 1;
    if (mode !== "claim") throw new Error("proxy unavailable");
    const body = JSON.parse(init.body);
    return Response.json({ data: claimResult(body) });
  });
  await service.claimProxyNode({ proxyOrigin: "https://proxy.example.test", inviteToken: "i".repeat(32) });
  mode = "force-delete";

  await assert.rejects(
    service.deleteNodeWithProxyLifecycle("node_b"),
    (error) => error.code === "CONTROL_PLANE_PROXY_REVOKE_UNAVAILABLE"
      && error.retryable === true
      && error.details.forceDeleteAllowed === true
      && error.details.forceDeleteReason === "proxy-unavailable",
  );
  assert.ok(service.nodes.get("node_b"));
  assert.ok(service.proxyPrivateStore.nodeCredential("node_b"));

  const result = await service.deleteNodeWithProxyLifecycle("node_b", true);
  assert.deepEqual(result, { deleted: true, revoke: { mode: "forced", orphanRisk: true } });
  assert.equal(calls, 3);
  assert.equal(service.nodes.get("node_b"), undefined);
  assert.equal(service.proxyPrivateStore.nodeCredential("node_b"), undefined);
});

test("normal proxy node delete requires an exact revoked binding receipt before removing local authority", async () => {
  let mode = "claim";
  let claimBody;
  const { service } = fixture(async (_url, init) => {
    if (mode === "claim") {
      claimBody = JSON.parse(init.body);
      return Response.json({ data: claimResult(claimBody) });
    }
    if (mode === "invalid-revoke") return Response.json({ data: { ok: true } });
    return Response.json(revokeReceipt(claimBody));
  });
  await service.claimProxyNode({ proxyOrigin: "https://proxy.example.test", inviteToken: "i".repeat(32) });

  mode = "invalid-revoke";
  await assert.rejects(
    service.deleteNodeWithProxyLifecycle("node_b"),
    (error) => error.code === ControlPlaneProxyErrorCode.TransportFailed
      && error.retryable === true
      && error.details.forceDeleteAllowed === false,
  );
  assert.ok(service.nodes.get("node_b"));
  assert.ok(service.proxyPrivateStore.nodeCredential("node_b"));

  mode = "valid-revoke";
  const result = await service.deleteNodeWithProxyLifecycle("node_b");
  assert.deepEqual(result, { deleted: true, revoke: { mode: "revoked", orphanRisk: false } });
  assert.equal(service.nodes.get("node_b"), undefined);
  assert.equal(service.proxyPrivateStore.nodeCredential("node_b"), undefined);
});

test("force delete cannot bypass a deterministic revoke receipt failure", async () => {
  let mode = "claim";
  const { service } = fixture(async (_url, init) => {
    if (mode === "claim") return Response.json({ data: claimResult(JSON.parse(init.body)) });
    return Response.json({ data: { ok: true } });
  });
  await service.claimProxyNode({ proxyOrigin: "https://proxy.example.test", inviteToken: "i".repeat(32) });
  mode = "invalid-revoke";

  await assert.rejects(
    service.deleteNodeWithProxyLifecycle("node_b", true),
    (error) => error.code === ControlPlaneProxyErrorCode.TransportFailed
      && error.details.forceDeleteAllowed === false,
  );
  assert.ok(service.nodes.get("node_b"));
  assert.ok(service.proxyPrivateStore.nodeCredential("node_b"));
});

test("normal delete recovers after R committed revoke but A lost the response", async () => {
  let mode = "claim";
  const { service } = fixture(async (_url, init) => {
    if (mode === "claim") return Response.json({ data: claimResult(JSON.parse(init.body)) });
    return Response.json({ error: {
      code: ControlPlaneProxyErrorCode.BindingRevoked,
      message: "Binding was already revoked.",
      retryable: false,
      details: { bindingId: "proxy_binding_1" },
    } }, { status: 403 });
  });
  await service.claimProxyNode({ proxyOrigin: "https://proxy.example.test", inviteToken: "i".repeat(32) });
  mode = "already-revoked";

  const result = await service.deleteNodeWithProxyLifecycle("node_b");
  assert.deepEqual(result, { deleted: true, revoke: { mode: "revoked", orphanRisk: false } });
  assert.equal(service.nodes.get("node_b"), undefined);
  assert.equal(service.proxyPrivateStore.nodeCredential("node_b"), undefined);
});

test("generic node patch cannot enter, leave, or replace a proxy connection identity", async () => {
  const { service } = fixture(async (_url, init) => Response.json({ data: claimResult(JSON.parse(init.body)) }));
  await service.claimProxyNode({ proxyOrigin: "https://proxy.example.test", inviteToken: "i".repeat(32) });

  for (const patch of [
    { connectionMode: "direct-http", connectionPath: { kind: "direct" } },
    { connectionPath: { kind: "control-plane-proxy", proxyId: "other.example.test", proxyBindingId: "other_binding", targetNodeId: "node_b" } },
    { auth: { mode: "local-static-key", secret: "replacement" } },
  ]) {
    assert.throws(
      () => service.updateNode("node_b", patch),
      (error) => error.code === "CONTROL_PLANE_PROXY_IDENTITY_IMMUTABLE",
    );
  }
  assert.equal(service.requirePublicNode("node_b").connectionPath.proxyBindingId, "proxy_binding_1");

  service.nodes.put({
    id: "node_direct",
    name: "Direct Node",
    connectionMode: "direct-http",
    connectionPath: { kind: "direct" },
    connectionEnabled: true,
    auth: { mode: "local-static-key", secret: "direct-secret" },
    endpoint: "http://127.0.0.1:8091",
    status: "unknown",
    health: "unknown",
    capabilities: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  assert.throws(
    () => service.updateNode("node_direct", {
      connectionMode: "control-plane-proxy",
      connectionPath: { kind: "control-plane-proxy", proxyId: "proxy.example.test", proxyBindingId: "proxy_binding_1", targetNodeId: "node_b" },
      auth: { mode: "proxy-binding" },
    }),
    (error) => error.code === "CONTROL_PLANE_PROXY_IDENTITY_IMMUTABLE",
  );
});

test("service startup removes a private proxy credential orphaned after the node delete commit", async () => {
  const fixtureState = fixture(async (_url, init) => Response.json({ data: claimResult(JSON.parse(init.body)) }));
  await fixtureState.service.claimProxyNode({ proxyOrigin: "https://proxy.example.test", inviteToken: "i".repeat(32) });
  fixtureState.service.nodes.delete("node_b");
  assert.ok(fixtureState.service.proxyPrivateStore.nodeCredential("node_b"));

  const restarted = new ControlPlaneService(controlPlaneStorePaths(fixtureState.dataDir));
  restarted.init();
  assert.equal(restarted.proxyPrivateStore.nodeCredential("node_b"), undefined);
});

test("pending claim cancel API awaits remote compensation before responding", async () => {
  const handlers = new Map();
  let completed = false;
  registerControlPlaneProxyManagementRoutes({
    app: {
      get() {},
      post() {},
      delete(route, handler) { handlers.set(route, handler); },
    },
    service: {
      async cancelProxyClaim(id) {
        assert.equal(id, "claim_1");
        await Promise.resolve();
        completed = true;
        return { deleted: true, compensationRequired: false, remoteRevoke: "revoked" };
      },
    },
    proxy: {},
    runtime: {},
    events: {},
    actorId: async () => "user:test",
  });

  const response = await handlers.get("/api/control-plane-proxy/pending-claims/:id")({ params: { id: "claim_1" } });
  assert.equal(completed, true);
  assert.equal(response.data.remoteRevoke, "revoked");
});

test("node delete API forwards explicit force and returns orphan risk without claiming remote revoke", async () => {
  const handlers = new Map();
  const published = [];
  const app = {};
  for (const method of ["get", "post", "patch", "delete"]) {
    app[method] = (route, ...args) => handlers.set(`${method}:${route}`, args.at(-1));
  }
  registerNodeRoutes({
    app,
    service: {
      async deleteNodeWithProxyLifecycle(id, force) {
        assert.equal(id, "node_b");
        assert.equal(force, true);
        return { deleted: true, revoke: { mode: "forced", orphanRisk: true } };
      },
    },
    events: { publish(type, payload) { published.push({ type, payload }); } },
    nodeAgentTunnel: {},
    nodeEventSubscriber: { syncNow() {} },
    errorPayload(error) { return { code: error.code, message: error.message }; },
  });

  const response = await handlers.get("delete:/api/nodes/:id")({ params: { id: "node_b" }, query: { force: "true" } });
  assert.deepEqual(response.data, { deleted: true, revoke: { mode: "forced", orphanRisk: true } });
  assert.deepEqual(published, [{
    type: "node.deleted",
    payload: { nodeId: "node_b", deleted: true, revoke: { mode: "forced", orphanRisk: true } },
  }]);
});
