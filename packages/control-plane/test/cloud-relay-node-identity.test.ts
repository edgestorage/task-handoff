import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CLOUD_ACCOUNT_NODE_HANDLE_LABEL, ControlledInstanceSchema, CONTROL_PLANE_PROTOCOL_VERSION, NodeSchema } from "@task-handoff/protocol/control-plane";
import { ControlPlaneService } from "../src/control-plane/application/service.ts";
import { ControlPlaneNodeAgentClient } from "../src/control-plane/nodes/client.ts";
import { ControlPlaneNodeAgentGateway } from "../src/control-plane/nodes/gateway.ts";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";

const NODE_HANDLE = "nrh_cloud_relay_identity_test";
const MACHINE_NODE_ID = "node_agent_machine_identity";

function cloudRelayTransport(reportedNodeId = MACHINE_NODE_ID) {
  return {
    async request(_node: unknown, route: string) {
      assert.equal(route, "/health");
      return new Response(JSON.stringify({
        data: {
          ok: true,
          role: "node-agent",
          nodeId: reportedNodeId,
          protocolVersion: "2026-10-02",
          serverTime: new Date().toISOString(),
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    async requestStream() {
      throw new Error("not used");
    },
    proxyWebSocket() {
      throw new Error("not used");
    },
  };
}

test("a cloud-relay node uses the node agent identity across restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-cloud-relay-identity-"));
  const paths = controlPlaneStorePaths(root);
  let database = await createControlPlaneDatabase(paths);
  let secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  let service = new ControlPlaneService(paths, { database, secrets });
  try {
    await service.init();
    const created = await service.ensureCloudRelayNode({ nodeHandle: NODE_HANDLE, nodeId: MACHINE_NODE_ID, displayName: "Relay identity" });
    service.setCloudRelayNodeAgentTransport(cloudRelayTransport());

    assert.equal(created.nodeId, MACHINE_NODE_ID);
    const checked = await service.checkNode(created.nodeId);
    assert.deepEqual([checked.id, checked.status], [created.nodeId, "online"]);
    assert.equal(service.findCloudRelayNode(NODE_HANDLE)?.id, created.nodeId);
    assert.ok(await database.nodes.get(created.nodeId));

    service.dispose();
    await database.close();
    database = await createControlPlaneDatabase(paths);
    secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
    secrets.init();
    service = new ControlPlaneService(paths, { database, secrets });
    await service.init();

    assert.equal(service.findCloudRelayNode(NODE_HANDLE)?.id, created.nodeId);
  } finally {
    service.dispose();
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a cloud-relay node rejects a health document with a different node identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-cloud-relay-identity-mismatch-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const service = new ControlPlaneService(paths, { database, secrets });
  try {
    await service.init();
    await service.ensureCloudRelayNode({ nodeHandle: NODE_HANDLE, nodeId: MACHINE_NODE_ID });
    service.setCloudRelayNodeAgentTransport(cloudRelayTransport("node_agent_other_identity"));

    const checked = await service.checkNode(MACHINE_NODE_ID);

    assert.equal(checked.status, "offline");
    assert.match(checked.error ?? "", /different identity/);
    assert.deepEqual(service.listNodes().map((node) => node.id), [MACHINE_NODE_ID]);
  } finally {
    service.dispose();
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("publishing a managed node links its account handle without changing the local connection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-cloud-account-link-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const service = new ControlPlaneService(paths, { database, secrets });
  const timestamp = "2026-10-18T00:00:00.000Z";
  try {
    await service.init();
    const local = NodeSchema.parse({
      id: "node_local_managed",
      name: "Local Node",
      connectionMode: "local-ipc",
      connectionPath: { kind: "direct" },
      connectionEnabled: true,
      auth: { mode: "paired-hmac", keyId: "key_local", secret: "local-secret", pairing: { status: "paired" } },
      status: "online",
      health: "ok",
      capabilities: {},
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await service.nodes.put(local);
    const duplicate = await service.ensureCloudRelayNode({ nodeHandle: NODE_HANDLE, nodeId: "node_agent_duplicate", displayName: "Local Node" });

    const linked = await service.linkNodeToCloudAccount(local.id, NODE_HANDLE);

    assert.equal(linked.node.labels[CLOUD_ACCOUNT_NODE_HANDLE_LABEL], NODE_HANDLE);
    assert.equal(linked.node.connectionMode, "local-ipc");
    assert.deepEqual(linked.node.connectionPath, { kind: "direct" });
    assert.equal(linked.node.auth.mode, "paired-hmac");
    assert.equal(linked.node.auth.keyId, "key_local");
    assert.deepEqual(linked.duplicateNodeIds, [duplicate.nodeId]);
    assert.equal(service.findNodeByCloudAccountHandle(NODE_HANDLE)?.id, local.id);
    await service.deleteNode(duplicate.nodeId);
    assert.deepEqual(await service.ensureCloudRelayNode({ nodeHandle: NODE_HANDLE, nodeId: local.id }), { nodeId: local.id, preserveLocalConnection: true });
    assert.deepEqual(service.listNodes().map((node) => node.id), [local.id]);
  } finally {
    service.dispose();
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a relay claim reuses an already-managed node with the same machine identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-cloud-relay-same-machine-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const service = new ControlPlaneService(paths, { database, secrets });
  const timestamp = "2026-10-18T00:00:00.000Z";
  try {
    await service.init();
    await service.nodes.put(NodeSchema.parse({
      id: MACHINE_NODE_ID,
      name: "Direct Node",
      connectionMode: "local-ipc",
      connectionPath: { kind: "direct" },
      connectionEnabled: true,
      auth: { mode: "paired-hmac", keyId: "key_local", secret: "local-secret", pairing: { status: "paired" } },
      status: "online",
      health: "ok",
      capabilities: {},
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    }));

    const result = await service.ensureCloudRelayNode({ nodeHandle: NODE_HANDLE, nodeId: MACHINE_NODE_ID });

    assert.deepEqual(result, { nodeId: MACHINE_NODE_ID, preserveLocalConnection: true });
    const node = service.requireNode(MACHINE_NODE_ID);
    assert.equal(node.connectionMode, "local-ipc");
    assert.deepEqual(node.connectionPath, { kind: "direct" });
    assert.equal(node.labels[CLOUD_ACCOUNT_NODE_HANDLE_LABEL], NODE_HANDLE);
    assert.deepEqual(service.listNodes().map((candidate) => candidate.id), [MACHINE_NODE_ID]);
  } finally {
    service.dispose();
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cloud-relay instance projections use the Control Plane's local node identity", async () => {
  const timestamp = "2026-10-17T00:00:00.000Z";
  const instance = ControlledInstanceSchema.parse({
    id: "inst_cloud_relay_identity",
    name: "Cloud relay instance",
    source: { type: "local-folder", path: "/workspace" },
    sourceSnapshot: {},
    modelSelection: {},
    nodeId: MACHINE_NODE_ID,
    runtimeId: "runtime_local_docker",
    runtime: { labels: {} },
    registrationToken: "instance-secret",
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const client = new ControlPlaneNodeAgentClient({
    request: async (_node, route, init) => new Response(JSON.stringify({
      data: route === "/instances" && (!init?.method || init.method === "GET") ? [instance] : instance,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  const gateway = new ControlPlaneNodeAgentGateway(client);
  const node = {
    id: `node_${NODE_HANDLE}`,
    name: "Cloud relay node",
    connectionMode: "cloud-relay",
    connectionPath: { kind: "cloud-relay", nodeHandle: NODE_HANDLE },
    connectionEnabled: true,
    auth: { mode: "paired-hmac", pairing: { status: "paired" } },
    status: "online",
    health: "ok",
    connectionPhase: "healthy",
    capabilities: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  } as any;

  const listed = await gateway.listFleetInstances([node]);
  assert.deepEqual(listed.items.map((item) => [item.id, item.nodeId]), [[instance.id, node.id]]);

  const created = await gateway.createInstance(node, {});
  assert.equal(created.nodeId, node.id);
  assert.equal(gateway.instanceFromSnapshot([node], instance.id)?.nodeId, node.id);
});

test("cloud-relay folders and runtimes use the Control Plane's local node identity", async () => {
  const timestamp = "2026-10-17T00:00:00.000Z";
  const folder = { id: "folder_identity", nodeId: MACHINE_NODE_ID, name: "Workspace", path: "/workspace", origin: "user", labels: {}, createdAt: timestamp, updatedAt: timestamp };
  const runtime = {
    id: "runtime_identity",
    nodeId: MACHINE_NODE_ID,
    name: "Local runtime",
    type: "local",
    status: "online",
    accessStrategy: "node-proxy",
    capabilities: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const client = new ControlPlaneNodeAgentClient({
    request: async (_node, route) => new Response(JSON.stringify({ data: route === "/local-folders" ? [folder] : [runtime] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  const gateway = new ControlPlaneNodeAgentGateway(client);
  const node = {
    id: `node_${NODE_HANDLE}`,
    name: "Cloud relay node",
    connectionMode: "cloud-relay",
    connectionPath: { kind: "cloud-relay", nodeHandle: NODE_HANDLE },
    connectionEnabled: true,
    auth: { mode: "paired-hmac", pairing: { status: "paired" } },
    status: "online",
    health: "ok",
    connectionPhase: "healthy",
    capabilities: {},
    labels: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  } as any;

  assert.deepEqual((await gateway.listLocalFolders(node)).map((item) => item.nodeId), [node.id]);
  assert.deepEqual((await gateway.listRuntimes(node)).map((item) => item.nodeId), [node.id]);
});
