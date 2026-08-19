const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
} = require("../packages/protocol/src/control-plane-proxy.ts");
const { ControlPlaneService } = require("../packages/control-plane/src/control-plane/application/service.ts");
const { controlPlaneStorePaths } = require("../packages/control-plane/src/control-plane/persistence/paths.ts");
const { ControlPlaneProxyStateSubscriber } = require("../packages/control-plane/src/control-plane/nodes/control-plane-proxy-state-subscriber.ts");
const { ControlPlaneProxyService } = require("../packages/control-plane/src/control-plane/proxy/service.ts");
const { ControlPlaneProxyStore } = require("../packages/control-plane/src/control-plane/proxy/store.ts");

const timestamp = "2026-08-01T00:00:00.000Z";
const credentialValue = "a_generated_binding_credential_0123456789";

class EventSocket extends EventEmitter {
  closed = false;
  close() { this.closed = true; }
  message(value) { this.emit("message", JSON.stringify(value)); }
  disconnect() { this.emit("close"); }
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

function putProxyNode(service, binding) {
  service.nodes.put({
    id: "node_b",
    name: "Node B",
    connectionMode: "control-plane-proxy",
    connectionPath: {
      kind: "control-plane-proxy",
      proxyId: "proxy.example.test",
      proxyBindingId: binding.id,
      targetNodeId: binding.targetNodeId,
    },
    connectionEnabled: true,
    auth: { mode: "proxy-binding" },
    status: "unknown",
    health: "unknown",
    capabilities: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  service.proxyPrivateStore.putNodeCredential({
    id: "proxy_credential_b",
    nodeId: "node_b",
    proxyOrigin: "https://proxy.example.test",
    proxyBindingId: binding.id,
    targetNodeId: binding.targetNodeId,
    sourceControlPlaneId: binding.sourceControlPlaneId,
    bindingKeyId: binding.bindingKeyId,
    credential: credentialValue,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

test("A and R process recovery preserves B lifecycle and deterministically restores snapshot, events, and revoke state", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-fault-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const authorityPath = path.join(root, "r", "proxy-authority.json");
  const aDataDir = path.join(root, "a");
  const b = {
    target: {
      id: "node_b",
      name: "Node B",
      status: "online",
      health: "ok",
      capabilities: { lifecycleCommands: true },
      manageable: true,
    },
    lifecycle: { managedInstanceStatus: "running", commands: [] },
  };
  const createR = () => {
    const service = new ControlPlaneProxyService(
      new ControlPlaneProxyStore(authorityPath),
      { get: (nodeId) => nodeId === b.target.id ? b.target : undefined },
      { proxyOrigin: "https://proxy.example.test" },
    );
    service.init();
    return service;
  };
  let r = createR();
  const invite = r.createInvite({ targetNodeId: b.target.id }, "admin");
  const claimed = r.claimInvite({
    protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
    inviteToken: invite.token,
    claimId: "proxy_claim_ab",
    sourceControlPlaneId: "control_plane_a",
    targetNodeId: b.target.id,
    bindingKeyId: "proxy_key_ab",
    credential: credentialValue,
  });

  const firstA = new ControlPlaneService(controlPlaneStorePaths(aDataDir));
  firstA.init();
  putProxyNode(firstA, claimed.binding);

  let rReachable = true;
  let streamId = "stream_r1";
  let streamRevision = 0;
  const sockets = [];
  const networkRequests = [];
  const fetchImpl = async (url, init) => {
    networkRequests.push({ kind: "http", path: new URL(url).pathname });
    if (!rReachable) throw new Error("R stopped");
    try {
      const binding = r.authenticateBinding(claimed.binding.id, {
        sourceControlPlaneId: init.headers["x-task-handoff-proxy-source-control-plane-id"],
        bindingKeyId: init.headers["x-task-handoff-proxy-binding-key-id"],
        credential: init.headers["x-task-handoff-proxy-credential"],
      });
      return Response.json({ data: {
        protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
        binding,
        streamId,
        revision: streamRevision,
        observedAt: timestamp,
        target: Object.fromEntries(Object.entries(b.target).filter(([key]) => key !== "manageable")),
      } });
    } catch (error) {
      return Response.json({ error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      } }, { status: error.statusCode || 500 });
    }
  };
  const openWebSocket = (url) => {
    networkRequests.push({ kind: "wss", path: new URL(url).pathname, sinceRevision: new URL(url).searchParams.get("sinceRevision") });
    const socket = new EventSocket();
    sockets.push(socket);
    return socket;
  };

  const firstSubscriber = new ControlPlaneProxyStateSubscriber(firstA, { fetchImpl, openWebSocket });
  firstSubscriber.start();
  await waitFor(() => sockets.length === 1, "A did not bootstrap its initial R event stream");
  assert.equal(firstA.requirePublicNode("node_b").status, "online");

  firstSubscriber.stop();
  assert.equal(sockets[0].closed, true);
  assert.deepEqual(b.lifecycle, { managedInstanceStatus: "running", commands: [] });

  rReachable = false;
  const restartedA = new ControlPlaneService(controlPlaneStorePaths(aDataDir));
  restartedA.init();
  assert.ok(restartedA.proxyPrivateStore.nodeCredential("node_b"));
  assert.equal(restartedA.requirePublicNode("node_b").proxyState.target.status, "online");
  const restartedSubscriber = new ControlPlaneProxyStateSubscriber(restartedA, { fetchImpl, openWebSocket });
  t.after(() => restartedSubscriber.stop());
  restartedSubscriber.start();
  await waitFor(
    () => restartedA.requirePublicNode("node_b").proxyState.reachability === "unreachable",
    "A did not expose the R outage",
  );
  assert.equal(restartedA.requirePublicNode("node_b").proxyState.target.status, "online");
  assert.deepEqual(b.lifecycle, { managedInstanceStatus: "running", commands: [] });

  r = createR();
  assert.equal(r.listBindings()[0].id, claimed.binding.id);
  assert.equal(r.listBindings()[0].status, "active");
  streamId = "stream_r2";
  streamRevision = 0;
  rReachable = true;
  await waitFor(() => sockets.length === 2, "A did not reconnect after R authority recovery");
  assert.equal(networkRequests.filter((request) => request.kind === "wss")[1].sinceRevision, "0");

  b.target.status = "offline";
  b.target.health = "degraded";
  streamRevision = 1;
  sockets[1].message({
    type: "control-plane-proxy.event",
    protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
    streamId,
    bindingId: claimed.binding.id,
    sourceControlPlaneId: claimed.binding.sourceControlPlaneId,
    targetNodeId: b.target.id,
    revision: streamRevision,
    source: { id: "r2_event_1", seq: 1 },
    target: Object.fromEntries(Object.entries(b.target).filter(([key]) => key !== "manageable")),
    event: { type: "node.checked", topic: "node.state", createdAt: timestamp },
  });
  await waitFor(() => restartedA.requirePublicNode("node_b").proxyState.revision === 1, "A did not consume the post-restart event");
  assert.equal(restartedA.requirePublicNode("node_b").proxyState.target.status, "offline");

  b.target.status = "online";
  b.target.health = "ok";
  streamRevision = 2;
  sockets[1].message({
    type: "control-plane-proxy.event",
    protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
    streamId,
    bindingId: claimed.binding.id,
    sourceControlPlaneId: claimed.binding.sourceControlPlaneId,
    targetNodeId: b.target.id,
    revision: streamRevision,
    source: { id: "r2_event_2", seq: 2 },
    target: Object.fromEntries(Object.entries(b.target).filter(([key]) => key !== "manageable")),
    event: { type: "node.tunnel.connected", topic: "node.state", createdAt: timestamp },
  });
  await waitFor(() => restartedA.requirePublicNode("node_b").proxyState.revision === 2, "A did not consume the B tunnel recovery event");
  assert.equal(restartedA.requirePublicNode("node_b").proxyState.target.status, "online");

  r.revokeBinding(claimed.binding.id);
  sockets[1].disconnect();
  await waitFor(
    () => restartedA.requirePublicNode("node_b").proxyState.bindingStatus === "revoked",
    "A did not converge to the persisted binding revocation",
  );
  const revokedNode = restartedA.requirePublicNode("node_b");
  assert.equal(revokedNode.proxyState.reachability, "reachable");
  assert.equal(revokedNode.proxyState.target.status, "online");
  assert.deepEqual(b.lifecycle, { managedInstanceStatus: "running", commands: [] });
  assert.equal(networkRequests.some((request) => request.path.includes("/instances/")), false);
});
