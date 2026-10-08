const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createControlPlaneApp } = require("../packages/control-plane/src/server.ts");
const { CONTROL_PLANE_PROTOCOL_VERSION } = require("../packages/protocol/src/control-plane.ts");

function tempDataDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `task-handoff-${name}-`));
}

function createNodeAgentMock(options = {}) {
  const requests = [];
  const relay = { enabled: Boolean(options.relayEnabled), source: options.relayEnabled ? "persisted" : "default" };
  const json = (data, status = 200) => new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
  const error = (code, message, status) => new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
  async function fetchImpl(url, init = {}) {
    const parsed = new URL(String(url));
    const requestPath = parsed.pathname.replace(/^\/api\/node-agent/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ path: requestPath, method: init.method || "GET", body });
    if (requestPath === "/health") {
      return json({
        ok: true,
        role: "node-agent",
        nodeId: "node_relay",
        protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
        capabilities: options.capabilities || {},
      });
    }
    if (requestPath === "/settings/model-relay" && (!init.method || init.method === "GET")) {
      return json(relay);
    }
    if (requestPath === "/settings/model-relay" && init.method === "PATCH") {
      if (options.disableBlocked && body.enabled === false) {
        return new Response(JSON.stringify({ error: { code: "NODE_MODEL_RELAY_IN_USE", message: "Cannot disable while instance inst_mapped uses a mapping.", details: { instanceIds: ["inst_mapped"] } } }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      relay.enabled = body.enabled;
      relay.source = "persisted";
      if (body.unknownModelPolicy) relay.unknownModelPolicy = body.unknownModelPolicy;
      return json(relay);
    }
    return error("NODE_AGENT_ROUTE_NOT_FOUND", `Unexpected node-agent request ${init.method || "GET"} ${requestPath}`, 404);
  }
  return { fetchImpl, requests, relay };
}

async function createHarness(t, options = {}) {
  const mock = createNodeAgentMock(options);
  const app = await createControlPlaneApp({
    dataDir: tempDataDir("control-plane-relay-settings"),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: { fetchImpl: mock.fetchImpl },
  });
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/api/nodes",
    payload: {
      id: "node_relay",
      name: "Relay Node",
      connectionMode: "direct-http",
      endpoint: "http://relay.example:8091",
      auth: { mode: "paired-hmac", keyId: "relay_key", secret: "relay-secret" },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  mock.requests.length = 0;
  return { app, mock };
}

function relayCapabilities() {
  return {
    managedModels: {
      multiEntityAssignment: true,
      privateModelCatalog: true,
      stableModelIdentity: true,
      modelRelay: { protocols: ["openai-responses", "openai-chat-completions", "anthropic-messages"], streaming: true },
    },
  };
}

function relayUnknownModelPolicyCapabilities() {
  const capabilities = relayCapabilities();
  capabilities.managedModels.modelRelay.unknownModelPolicy = true;
  return capabilities;
}

function onceWebSocketJsonMatching(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for the node.model-relay.updated event"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (message) => {
      try {
        const value = JSON.parse(String(message));
        if (!predicate(value)) return;
        cleanup();
        resolve(value);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
  });
}

test("node relay settings read and write the node-agent authority and publish the event", async (t) => {
  const { app, mock } = await createHarness(t, { capabilities: relayCapabilities() });

  const initial = await app.inject({ method: "GET", url: "/api/nodes/node_relay/settings/model-relay" });
  assert.equal(initial.statusCode, 200, initial.body);
  assert.deepEqual(initial.json().data, { enabled: false, source: "default" });

  // Strict write model: unknown fields and wrong types never reach the node.
  const invalidType = await app.inject({
    method: "PATCH",
    url: "/api/nodes/node_relay/settings/model-relay",
    payload: { enabled: "yes" },
  });
  assert.equal(invalidType.statusCode, 400, invalidType.body);
  const unknownField = await app.inject({
    method: "PATCH",
    url: "/api/nodes/node_relay/settings/model-relay",
    payload: { enabled: true, force: true },
  });
  assert.equal(unknownField.statusCode, 400, unknownField.body);
  assert.equal(mock.requests.some((request) => request.path === "/settings/model-relay" && request.method === "PATCH"), false);

  const socket = await app.injectWS("/api/events");
  const updatedEvent = onceWebSocketJsonMatching(socket, (message) => message?.type === "node.model-relay.updated");
  const updated = await app.inject({
    method: "PATCH",
    url: "/api/nodes/node_relay/settings/model-relay",
    payload: { enabled: true },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(updated.json().data, { enabled: true, source: "persisted" });
  assert.equal(mock.relay.enabled, true);
  const published = await updatedEvent;
  assert.equal(published.payload.nodeId, "node_relay");
  assert.equal(published.payload.enabled, true);
  socket.terminate();

  const reread = await app.inject({ method: "GET", url: "/api/nodes/node_relay/settings/model-relay" });
  assert.deepEqual(reread.json().data, { enabled: true, source: "persisted" });

  const disabled = await app.inject({
    method: "PATCH",
    url: "/api/nodes/node_relay/settings/model-relay",
    payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.deepEqual(disabled.json().data, { enabled: false, source: "persisted" });
});

test("a blocked disable keeps the switch on and surfaces the affected instances", async (t) => {
  const { app, mock } = await createHarness(t, { capabilities: relayCapabilities(), relayEnabled: true, disableBlocked: true });

  const blocked = await app.inject({
    method: "PATCH",
    url: "/api/nodes/node_relay/settings/model-relay",
    payload: { enabled: false },
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().error.code, "NODE_MODEL_RELAY_IN_USE");
  assert.deepEqual(blocked.json().error.details?.instanceIds, ["inst_mapped"]);
  assert.equal(mock.relay.enabled, true);
  const reread = await app.inject({ method: "GET", url: "/api/nodes/node_relay/settings/model-relay" });
  assert.deepEqual(reread.json().data, { enabled: true, source: "persisted" });
});

test("node relay settings downgrade nodes without the relay capability", async (t) => {
  const { app, mock } = await createHarness(t, {
    capabilities: { managedModels: { multiEntityAssignment: true, privateModelCatalog: true, stableModelIdentity: true } },
  });

  const read = await app.inject({ method: "GET", url: "/api/nodes/node_relay/settings/model-relay" });
  assert.equal(read.statusCode, 409, read.body);
  assert.equal(read.json().error.code, "NODE_MODEL_RELAY_UNSUPPORTED");

  const write = await app.inject({
    method: "PATCH",
    url: "/api/nodes/node_relay/settings/model-relay",
    payload: { enabled: true },
  });
  assert.equal(write.statusCode, 409, write.body);
  assert.equal(write.json().error.code, "NODE_MODEL_RELAY_UNSUPPORTED");
  assert.equal(mock.requests.some((request) => request.path === "/settings/model-relay"), false);
});

test("node relay settings strip the unknown-model policy for nodes that predate the capability", async (t) => {
  // relayCapabilities() intentionally omits unknownModelPolicy: the node's
  // strict settings schema cannot parse the additive field.
  const { app, mock } = await createHarness(t, { capabilities: relayCapabilities() });

  const rejectWrite = await app.inject({
    method: "PATCH",
    url: "/api/nodes/node_relay/settings/model-relay",
    payload: { enabled: true, unknownModelPolicy: "reject" },
  });
  assert.equal(rejectWrite.statusCode, 200, rejectWrite.body);
  const rejectForwarded = mock.requests.filter((request) => request.path === "/settings/model-relay" && request.method === "PATCH");
  assert.deepEqual(rejectForwarded.at(-1).body, { enabled: true });

  const defaultWrite = await app.inject({
    method: "PATCH",
    url: "/api/nodes/node_relay/settings/model-relay",
    payload: { enabled: true },
  });
  assert.equal(defaultWrite.statusCode, 200, defaultWrite.body);
  const defaultForwarded = mock.requests.filter((request) => request.path === "/settings/model-relay" && request.method === "PATCH");
  assert.deepEqual(defaultForwarded.at(-1).body, { enabled: true });

  // An explicit passthrough request cannot be honored by a fail-closed node,
  // so it downgrades loudly instead of silently keeping the node's behavior.
  const passthroughWrite = await app.inject({
    method: "PATCH",
    url: "/api/nodes/node_relay/settings/model-relay",
    payload: { enabled: true, unknownModelPolicy: "passthrough" },
  });
  assert.equal(passthroughWrite.statusCode, 409, passthroughWrite.body);
  assert.equal(passthroughWrite.json().error.code, "NODE_MODEL_RELAY_UNKNOWN_MODEL_POLICY_UNSUPPORTED");
  const afterDowngrade = mock.requests.filter((request) => request.path === "/settings/model-relay" && request.method === "PATCH");
  assert.equal(afterDowngrade.length, defaultForwarded.length);
});

test("node relay settings forward the unknown-model policy when the node declares the capability", async (t) => {
  const { app, mock } = await createHarness(t, { capabilities: relayUnknownModelPolicyCapabilities() });

  const updated = await app.inject({
    method: "PATCH",
    url: "/api/nodes/node_relay/settings/model-relay",
    payload: { enabled: true, unknownModelPolicy: "reject" },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(updated.json().data, { enabled: true, source: "persisted", unknownModelPolicy: "reject" });
  assert.deepEqual(mock.requests.at(-1).body, { enabled: true, unknownModelPolicy: "reject" });

  const reread = await app.inject({ method: "GET", url: "/api/nodes/node_relay/settings/model-relay" });
  assert.deepEqual(reread.json().data, { enabled: true, source: "persisted", unknownModelPolicy: "reject" });
});

test("node relay settings stay scoped to the addressed node", async (t) => {
  const { app } = await createHarness(t, { capabilities: relayCapabilities() });
  const missing = await app.inject({ method: "GET", url: "/api/nodes/node_other/settings/model-relay" });
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(missing.json().error.code, "NODE_NOT_FOUND");
});
