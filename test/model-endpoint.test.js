const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const Fastify = require("fastify");
const { createControlPlaneApp } = require("../packages/control-plane/src/server.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");
const { NodeModelRegistry } = require("../packages/control-plane/src/node-agent/models/registry.ts");
const { registerNodeModelRoutes } = require("../packages/control-plane/src/node-agent/models/routes.ts");

const {
  discoverModels,
  modelListCandidates,
  testModelEndpoint,
} = require("../packages/control-plane/src/shared/models/model-endpoint.ts");

test("model discovery derives versioned and origin candidates without provider-specific branches", () => {
  assert.deepEqual(modelListCandidates("https://gateway.example/api/v1"), [
    "https://gateway.example/api/v1/models",
    "https://gateway.example/v1/models",
    "https://gateway.example/models",
  ]);
  assert.deepEqual(modelListCandidates("https://gateway.example/anthropic"), [
    "https://gateway.example/anthropic/v1/models",
    "https://gateway.example/v1/models",
    "https://gateway.example/models",
  ]);
});

test("model discovery retries only unsupported candidates and returns a sorted unique wire model", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ data: [
      { id: "z-model", owned_by: "vendor-z" },
      { id: "a-model" },
      { id: "a-model", owned_by: "duplicate" },
      { invalid: true },
    ] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await discoverModels(fetchImpl, { endpoint: "https://gateway.example/anthropic", key: "secret-key" });
  assert.deepEqual(result.models, [{ id: "a-model" }, { id: "z-model", ownedBy: "vendor-z" }]);
  assert.equal(requests[0].url, "https://gateway.example/anthropic/v1/models");
  assert.equal(requests[1].url, "https://gateway.example/v1/models");
  assert.equal(requests[1].init.headers.authorization, "Bearer secret-key");
  assert.equal(requests[1].init.redirect, "error");
  assert.equal("key" in result, false);
});

test("model discovery maps authentication failures without exposing provider bodies or keys", async () => {
  await assert.rejects(
    discoverModels(async () => new Response("secret-key provider diagnostic", { status: 401 }), {
      endpoint: "https://gateway.example/v1",
      key: "secret-key",
    }),
    (error) => {
      assert.equal(error.code, "MODEL_DISCOVERY_FAILED");
      assert.equal(error.details.upstreamStatus, 401);
      assert.equal(error.message.includes("secret-key"), false);
      assert.equal(error.message.includes("provider diagnostic"), false);
      return true;
    },
  );
});

test("Codex model test uses the Responses API with a bounded non-streaming request", async () => {
  let request;
  const result = await testModelEndpoint(async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ id: "response" }), { status: 200 });
  }, { endpoint: "https://gateway.example/v1", key: "codex-key", model: "gpt-test", app: "codex" });
  assert.equal(result.success, true);
  assert.equal(request.url, "https://gateway.example/v1/responses");
  assert.equal(request.init.headers.authorization, "Bearer codex-key");
  assert.deepEqual(JSON.parse(request.init.body), { model: "gpt-test", input: "Reply with OK.", max_output_tokens: 32, stream: false });
});

test("Claude model test uses Messages API and Anthropic key headers", async () => {
  let request;
  await testModelEndpoint(async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ id: "message" }), { status: 200 });
  }, { endpoint: "https://gateway.example/anthropic", key: "claude-key", model: "claude-test", app: "claude" });
  assert.equal(request.url, "https://gateway.example/anthropic/v1/messages");
  assert.equal(request.init.headers["x-api-key"], "claude-key");
  assert.equal(request.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(JSON.parse(request.init.body).model, "claude-test");
});

test("model tests reject a successful HTTP response with an invalid protocol payload", async () => {
  await assert.rejects(
    testModelEndpoint(async () => new Response("not-json", { status: 200 }), {
      endpoint: "https://gateway.example/v1",
      key: "key",
      model: "gpt-test",
      app: "codex",
    }),
    { code: "MODEL_TEST_RESPONSE_INVALID" },
  );
});

test("model endpoint URLs reject non-http schemes and embedded credentials", async () => {
  await assert.rejects(
    discoverModels(async () => { throw new Error("must not fetch"); }, { endpoint: "file:///tmp/models", key: "key" }),
    { code: "MODEL_ENDPOINT_INVALID" },
  );
  await assert.rejects(
    discoverModels(async () => { throw new Error("must not fetch"); }, { endpoint: "https://user:pass@gateway.example/v1", key: "key" }),
    { code: "MODEL_ENDPOINT_INVALID" },
  );
});

test("control-plane model discovery and testing reuse a stored key without exposing it", async (t) => {
  const requests = [];
  const app = await createControlPlaneApp({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-model-endpoint-")),
    logger: false,
    staticDir: path.join(os.tmpdir(), "missing-task-handoff-ui"),
    service: {
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).endsWith("/models")) {
          return new Response(JSON.stringify({ data: [{ id: "gpt-integration" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: "response" }), { status: 200 });
      },
    },
  });
  t.after(() => app.close());
  const created = await app.inject({ method: "POST", url: "/api/models", payload: {
    name: "Integration model",
    endpoint: "https://gateway.example/v1",
    key: "stored-private-key",
    model: "gpt-integration",
    app: "codex",
  } });
  assert.equal(created.statusCode, 201, created.body);
  const modelId = created.json().data.id;
  const discovered = await app.inject({ method: "POST", url: "/api/models/discover", payload: {
    endpoint: "https://gateway.example/v1",
    existingModelId: modelId,
  } });
  assert.equal(discovered.statusCode, 200, discovered.body);
  assert.deepEqual(discovered.json().data.models, [{ id: "gpt-integration" }]);
  assert.equal(discovered.body.includes("stored-private-key"), false);
  const discoveryRequest = requests.find((request) => request.url === "https://gateway.example/v1/models");
  assert.equal(discoveryRequest.init.headers.authorization, "Bearer stored-private-key");
  const checked = await app.inject({ method: "POST", url: "/api/models/test", payload: {
    endpoint: "https://gateway.example/v1",
    existingModelId: modelId,
    model: "gpt-integration",
    app: "codex",
  } });
  assert.equal(checked.statusCode, 200, checked.body);
  assert.equal(checked.json().data.success, true);
  assert.equal(checked.body.includes("stored-private-key"), false);
  const testRequest = requests.find((request) => request.url === "https://gateway.example/v1/responses");
  assert.equal(testRequest.init.headers.authorization, "Bearer stored-private-key");
});

test("node-owned model probes execute on the node and reuse only its private credential", async (t) => {
  const registry = new NodeModelRegistry(nodeAgentStorePaths(fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-node-model-endpoint-"))), "node-probe", {
    has: () => false,
    list: () => [],
    require: () => { throw new Error("not used"); },
    put: () => { throw new Error("not used"); },
  });
  registry.init();
  const stored = registry.create({
    name: "Node model",
    endpoint: "https://node-gateway.example/v1",
    key: "node-private-key",
    model: "node-model",
    app: "codex",
  });
  const requests = [];
  const app = Fastify({ logger: false });
  registerNodeModelRoutes(app, registry, async () => {}, async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ data: [{ id: "node-model" }] }), { status: 200 });
  });
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: "/api/node-agent/models/discover", payload: {
    endpoint: "https://node-gateway.example/v1",
    existingModelId: stored.id,
  } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().data.models, [{ id: "node-model" }]);
  assert.equal(requests[0].init.headers.authorization, "Bearer node-private-key");
  assert.equal(response.body.includes("node-private-key"), false);
});
