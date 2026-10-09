import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NodeSchema, supportsNodeModelRelay, type Node } from "@task-handoff/protocol/control-plane";
import { CONTROL_PLANE_PROXY_PROTOCOL_VERSION, type ProxyNodeCredential, type ProxyTargetSnapshot } from "@task-handoff/protocol/control-plane-proxy";
import { ControlPlaneService } from "../src/control-plane/application/service.ts";
import { ControlPlaneProxyLifecycle } from "../src/control-plane/nodes/proxy-lifecycle.ts";
import { ControlPlaneProxyStateSubscriber } from "../src/control-plane/nodes/control-plane-proxy-state-subscriber.ts";
import { createControlPlaneDatabase } from "../src/control-plane/persistence/database/index.ts";
import { controlPlaneStorePaths } from "../src/control-plane/persistence/paths.ts";
import { SecretEnvelopeService } from "../src/control-plane/persistence/secret-envelope.ts";

const TIMESTAMP = "2026-10-02T18:00:00.000Z";
const NODE_ID = "node_proxy";
const BINDING_ID = "proxy_binding_test";
const PROXY_ORIGIN = "https://proxy.example.test";

function nodeAgentCapabilityDocument(node: Node) {
  const agent = node.capabilities.agent;
  return agent && typeof agent === "object" && !Array.isArray(agent)
    ? (agent as { capabilities?: unknown }).capabilities
    : undefined;
}

const relayCapabilities = {
  agent: {
    nodeId: NODE_ID,
    protocolVersion: "2026-10-02",
    build: { component: "node-agent", packageName: "@task-handoff/node-agent", packageVersion: "0.0.35", protocolVersion: "2026-10-02" },
    capabilities: {
      managedModels: {
        multiEntityAssignment: true,
        privateModelCatalog: true,
        stableModelIdentity: true,
        requestMappings: true,
        modelRelay: { protocols: ["openai-responses", "openai-chat-completions", "anthropic-messages"], streaming: true },
      },
    },
  },
};

function proxyNode(overrides: Partial<Node> = {}): Node {
  return NodeSchema.parse({
    id: NODE_ID,
    name: "Proxy Node",
    connectionMode: "control-plane-proxy",
    connectionPath: { kind: "control-plane-proxy", proxyId: "proxy.example.test", proxyBindingId: BINDING_ID, targetNodeId: NODE_ID },
    connectionEnabled: true,
    auth: { mode: "proxy-binding" },
    status: "unknown",
    health: "unknown",
    capabilities: {},
    labels: {},
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  });
}

function targetSnapshot(target: Partial<ProxyTargetSnapshot["target"]> = {}): ProxyTargetSnapshot {
  return {
    protocolVersion: CONTROL_PLANE_PROXY_PROTOCOL_VERSION,
    binding: {
      id: BINDING_ID,
      claimId: "proxy_claim_test",
      sourceControlPlaneId: "control_plane_test",
      targetNodeId: NODE_ID,
      bindingKeyId: "proxy_key_test",
      status: "active",
      revision: 1,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    },
    streamId: "proxy_events_test",
    revision: 0,
    observedAt: TIMESTAMP,
    target: {
      id: NODE_ID,
      name: "Proxy Node",
      status: "online",
      health: "unknown",
      capabilities: {},
      ...target,
    },
  };
}

function proxyCredential(): ProxyNodeCredential {
  return {
    id: `proxy_credential_${NODE_ID}`,
    nodeId: NODE_ID,
    proxyOrigin: PROXY_ORIGIN,
    proxyBindingId: BINDING_ID,
    targetNodeId: NODE_ID,
    sourceControlPlaneId: "control_plane_test",
    bindingKeyId: "proxy_key_test",
    credential: "test-credential-test-credential-32",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function createLifecycle(initial: Node) {
  const nodes = new Map<string, Node>([[initial.id, initial]]);
  const lifecycle = new ControlPlaneProxyLifecycle({
    nodes: {
      list: () => [...nodes.values()],
      get: (id: string) => nodes.get(id),
      put: (node: Node) => { nodes.set(node.id, node); return node; },
      delete: (id: string) => nodes.delete(id),
      observe: (node: Node) => { nodes.set(node.id, node); return node; },
    },
    privateStore: {} as never,
    fetchImpl: (async () => jsonResponse({})) as typeof fetch,
    requireNode: (id: string) => {
      const node = nodes.get(id);
      if (!node) throw new Error(`missing node ${id}`);
      return node;
    },
    deleteNode: (id: string) => nodes.delete(id),
  });
  return { lifecycle, nodes };
}

test("proxy target projections keep the locally probed capability document", () => {
  const { lifecycle } = createLifecycle(proxyNode({ capabilities: relayCapabilities }));

  const updated = lifecycle.applyTargetSnapshot(NODE_ID, targetSnapshot({ capabilities: {} }));

  assert.deepEqual(updated.capabilities, relayCapabilities);
  assert.equal(supportsNodeModelRelay(nodeAgentCapabilityDocument(updated)), true);
  assert.equal(updated.status, "online");
});

test("proxy target projections still seed capabilities when the node has none", () => {
  const { lifecycle } = createLifecycle(proxyNode());

  const updated = lifecycle.applyTargetSnapshot(NODE_ID, targetSnapshot({ capabilities: relayCapabilities }));

  assert.deepEqual(updated.capabilities, relayCapabilities);
  assert.equal(supportsNodeModelRelay(nodeAgentCapabilityDocument(updated)), true);
});

test("relay settings revalidate the capability document through the node agent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "control-plane-proxy-capabilities-"));
  const paths = controlPlaneStorePaths(root);
  const database = await createControlPlaneDatabase(paths);
  const secrets = new SecretEnvelopeService(paths.databaseEncryptionKeyPath);
  secrets.init();
  const requests: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname.endsWith("/health")) {
      return jsonResponse({ data: { ok: true, role: "node-agent", nodeId: NODE_ID, protocolVersion: "2026-10-02", capabilities: relayCapabilities.agent.capabilities, build: relayCapabilities.agent.build } });
    }
    if (url.pathname.endsWith("/settings/model-relay")) {
      return jsonResponse({ data: method === "PATCH" ? { enabled: true, source: "persisted" } : { enabled: true, source: "default" } });
    }
    return jsonResponse({ error: { code: "NOT_FOUND", message: "not found" } }, 404);
  }) as typeof fetch;
  const service = new ControlPlaneService(paths, { database, secrets, fetchImpl });
  try {
    await service.init();
    service.proxyPrivateStore.putNodeCredential(proxyCredential());
    await service.nodes.put(proxyNode());
    assert.equal(supportsNodeModelRelay(nodeAgentCapabilityDocument(service.requireNode(NODE_ID))), false);

    assert.deepEqual(await service.getNodeModelRelay(NODE_ID), { enabled: true, source: "default" });
    assert.equal(supportsNodeModelRelay(nodeAgentCapabilityDocument(service.requireNode(NODE_ID))), true);
    assert.ok(requests.some((entry) => entry.endsWith("/health")));

    assert.deepEqual(await service.updateNodeModelRelay(NODE_ID, { enabled: true }), { enabled: true, source: "persisted" });
    assert.ok(requests.some((entry) => entry.startsWith("PATCH") && entry.endsWith("/settings/model-relay")));
  } finally {
    service.dispose();
    await database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("proxy state bootstrap refreshes capabilities from the node agent", async () => {
  const refreshed: string[] = [];
  const states: Node[] = [];
  const node = proxyNode();
  const service = {
    listNodes: () => [node],
    proxyPrivateStore: { nodeCredential: () => proxyCredential() },
    applyProxyTargetSnapshot: () => node,
    applyProxyTargetEvent: () => node,
    markProxyUnavailable: () => node,
    markProxyBindingRevoked: () => node,
    refreshNodeCapabilityDocument: async (nodeId: string) => {
      refreshed.push(nodeId);
      return node;
    },
  };
  const socket = { on: () => undefined, close: () => undefined };
  const subscriber = new ControlPlaneProxyStateSubscriber(service, {
    fetchImpl: (async () => jsonResponse({ data: targetSnapshot() })) as typeof fetch,
    openWebSocket: () => socket,
    onStateChanged: (state) => states.push(state),
  });
  try {
    subscriber.start();
    const deadline = Date.now() + 5_000;
    while (!refreshed.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(refreshed, [NODE_ID]);
    assert.ok(states.length >= 2);
  } finally {
    subscriber.stop();
  }
});
