const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent.ts");
const { ControlledInstanceSchema } = require("../packages/protocol/src/control-plane.ts");
const {
  INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION,
} = require("../packages/core/src/core/instance-private-model-catalog.ts");
const {
  applyManagedCodexModelConfig,
  codexProviderEnvironment,
} = require("../packages/controlled-instance/src/web/codex-model-config.ts");
const { applyManagedClaudeModelConfig } = require("../packages/controlled-instance/src/web/claude-model-config.ts");
const { resolveControlledPrivateModelSelection } = require("../packages/controlled-instance/src/web/private-model-catalog.ts");

const INSTANCE_ID = "inst_relay_consumption";
const INSTANCE_TOKEN = "instance-consumption-token";
const CODEX_KEY = "consumption-codex-secret";
const CHAT_KEY = "consumption-chat-secret";
const CLAUDE_KEY = "consumption-claude-secret";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function relayInstance(instanceId, capabilities) {
  const timestamp = new Date().toISOString();
  return ControlledInstanceSchema.parse({
    id: instanceId, name: instanceId, nodeId: "node_relay_consumption", runtimeId: "runtime_local_host",
    status: "running", health: "ok", connectionStatus: "online", agentStatus: "online",
    targetStatus: "reachable", uiAccessStatus: "reachable", controlMode: "controlled", ready: true,
    capabilities,
    config: {}, source: { type: "local-folder", path: "/workspace" }, sourceSnapshot: {}, modelSelection: {},
    workspace: { status: "ready", path: "/workspace" }, target: { strategy: "node-proxy", status: "reachable" },
    apps: { runningCount: 0, problemCount: 0 },
    aiSessions: { runningCount: 0, waitingCount: 0, sessions: [], updatedAt: timestamp },
    runtime: { kind: "local", port: 32123, labels: {} },
    registrationToken: INSTANCE_TOKEN, createdAt: timestamp, updatedAt: timestamp,
  });
}

async function startUpstream(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const record = { method: request.method, url: request.url, headers: request.headers, body: Buffer.alloc(0) };
    requests.push(record);
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      record.body = Buffer.concat(chunks);
      handler(record, response);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function resolveRelayOrigin(t, upstream, options = {}) {
  const dataDir = tempDir("task-handoff-relay-consumption-");
  const port = await freePort();
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_consumption", port });
  t.after(async () => { if (!app.closed) await app.close(); });
  const capabilities = options.capabilities ?? {
    features: {
      privateModelCatalog: true,
      modelRelay: { protocols: ["openai-responses", "openai-chat-completions", "anthropic-messages"], streaming: true },
    },
  };
  app.nodeAgentState.controlledInstances.put(relayInstance(options.instanceId || INSTANCE_ID, capabilities));

  const mappings = options.sameName
    ? (name, upstreamName) => [{ name, upstreamName: name, order: 100 }]
    : (name, upstreamName) => [{ name, upstreamName, order: 100 }];
  const definitions = [
    { key: "codex", app: "codex", protocol: "openai-responses", endpoint: `${upstream.origin}/v1`, upstreamKey: CODEX_KEY, external: "public-codex", upstreamName: "upstream-codex" },
    { key: "chat", app: "opencode", protocol: "openai-chat-completions", endpoint: `${upstream.origin}/v1`, upstreamKey: CHAT_KEY, external: "public-chat", upstreamName: "upstream-chat" },
    { key: "claude", app: "claude", protocol: "anthropic-messages", endpoint: upstream.origin, upstreamKey: CLAUDE_KEY, external: "public-claude", upstreamName: "upstream-claude" },
  ];
  const entities = {};
  for (const definition of definitions) {
    const created = await app.inject({
      method: "POST", url: "/api/node-agent/models",
      headers: { authorization: "Bearer agent-secret" },
      payload: {
        name: `${definition.key} model`, endpoint: definition.endpoint, key: definition.upstreamKey,
        model: definition.external, app: definition.app, protocols: [definition.protocol],
        modelNames: mappings(definition.external, definition.upstreamName),
        enabled: true, order: 100, labels: {},
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    entities[definition.key] = { ...definition, id: created.json().data.id };
  }
  if (options.enableRelay !== false) {
    const enabled = await app.inject({ method: "PATCH", url: "/api/node-agent/settings/model-relay", headers: { authorization: "Bearer agent-secret" }, payload: { enabled: true } });
    assert.equal(enabled.statusCode, 200, enabled.body);
  }
  const assignment = await app.inject({
    method: "PUT", url: `/api/node-agent/instances/${INSTANCE_ID}/model-assignment`,
    headers: { authorization: "Bearer agent-secret" },
    payload: { modelSelection: { modelEntityIds: Object.values(entities).map((entity) => entity.id) }, modelEntityIds: Object.values(entities).map((entity) => entity.id) },
  });
  assert.equal(assignment.statusCode, options.expectAssignmentFailure ? 409 : 200, assignment.body);
  const listener = await app.listen({ host: "127.0.0.1", port });
  return { app, port, listener, entities, dataDir };
}

test("relay projection exposes routes, not upstream secrets, and stays callable end to end", async (t) => {
  let upstreamRequest;
  const upstream = await startUpstream((record, response) => {
    upstreamRequest = record;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_1", model: "upstream-codex", output: [{ type: "message", content: [{ type: "output_text", text: "pong" }] }] }));
  });
  t.after(() => upstream.close());
  const { app, entities, listener } = await resolveRelayOrigin(t, upstream);

  const catalog = app.nodeAgentState.modelRegistry.privateCatalog(INSTANCE_ID);
  assert.equal(catalog.protocolVersion, INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION);
  assert.equal(catalog.entities.length, 3);
  const codex = catalog.entities.find((entity) => entity.id === entities.codex.id);
  assert.equal(codex.routes.length, 1);
  const codexRoute = codex.routes[0];
  assert.equal(codexRoute.protocol, "openai-responses");
  assert.ok(codexRoute.baseUrl.startsWith(listener));
  assert.ok(codexRoute.baseUrl.includes(`/api/node-agent/model-relay/instances/${INSTANCE_ID}/routes/`));
  assert.equal(codex.endpoint, undefined);
  assert.equal(codex.key, undefined);
  assert.deepEqual(codex.modelNames, [{ name: "public-codex", order: 100 }]);

  // The instance-side selection uses only the external identity.
  assert.deepEqual(
    resolveControlledPrivateModelSelection(catalog, "codex", { modelEntityId: entities.codex.id, modelName: "public-codex" }),
    { modelEntityId: entities.codex.id, modelName: "public-codex" },
  );

  const environment = app.nodeAgentState.resolvedAssignedModelEnvironment(INSTANCE_ID);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.OPENAI_BASE_URL, undefined);
  assert.equal(environment.TASK_HANDOFF_CODEX_BASE_URL, undefined);
  assert.equal(environment.ANTHROPIC_API_KEY, INSTANCE_TOKEN);
  assert.ok(environment.ANTHROPIC_BASE_URL.startsWith(listener));
  assert.equal(environment.TASK_HANDOFF_CLAUDE_MODEL, "public-claude");
  const opencode = JSON.parse(environment.TASK_HANDOFF_OPENCODE_CONFIG_CONTENT);
  assert.equal(opencode.model, `task-handoff-${entities.chat.id}/public-chat`);
  assert.equal(opencode.provider[`task-handoff-${entities.chat.id}`].options.apiKey, INSTANCE_TOKEN);
  assert.ok(opencode.provider[`task-handoff-${entities.chat.id}`].options.baseURL.startsWith(listener));

  const relayed = await fetch(`${codexRoute.baseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "public-codex", input: "hi" }),
  });
  assert.equal(relayed.status, 200);
  assert.equal((await relayed.json()).model, "public-codex");
  assert.equal(upstreamRequest.url, "/v1/responses");
  assert.equal(upstreamRequest.headers.authorization, `Bearer ${CODEX_KEY}`);
  assert.equal(upstreamRequest.body.toString("utf8"), JSON.stringify({ model: "upstream-codex", input: "hi" }));

  // The materialized private config carries the same relay catalog and no
  // upstream endpoint, key or upstreamName anywhere.
  const privateConfig = fs.readFileSync(app.nodeAgentState.instancePrivateConfigs.filePath(INSTANCE_ID), "utf8");
  assert.equal(privateConfig.includes(INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION), true);
  for (const secret of [CODEX_KEY, CHAT_KEY, CLAUDE_KEY, upstream.origin, "upstream-codex", "upstream-chat", "upstream-claude"]) {
    assert.equal(privateConfig.includes(secret), false, `${secret} must not reach the instance private config`);
  }
  for (const secret of [CODEX_KEY, CHAT_KEY, CLAUDE_KEY, upstream.origin, "upstream-codex"]) {
    assert.equal(JSON.stringify(environment).includes(secret), false, `${secret} must not reach the instance environment`);
  }
});

test("codex, claude and opencode relay configs use the relay base URL and instance credential", async (t) => {
  const upstream = await startUpstream((_record, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  t.after(() => upstream.close());
  const { app, entities } = await resolveRelayOrigin(t, upstream);
  const catalog = app.nodeAgentState.modelRegistry.privateCatalog(INSTANCE_ID);
  const environment = app.nodeAgentState.resolvedAssignedModelEnvironment(INSTANCE_ID);
  const home = tempDir("task-handoff-relay-consumption-home-");

  const codexEnv = {
    TASK_HANDOFF_CONTROL_MODE: "controlled",
    TASK_HANDOFF_REGISTRATION_TOKEN: INSTANCE_TOKEN,
    HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
  };
  const codex = applyManagedCodexModelConfig(codexEnv, catalog);
  assert.equal(codex.applied, true);
  const configToml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  const providerId = `task-handoff-${entities.codex.id}`;
  assert.ok(configToml.includes(`[model_providers.${providerId}]`));
  const relayBaseUrl = catalog.entities.find((entity) => entity.id === entities.codex.id).routes[0].baseUrl;
  assert.ok(configToml.includes(`base_url = "${relayBaseUrl}"`));
  assert.ok(configToml.includes('model = "public-codex"'));
  assert.equal(configToml.includes(CODEX_KEY), false);
  assert.equal(configToml.includes(upstream.origin), false);
  const providerKeys = Object.values(codexProviderEnvironment(catalog, codexEnv));
  assert.deepEqual(providerKeys, [INSTANCE_TOKEN]);
  assert.equal(configToml.includes(INSTANCE_TOKEN), false, "the credential stays in the runtime environment");

  const claudeHome = tempDir("task-handoff-relay-consumption-claude-");
  const claude = applyManagedClaudeModelConfig({ ...environment, TASK_HANDOFF_CONTROL_MODE: "controlled", HOME: claudeHome });
  assert.equal(claude.applied, true);
  const claudeSettings = fs.readFileSync(path.join(claudeHome, ".claude", "settings.json"), "utf8");
  const claudeEnv = JSON.parse(claudeSettings).env;
  assert.equal(claudeEnv.ANTHROPIC_API_KEY, INSTANCE_TOKEN);
  assert.equal(claudeEnv.ANTHROPIC_BASE_URL, environment.ANTHROPIC_BASE_URL);
  assert.equal(claudeEnv.ANTHROPIC_MODEL, "public-claude");
  assert.equal(claudeSettings.includes(CLAUDE_KEY), false);
  assert.equal(claudeSettings.includes(upstream.origin), false);

  const opencode = JSON.parse(environment.TASK_HANDOFF_OPENCODE_CONFIG_CONTENT);
  const chatProvider = opencode.provider[`task-handoff-${entities.chat.id}`];
  assert.equal(chatProvider.options.apiKey, INSTANCE_TOKEN);
  assert.equal(chatProvider.options.baseURL, catalog.entities.find((entity) => entity.id === entities.chat.id).routes[0].baseUrl);
  assert.deepEqual(Object.keys(chatProvider.models), ["public-chat"]);
  assert.equal(JSON.stringify(opencode).includes(CHAT_KEY), false);
});

test("turning the switch off restores the v0.0.34 direct projection without restarting", async (t) => {
  const upstream = await startUpstream((_record, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  t.after(() => upstream.close());
  const { app, entities } = await resolveRelayOrigin(t, upstream, { sameName: true, instanceId: INSTANCE_ID });

  const relayCatalog = app.nodeAgentState.modelRegistry.privateCatalog(INSTANCE_ID);
  assert.equal(relayCatalog.protocolVersion, INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION);

  const disabled = await app.inject({
    method: "PATCH", url: "/api/node-agent/settings/model-relay",
    headers: { authorization: "Bearer agent-secret" }, payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 200, disabled.body);

  const directCatalog = app.nodeAgentState.modelRegistry.privateCatalog(INSTANCE_ID);
  assert.equal(directCatalog.protocolVersion, "2026-08-27");
  const codex = directCatalog.entities.find((entity) => entity.id === entities.codex.id);
  assert.equal(codex.endpoint, `${upstream.origin}/v1`);
  assert.equal(codex.key, CODEX_KEY);
  assert.equal(codex.routes, undefined);

  const environment = app.nodeAgentState.resolvedAssignedModelEnvironment(INSTANCE_ID);
  assert.equal(environment.ANTHROPIC_API_KEY, CLAUDE_KEY);
  assert.equal(environment.ANTHROPIC_BASE_URL, upstream.origin);
  assert.equal(environment.TASK_HANDOFF_CLAUDE_MODEL, "public-claude");
  const opencode = JSON.parse(environment.TASK_HANDOFF_OPENCODE_CONFIG_CONTENT);
  assert.equal(opencode.provider[`task-handoff-${entities.chat.id}`].options.apiKey, CHAT_KEY);
  assert.equal(opencode.provider[`task-handoff-${entities.chat.id}`].options.baseURL, `${upstream.origin}/v1`);
});

test("instances without the relay consumer capability keep the direct projection and reject mapped assignments", async (t) => {
  const upstream = await startUpstream((_record, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  t.after(() => upstream.close());
  const { app } = await resolveRelayOrigin(t, upstream, {
    capabilities: { features: { privateModelCatalog: true } },
    expectAssignmentFailure: true,
  });

  const catalog = app.nodeAgentState.modelRegistry.privateCatalog(INSTANCE_ID);
  assert.equal(catalog.protocolVersion, "2026-08-27");
  assert.equal(catalog.entities.length, 0, "mapped entities must not leak into a direct catalog");
  assert.deepEqual(app.nodeAgentState.resolvedAssignedModelEnvironment(INSTANCE_ID), {});
});

test("relay catalogs read back from the private config file and sanitize unknown fields", async () => {
  const {
    parseInstancePrivateModelCatalog,
    summarizeInstancePrivateModelCatalog,
  } = require("../packages/core/src/core/instance-private-model-catalog.ts");
  const { readControlledPrivateModelCatalogSource } = require("../packages/controlled-instance/src/web/private-model-catalog.ts");

  const relayCatalog = {
    protocolVersion: INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION,
    instanceId: INSTANCE_ID,
    entities: [{
      id: "mdl_relay_file",
      protocols: ["openai-responses"],
      modelNames: [{ name: "public-codex", order: 100 }],
      routes: [{ protocol: "openai-responses", baseUrl: "http://127.0.0.1:9/api/node-agent/model-relay/instances/inst_relay_consumption/routes/rly_x/v1" }],
      unknownFutureField: "ignored",
    }],
    updatedAt: "2026-10-02T00:00:00.000Z",
  };
  const parsed = parseInstancePrivateModelCatalog(relayCatalog);
  assert.equal(parsed.protocolVersion, INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION);
  assert.equal(parsed.entities[0].unknownFutureField, undefined);
  const summary = summarizeInstancePrivateModelCatalog(parsed);
  assert.equal(JSON.stringify(summary).includes("baseUrl"), false);
  assert.equal(JSON.stringify(summary).includes("unknownFutureField"), false);

  assert.throws(() => parseInstancePrivateModelCatalog({ ...relayCatalog, protocolVersion: "2099-01-01" }));

  const root = tempDir("task-handoff-relay-consumption-offline-");
  const filePath = path.join(root, "private-config.json");
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    instanceId: INSTANCE_ID,
    instanceCredential: INSTANCE_TOKEN,
    environment: {},
    modelCatalog: relayCatalog,
    updatedAt: "2026-10-02T00:00:00.000Z",
  }));
  const previous = { path: process.env.TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH, instanceId: process.env.TASK_HANDOFF_INSTANCE_ID };
  process.env.TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH = filePath;
  process.env.TASK_HANDOFF_INSTANCE_ID = INSTANCE_ID;
  try {
    // No node-agent involved: the instance resumes its relay catalog from the
    // root-only private config after a restart or while the node is offline.
    const loaded = readControlledPrivateModelCatalogSource(process.env);
    assert.equal(loaded.source, "private-config-file");
    assert.equal(loaded.catalog.protocolVersion, INSTANCE_PRIVATE_MODEL_CATALOG_RELAY_PROTOCOL_VERSION);
    assert.equal(loaded.catalog.entities[0].routes[0].baseUrl, relayCatalog.entities[0].routes[0].baseUrl);
  } finally {
    if (previous.path === undefined) delete process.env.TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH;
    else process.env.TASK_HANDOFF_INSTANCE_PRIVATE_CONFIG_PATH = previous.path;
    if (previous.instanceId === undefined) delete process.env.TASK_HANDOFF_INSTANCE_ID;
    else process.env.TASK_HANDOFF_INSTANCE_ID = previous.instanceId;
  }
});
