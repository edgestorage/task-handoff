const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebSocketServer } = require("ws");

const { createTestControlPlaneService } = require("./fixtures/control-plane-service.js");
const { ControlPlaneEventBus } = require("../packages/control-plane/src/control-plane/events/bus.ts");
const { ControlPlaneNodeAgentTunnelTransport } = require("../packages/control-plane/src/control-plane/nodes/tunnel.ts");
const { NodeTunnelIngress } = require("../packages/control-plane/src/control-plane/nodes/tunnel-ingress.ts");
const { connectReverseTunnel } = require("../packages/node-agent/src/reverse-tunnel/client.ts");
const { CONTROL_PLANE_PROTOCOL_VERSION } = require("../packages/protocol/src/control-plane.ts");
const { AiSessionEventType } = require("../packages/protocol/src/ai-sessions.ts");

function nodeRecord(id, timestamp) {
  return {
    id,
    name: id,
    connectionMode: "direct-http",
    auth: { mode: "paired-hmac", keyId: `key_${id}`, secret: `secret_${id}` },
    endpoint: `http://${id}.example.test:8091`,
    status: "online",
    health: "ok",
    capabilities: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function instanceRecord(id, nodeId) {
  return { id, nodeId, name: id };
}

function aiSessionSnapshotPayload(instanceId, revision) {
  const timestamp = "2026-11-20T00:00:00.000Z";
  return {
    meta: {
      instanceId,
      streamId: `ai_${instanceId}`,
      revision,
      traceId: `trace_${instanceId}_${revision}`,
      generatedAt: timestamp,
      reason: "provider-event",
    },
    snapshot: {
      runningCount: 0,
      waitingCount: 0,
      staleCount: 0,
      sessions: [],
      updatedAt: timestamp,
    },
  };
}

function liveInstance(id, nodeId) {
  const timestamp = "2026-11-20T00:00:00.000Z";
  return {
    id,
    name: id,
    source: { type: "local-folder", path: "/workspace" },
    sourceSnapshot: {},
    modelSelection: {},
    nodeId,
    runtimeId: "runtime_live",
    target: { strategy: "node-proxy", status: "reachable", web: "http://127.0.0.1:32100", api: "http://127.0.0.1:32100/api" },
    runtime: { labels: {} },
    registrationToken: "instance-secret",
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("Control Plane ownership validates node claims before forwarding session events", async (t) => {
  const current = await createTestControlPlaneService(fs.mkdtempSync(path.join(os.tmpdir(), "cp-instance-ownership-")));
  t.after(() => current.close());
  const { service } = current;
  const timestamp = new Date().toISOString();
  await service.nodes.put(nodeRecord("node_owner", timestamp));
  await service.nodes.put(nodeRecord("node_other", timestamp));
  await service.nodes.put(nodeRecord("node_loading", timestamp));

  const fleet = new Map([
    ["node_owner", { phase: "ready", items: [instanceRecord("inst_owned", "node_owner")], live: [] }],
    ["node_other", { phase: "ready", items: [], live: [] }],
    ["node_loading", { phase: "loading", items: [], live: [instanceRecord("inst_loading", "node_loading")] }],
  ]);
  const listCalls = [];
  service.nodeAgentGateway.readFleetInstances = (nodes) => ({
    items: nodes.flatMap((node) => fleet.get(node.id)?.items || []),
    nodeStates: nodes.map((node) => ({
      nodeId: node.id,
      resource: "instances",
      phase: fleet.get(node.id)?.phase || "uninitialized",
    })),
    nodeErrors: [],
  });
  service.nodeAgentGateway.listInstances = async (node) => {
    listCalls.push(node.id);
    return fleet.get(node.id)?.live || [];
  };

  assert.equal(await service.nodeOwnsInstance("node_owner", "inst_owned"), true);
  assert.equal(await service.nodeOwnsInstance("node_other", "inst_owned"), false);
  assert.deepEqual(listCalls, []);
  assert.equal(await service.nodeOwnsInstance("node_loading", "inst_loading"), true);
  assert.deepEqual(listCalls, ["node_loading"]);

  const events = new ControlPlaneEventBus();
  const published = [];
  events.on((event) => published.push(event));
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    validateInstanceScope: (nodeId, instanceId) => service.nodeOwnsInstance(nodeId, instanceId),
  });
  const forward = (nodeId, instanceId, revision) => tunnel.handleMessage(nodeId, {
    type: "node-agent.event.forwarded",
    event: {
      type: AiSessionEventType.Snapshot,
      topic: "ai.sessions",
      payload: aiSessionSnapshotPayload(instanceId, revision),
      scope: { instanceId },
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  forward("node_owner", "inst_owned", 1);
  await settle();
  assert.deepEqual(published.map((event) => [event.scope.nodeId, event.scope.instanceId]), [["node_owner", "inst_owned"]]);

  tunnel.invalidateInstanceScope({ instanceId: "inst_owned" });
  fleet.set("node_owner", { phase: "ready", items: [], live: [] });
  forward("node_owner", "inst_owned", 2);
  await settle();
  assert.equal(published.length, 1);

  forward("node_other", "inst_owned", 3);
  await settle();
  assert.equal(published.length, 1);
  assert.deepEqual(tunnel.instanceScopeDiagnostics(), {
    validatedScopes: 0,
    validatingScopes: 0,
    queuedScopes: 0,
    scopeEpochs: 0,
  });
});

test("live Node Agent reverse tunnel supplies ownership before Control Plane forwards session events", async (t) => {
  const current = await createTestControlPlaneService(fs.mkdtempSync(path.join(os.tmpdir(), "cp-live-instance-ownership-")));
  t.after(() => current.close());
  const { service } = current;
  const nodeId = "node_live_owner";
  const ownedInstanceId = "inst_live_owned";
  const timestamp = new Date().toISOString();
  await service.nodes.put({
    ...nodeRecord(nodeId, timestamp),
    connectionMode: "reverse-wss",
  });

  const events = new ControlPlaneEventBus();
  const published = [];
  events.on((event) => published.push(event));
  const tunnel = new ControlPlaneNodeAgentTunnelTransport(events, {
    validateInstanceScope: (claimedNodeId, instanceId) => service.nodeOwnsInstance(claimedNodeId, instanceId),
  });
  service.setNodeAgentTransport(tunnel);

  const httpServer = http.createServer();
  const sockets = new WebSocketServer({ server: httpServer });
  const ingress = new NodeTunnelIngress(tunnel);
  sockets.on("connection", (socket) => ingress.attachMain(nodeId, socket));
  const port = await listen(httpServer);
  t.after(async () => {
    for (const client of sockets.clients) client.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  const injected = [];
  const socket = connectReverseTunnel({
    log: { warn() {} },
    inject: async ({ url }) => {
      injected.push(url);
      if (new URL(url, "http://127.0.0.1").pathname === "/api/node-agent/instances") {
        return {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ data: [liveInstance(ownedInstanceId, nodeId)] }),
        };
      }
      return { statusCode: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "not found" }) };
    },
    nodeAgentState: { currentListenerPort: 8091 },
  }, {
    tunnelUrl: `ws://127.0.0.1:${port}/api/node-tunnel`,
    nodeId,
    port: 8091,
  });
  t.after(() => socket.terminate());
  await waitFor(() => tunnel.connected(nodeId), "live reverse tunnel");

  assert.equal(await service.nodeOwnsInstance(nodeId, ownedInstanceId), true);
  assert.equal(await service.nodeOwnsInstance(nodeId, "inst_live_unowned"), false);
  assert.equal(injected.filter((url) => new URL(url, "http://127.0.0.1").pathname === "/api/node-agent/instances").length, 1);

  const forward = (instanceId, revision) => socket.send(JSON.stringify({
    type: "node-agent.event.forwarded",
    event: {
      type: AiSessionEventType.Snapshot,
      topic: "ai.sessions",
      payload: aiSessionSnapshotPayload(instanceId, revision),
      scope: { instanceId },
    },
  }));
  forward(ownedInstanceId, 1);
  await waitFor(() => published.length === 1, "owned tunnel event");
  forward("inst_live_unowned", 2);

  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(
    published.map((event) => [event.scope.nodeId, event.scope.instanceId]),
    [[nodeId, ownedInstanceId]],
  );
});
