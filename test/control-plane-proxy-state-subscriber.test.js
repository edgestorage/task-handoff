const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
  ControlPlaneProxyErrorCode,
} = require("../packages/protocol/src/control-plane-proxy.ts");
const { ControlPlaneProxyStateSubscriber } = require("../packages/control-plane/src/control-plane/nodes/control-plane-proxy-state-subscriber.ts");
const { createTestControlPlaneService } = require("./fixtures/control-plane-service.js");

const timestamp = "2026-08-01T00:00:00.000Z";

class Socket extends EventEmitter {
  close() { this.closed = true; }
  message(value) { this.emit("message", JSON.stringify(value)); }
  disconnect(code, reason) { this.emit("close", code, reason); }
}

function snapshot(revision, target = {}) {
  return {
    protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
    binding: {
      id: "proxy_binding_b",
      claimId: "proxy_claim_b",
      sourceControlPlaneId: "control_plane_a",
      targetNodeId: "node_b",
      bindingKeyId: "proxy_key_b",
      status: "active",
      revision: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    streamId: "proxy_stream_b",
    revision,
    observedAt: timestamp,
    target: {
      id: "node_b",
      name: "Node B",
      status: "online",
      health: "ok",
      capabilities: { terminal: true },
      ...target,
    },
  };
}

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-state-subscriber-"));
  const current = await createTestControlPlaneService(dataDir);
  t.after(async () => {
    await current.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  await current.service.nodes.put({
    id: "node_b",
    name: "Node B",
    connectionMode: "control-plane-proxy",
    connectionPath: { kind: "control-plane-proxy", proxyId: "proxy.example.test", proxyBindingId: "proxy_binding_b", targetNodeId: "node_b" },
    connectionEnabled: true,
    auth: { mode: "proxy-binding" },
    status: "offline",
    health: "degraded",
    capabilities: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  current.service.proxyPrivateStore.putNodeCredential({
    id: "proxy_credential_b",
    nodeId: "node_b",
    proxyOrigin: "https://proxy.example.test",
    proxyBindingId: "proxy_binding_b",
    targetNodeId: "node_b",
    sourceControlPlaneId: "control_plane_a",
    bindingKeyId: "proxy_key_b",
    credential: "c".repeat(32),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return current.service;
}

async function waitFor(predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("condition was not reached");
}

test("subscriber applies snapshot before opening WSS and then consumes contiguous target projections without polling", async (t) => {
  const service = await fixture(t);
  const order = [];
  const sockets = [];
  let fetches = 0;
  const subscriber = new ControlPlaneProxyStateSubscriber(service, {
    async fetchImpl() {
      fetches += 1;
      order.push("snapshot");
      return Response.json({ data: snapshot(4) });
    },
    openWebSocket(url) {
      order.push("wss");
      assert.equal(new URL(url).searchParams.get("sinceRevision"), "4");
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
  });
  t.after(() => subscriber.stop());
  subscriber.start();
  await waitFor(() => sockets.length === 1);

  assert.deepEqual(order, ["snapshot", "wss"]);
  assert.equal(service.requirePublicNode("node_b").proxyState.revision, 4);
  sockets[0].message({
    type: "control-plane-proxy.event",
    protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
    streamId: "proxy_stream_b",
    bindingId: "proxy_binding_b",
    sourceControlPlaneId: "control_plane_a",
    targetNodeId: "node_b",
    revision: 5,
    source: { id: "event_5", seq: 5 },
    target: snapshot(5, { status: "offline", health: "degraded" }).target,
    event: { type: "node.checked", topic: "node.state", createdAt: timestamp },
  });
  await waitFor(() => service.requirePublicNode("node_b").proxyState.revision === 5);
  const node = service.requirePublicNode("node_b");
  assert.equal(node.status, "offline");
  assert.equal(node.proxyState.target.status, "offline");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fetches, 1);
});

test("event stream disconnect inside the grace period keeps the last projection and reboots from the next snapshot", async (t) => {
  const service = await fixture(t);
  const sockets = [];
  const warnings = [];
  const revisions = [7, 9];
  const subscriber = new ControlPlaneProxyStateSubscriber(service, {
    unavailableGraceMs: 20,
    logger: { warn(details, message) { warnings.push({ details, message }); } },
    async fetchImpl() { return Response.json({ data: snapshot(revisions.shift(), { status: "offline", health: "degraded" }) }); },
    openWebSocket(url) {
      const socket = new Socket();
      socket.sinceRevision = new URL(url).searchParams.get("sinceRevision");
      sockets.push(socket);
      return socket;
    },
  });
  t.after(() => subscriber.stop());
  subscriber.start();
  await waitFor(() => sockets.length === 1);
  sockets[0].disconnect(1006, "TLS handshake timeout");
  await waitFor(() => sockets.length === 2);
  assert.equal(sockets[1].sinceRevision, "9");
  const recovered = service.requirePublicNode("node_b");
  assert.equal(recovered.proxyState.reachability, "reachable");
  assert.equal(recovered.proxyState.revision, 9);
  assert.equal(recovered.status, "offline");
  // 宽限期内重连成功，节点全程没有被投影成不可用。
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(service.requirePublicNode("node_b").proxyState.reachability, "reachable");
  assert.equal(service.requirePublicNode("node_b").status, "offline");
  // 断开原因进入诊断日志，便于区分链路抖动与真实离线。
  const interrupted = warnings.find((warning) => warning.message === "control-plane proxy link interrupted, awaiting grace period");
  assert.ok(interrupted);
  assert.equal(interrupted.details.trigger, "event-stream-close");
  assert.equal(interrupted.details.closeCode, 1006);
  assert.equal(interrupted.details.closeReason, "TLS handshake timeout");
});

test("proxy outage degrades once after the grace period and restores reachability from the next snapshot", async (t) => {
  const service = await fixture(t);
  const sockets = [];
  const revisions = [6, 7];
  let fetches = 0;
  let failFetches = 0;
  let unreachableStates = 0;
  const subscriber = new ControlPlaneProxyStateSubscriber(service, {
    unavailableGraceMs: 20,
    onStateChanged(node) { if (node.proxyState.reachability === "unreachable") unreachableStates += 1; },
    async fetchImpl() {
      fetches += 1;
      if (failFetches > 0) {
        failFetches -= 1;
        throw Object.assign(new Error("connect failed"), { code: "ECONNRESET" });
      }
      return Response.json({ data: snapshot(revisions.shift(), { status: "offline", health: "degraded" }) });
    },
    openWebSocket() {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
  });
  t.after(() => subscriber.stop());
  subscriber.start();
  await waitFor(() => sockets.length === 1);
  failFetches = 2;
  sockets[0].disconnect();
  await waitFor(() => service.requirePublicNode("node_b").proxyState.reachability === "unreachable");
  const degraded = service.requirePublicNode("node_b");
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.proxyState.target.status, "offline");
  assert.equal(degraded.proxyState.revision, 6);
  assert.equal(unreachableStates, 1);
  // 同一次中断里继续重连失败也不会重复发布降级。
  await waitFor(() => fetches >= 3, 400);
  assert.equal(unreachableStates, 1);
  await waitFor(() => service.requirePublicNode("node_b").proxyState.reachability === "reachable", 1_000);
  const recovered = service.requirePublicNode("node_b");
  assert.equal(recovered.proxyState.revision, 7);
  assert.equal(recovered.status, "offline");
  // 恢复后再次中断会重新进入宽限并重新发布降级。
  failFetches = 5;
  sockets[1].disconnect();
  await waitFor(() => unreachableStates === 2, 200);
});

test("binding revoked is distinct from proxy unreachability and preserves the last target", async (t) => {
  const service = await fixture(t);
  service.applyProxyTargetSnapshot("node_b", snapshot(3, { status: "offline", health: "degraded" }));
  let opened = false;
  const subscriber = new ControlPlaneProxyStateSubscriber(service, {
    async fetchImpl() {
      return Response.json({ error: {
        code: ControlPlaneProxyErrorCode.BindingRevoked,
        message: "Binding revoked.",
        retryable: false,
      } }, { status: 403 });
    },
    openWebSocket() { opened = true; return new Socket(); },
  });
  t.after(() => subscriber.stop());
  subscriber.start();
  await waitFor(() => service.requirePublicNode("node_b").proxyState.bindingStatus === "revoked");
  const node = service.requirePublicNode("node_b");
  assert.equal(node.proxyState.reachability, "reachable");
  assert.equal(node.proxyState.target.status, "offline");
  assert.equal(node.status, "degraded");
  assert.equal(opened, false);
});

test("subscriber rebuilds after a crash leaves the proxy node durable before credential promotion", async (t) => {
  const service = await fixture(t);
  const credential = service.proxyPrivateStore.nodeCredential("node_b");
  service.proxyPrivateStore.deleteNodeCredential("node_b");
  let fetches = 0;
  const sockets = [];
  const subscriber = new ControlPlaneProxyStateSubscriber(service, {
    async fetchImpl() {
      fetches += 1;
      return Response.json({ data: snapshot(1) });
    },
    openWebSocket() {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
  });
  t.after(() => subscriber.stop());
  subscriber.start();
  await waitFor(() => service.requirePublicNode("node_b").proxyState?.reachability === "unreachable");
  assert.equal(fetches, 0);

  service.proxyPrivateStore.putNodeCredential(credential);
  subscriber.syncNow();
  await waitFor(() => sockets.length === 1);
  assert.equal(fetches, 1);
  assert.equal(service.requirePublicNode("node_b").proxyState.reachability, "reachable");
});

test("subscriber logs only a redacted proxy failure summary", async (t) => {
  const service = await fixture(t);
  const warnings = [];
  const secret = "machine-credential-must-not-be-logged";
  const failure = Object.assign(new Error("connect failed"), {
    code: "ECONNRESET",
    request: { headers: { "x-task-handoff-proxy-credential": secret } },
  });
  const subscriber = new ControlPlaneProxyStateSubscriber(service, {
    async fetchImpl() { throw failure; },
    logger: { warn(details, message) { warnings.push({ details, message }); } },
  });
  t.after(() => subscriber.stop());
  subscriber.start();
  await waitFor(() => warnings.length >= 1);

  const bootstrapWarnings = warnings.filter((warning) => warning.message === "control-plane proxy state bootstrap failed");
  assert.ok(bootstrapWarnings.length >= 1);
  for (const warning of bootstrapWarnings) {
    assert.deepEqual(warning, {
      details: {
        nodeId: "node_b",
        error: { name: "Error", message: "connect failed", code: "ECONNRESET" },
      },
      message: "control-plane proxy state bootstrap failed",
    });
  }
  assert.equal(JSON.stringify(warnings).includes(secret), false);
});
