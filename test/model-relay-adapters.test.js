const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createNodeAgentApp } = require("../packages/control-plane/src/node-agent.ts");
const { ControlledInstanceSchema } = require("../packages/protocol/src/control-plane.ts");
const { modelRelayRoutePath } = require("../packages/control-plane/src/node-agent/models/relay-routes.ts");
const { ModelRelayService } = require("../packages/control-plane/src/node-agent/models/relay/server.ts");
const { createOpenAiResponsesAdapter } = require("../packages/control-plane/src/node-agent/models/relay/adapters/openai-responses.ts");

const INSTANCE_ID = "inst_adapters";
const INSTANCE_TOKEN = "instance-adapters-token";
const CODEX_KEY = "codex-upstream-secret";
const CHAT_KEY = "chat-upstream-secret";
const CLAUDE_KEY = "claude-upstream-secret";
const PROTOCOLS = ["openai-responses", "openai-chat-completions", "anthropic-messages"];

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-relay-adapters-"));
}

function relayInstance() {
  const timestamp = new Date().toISOString();
  return ControlledInstanceSchema.parse({
    id: INSTANCE_ID, name: INSTANCE_ID, nodeId: "node_relay_adapters", runtimeId: "runtime_local_host",
    status: "running", health: "ok", connectionStatus: "online", agentStatus: "online",
    targetStatus: "reachable", uiAccessStatus: "reachable", controlMode: "controlled", ready: true,
    capabilities: { features: { modelRelay: { protocols: PROTOCOLS, streaming: true } } },
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
    const record = { method: request.method, url: request.url, headers: request.headers, body: Buffer.alloc(0), completed: false, aborted: false };
    requests.push(record);
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("aborted", () => { record.aborted = true; });
    request.on("end", () => {
      record.body = Buffer.concat(chunks);
      record.completed = true;
      handler(record, request, response);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function waitFor(predicate, timeoutMs = 2_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) resolve();
      else if (Date.now() - started > timeoutMs) reject(new Error("condition was not met in time"));
      else setTimeout(poll, 10);
    };
    poll();
  });
}

async function setupRelay(t, upstream) {
  const dataDir = tempDataDir();
  const app = await createNodeAgentApp({ dataDir, logger: false, token: "agent-secret", nodeId: "node_relay_adapters" });
  t.after(async () => { if (!app.closed) await app.close(); });
  app.nodeAgentState.controlledInstances.put(relayInstance());
  const entities = {};
  const definitions = [
    { key: "codex", name: "Codex adapter model", app: "codex", protocol: "openai-responses", endpoint: `${upstream.origin}/v1`, model: CODEX_KEY, external: "public-codex", upstreamName: "upstream-codex" },
    { key: "chat", name: "Chat adapter model", app: "opencode", protocol: "openai-chat-completions", endpoint: `${upstream.origin}/v1`, model: CHAT_KEY, external: "public-chat", upstreamName: "upstream-chat" },
    { key: "claude", name: "Claude adapter model", app: "claude", protocol: "anthropic-messages", endpoint: upstream.origin, model: CLAUDE_KEY, external: "public-claude", upstreamName: "upstream-claude" },
  ];
  for (const definition of definitions) {
    const created = await app.inject({
      method: "POST", url: "/api/node-agent/models",
      headers: { authorization: "Bearer agent-secret" },
      payload: {
        name: definition.name, endpoint: definition.endpoint, key: definition.model, model: definition.external,
        app: definition.app, protocols: [definition.protocol],
        modelNames: [{ name: definition.external, upstreamName: definition.upstreamName, order: 100 }],
        enabled: true, order: 100, labels: {},
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    entities[definition.key] = { id: created.json().data.id, protocol: definition.protocol, external: definition.external, upstreamName: definition.upstreamName };
  }
  const enabled = await app.inject({ method: "PATCH", url: "/api/node-agent/settings/model-relay", headers: { authorization: "Bearer agent-secret" }, payload: { enabled: true } });
  assert.equal(enabled.statusCode, 200);
  const assigned = await app.inject({
    method: "PUT", url: `/api/node-agent/instances/${INSTANCE_ID}/model-assignment`,
    headers: { authorization: "Bearer agent-secret" },
    payload: { modelSelection: { modelEntityIds: Object.values(entities).map((entity) => entity.id) }, modelEntityIds: Object.values(entities).map((entity) => entity.id) },
  });
  assert.equal(assigned.statusCode, 200, assigned.body);
  const listener = await app.listen({ host: "127.0.0.1", port: 0 });
  const route = (key, operation) => `${listener}${modelRelayRoutePath(INSTANCE_ID, entities[key].id, entities[key].protocol)}${operation}`;
  return { app, entities, route };
}

function header(record, name) {
  return record.headers[name.toLowerCase()];
}

test("codex responses rewrites the request model and maps the JSON response back", async (t) => {
  let upstreamRequest;
  const upstream = await startUpstream((record, _request, response) => {
    upstreamRequest = record;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_1", object: "response", model: "upstream-codex",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "pong 🚀" }] }],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    }));
  });
  t.after(() => upstream.close());
  const { route } = await setupRelay(t, upstream);

  const payload = JSON.stringify({
    model: "public-codex",
    instructions: "answer in 中文",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "say pong" }] }],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { query: { type: "string" } } } }],
    stream: true,
    store: false,
  });
  const response = await fetch(route("codex", "/responses"), {
    method: "POST",
    headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
    body: payload,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.model, "public-codex");
  assert.equal(body.output[0].content[0].text, "pong 🚀");
  assert.deepEqual(body.usage, { input_tokens: 3, output_tokens: 1, total_tokens: 4 });

  await waitFor(() => upstreamRequest?.completed);
  assert.equal(upstreamRequest.url, "/v1/responses");
  assert.equal(header(upstreamRequest, "authorization"), `Bearer ${CODEX_KEY}`);
  assert.equal(header(upstreamRequest, "x-api-key"), undefined);
  assert.equal(upstreamRequest.body.toString("utf8"), payload.replace('"public-codex"', '"upstream-codex"'));
});

test("codex responses streams SSE events and only rewrites standard model fields", async (t) => {
  const upstream = await startUpstream((_record, _request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"r1","model":"upstream-codex"}}\n\n');
    response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"upstream-codex is the raw name"}\n\n');
    response.write("data: [DONE]\n\n");
    response.end();
  });
  t.after(() => upstream.close());
  const { route } = await setupRelay(t, upstream);

  const response = await fetch(route("codex", "/responses"), {
    method: "POST",
    headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "public-codex", stream: true, input: "hi" }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.includes('"model":"public-codex"'));
  assert.ok(text.includes("event: response.created\n"));
  assert.ok(text.includes('"delta":"upstream-codex is the raw name"'));
  assert.ok(text.includes("data: [DONE]\n\n"));
});

test("chat completions keeps tool calls, usage and finish reason while rewriting the model", async (t) => {
  const upstream = await startUpstream((_record, _request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"id":"c1","object":"chat.completion.chunk","model":"upstream-chat","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"model\\":\\"x\\"}"}}]},"finish_reason":null}]}\n\n');
    response.write('data: {"id":"c1","object":"chat.completion.chunk","model":"upstream-chat","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n');
    response.write("data: [DONE]\n\n");
    response.end();
  });
  t.after(() => upstream.close());
  const { route } = await setupRelay(t, upstream);

  const response = await fetch(route("chat", "/chat/completions"), {
    method: "POST",
    headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "public-chat", stream: true, messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "lookup" } }] }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.includes('"model":"public-chat"'));
  assert.equal(text.includes('"model":"upstream-chat"'), false);
  assert.ok(text.includes('"finish_reason":"tool_calls"'));
  assert.ok(text.includes('"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}'));
  assert.ok(text.includes('"arguments":"{\\"model\\":\\"x\\"}"'));
  assert.ok(text.includes("data: [DONE]\n\n"));
});

test("anthropic messages rewrites message_start, forwards count_tokens and rejects the gateway probe locally", async (t) => {
  let messageRequest;
  const upstream = await startUpstream((record, _request, response) => {
    if (record.url.startsWith("/v1/messages/count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ input_tokens: 7 }));
      return;
    }
    messageRequest = record;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "upstream-claude",
      content: [{ type: "text", text: "upstream-claude is the raw name" }],
      usage: { input_tokens: 2, output_tokens: 3 },
    }));
  });
  t.after(() => upstream.close());
  const { route } = await setupRelay(t, upstream);

  const probe = await fetch(route("claude", "/api/hello"), { method: "HEAD", headers: { "x-api-key": INSTANCE_TOKEN } });
  assert.equal(probe.status, 404);
  assert.equal(upstream.requests.length, 0);

  const response = await fetch(route("claude", "/messages?beta=true"), {
    method: "POST",
    headers: { "x-api-key": INSTANCE_TOKEN, "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "public-claude", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.model, "public-claude");
  assert.equal(body.content[0].text, "upstream-claude is the raw name");
  await waitFor(() => messageRequest?.completed);
  assert.equal(messageRequest.url, "/v1/messages?beta=true");
  assert.equal(header(messageRequest, "x-api-key"), CLAUDE_KEY);
  assert.equal(header(messageRequest, "authorization"), undefined);
  assert.equal(header(messageRequest, "anthropic-version"), "2023-06-01");
  assert.equal(messageRequest.body.toString("utf8"), JSON.stringify({ model: "upstream-claude", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }));

  const count = await fetch(route("claude", "/messages/count_tokens"), {
    method: "POST",
    headers: { "x-api-key": INSTANCE_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ model: "public-claude", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(count.status, 200);
  assert.deepEqual(await count.json(), { input_tokens: 7 });
  const countRequest = upstream.requests.find((record) => record.url === "/v1/messages/count_tokens");
  await waitFor(() => countRequest?.completed);
  assert.equal(countRequest.body.toString("utf8").includes('"upstream-claude"'), true);
});

test("anthropic relay accepts the version-prefixed path a real Claude Code client sends", async (t) => {
  let messageRequest;
  const upstream = await startUpstream((record, _request, response) => {
    messageRequest = record;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "msg_sdk", type: "message", role: "assistant", model: "upstream-claude",
      content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  t.after(() => upstream.close());
  const { route } = await setupRelay(t, upstream);

  // ANTHROPIC_BASE_URL is the relay base (which ends in `/v1`) and the Anthropic
  // SDK appends `/v1/messages` on top of it, so the relay resolves a duplicated
  // version segment instead of rejecting the request as an unknown operation.
  const response = await fetch(route("claude", "/v1/messages"), {
    method: "POST",
    headers: { "x-api-key": INSTANCE_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ model: "public-claude", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200, await response.text());
  await waitFor(() => messageRequest?.completed);
  assert.equal(messageRequest.url, "/v1/messages");
  assert.equal(messageRequest.body.toString("utf8"), JSON.stringify({ model: "upstream-claude", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }));
});

test("anthropic SSE rewrites message_start.message.model without touching content", async (t) => {
  const upstream = await startUpstream((_record, _request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"upstream-claude","usage":{"input_tokens":2}}}\n\n');
    response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"upstream-claude"}}\n\n');
    response.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    response.end();
  });
  t.after(() => upstream.close());
  const { route } = await setupRelay(t, upstream);

  const response = await fetch(route("claude", "/messages?beta=true"), {
    method: "POST",
    headers: { "x-api-key": INSTANCE_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ model: "public-claude", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.includes('"message":{"id":"msg_1","model":"public-claude"'));
  assert.ok(text.includes('"text":"upstream-claude"'));
  assert.ok(text.includes("event: message_stop\n"));
});

test("the synthetic model catalog serves external names without upstream contact", async (t) => {
  const upstream = await startUpstream((_record, _request, response) => {
    response.writeHead(500);
    response.end("must not be called");
  });
  t.after(() => upstream.close());
  const { route } = await setupRelay(t, upstream);

  const openai = await fetch(route("codex", "/models"), { headers: { authorization: `Bearer ${INSTANCE_TOKEN}` } });
  assert.equal(openai.status, 200);
  const openaiBody = await openai.json();
  assert.equal(openaiBody.object, "list");
  assert.deepEqual(openaiBody.data.map((entry) => entry.id), ["public-codex"]);

  const anthropic = await fetch(route("claude", "/models"), { headers: { "x-api-key": INSTANCE_TOKEN } });
  assert.equal(anthropic.status, 200);
  const anthropicBody = await anthropic.json();
  assert.deepEqual(anthropicBody.data.map((entry) => entry.id), ["public-claude"]);
  assert.equal(anthropicBody.first_id, "public-claude");
  assert.equal(upstream.requests.length, 0);
});

test("unknown operations, unknown names and missing models fail closed before upstream contact", async (t) => {
  const upstream = await startUpstream((_record, _request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  t.after(() => upstream.close());
  const { app, route } = await setupRelay(t, upstream);

  // The node defaults to forwarding unmatched names, so this test pins the
  // fail-closed policy explicitly.
  const rejectPolicy = await app.inject({
    method: "PATCH", url: "/api/node-agent/settings/model-relay",
    headers: { authorization: "Bearer agent-secret" },
    payload: { enabled: true, unknownModelPolicy: "reject" },
  });
  assert.equal(rejectPolicy.statusCode, 200, rejectPolicy.body);

  const unknownOperation = await fetch(route("codex", "/embeddings"), {
    method: "POST", headers: { authorization: `Bearer ${INSTANCE_TOKEN}` }, body: "{}",
  });
  assert.equal(unknownOperation.status, 404);
  assert.equal((await unknownOperation.json()).error.code, "MODEL_RELAY_OPERATION_NOT_ALLOWED");

  const unknownName = await fetch(route("codex", "/responses"), {
    method: "POST", headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "not-assigned", input: "hi" }),
  });
  assert.equal(unknownName.status, 400);
  assert.equal((await unknownName.json()).error.code, "MODEL_RELAY_UNKNOWN_MODEL_NAME");

  const missing = await fetch(route("codex", "/responses"), {
    method: "POST", headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ input: "hi" }),
  });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, "MODEL_RELAY_INVALID_REQUEST_MODEL");
  assert.equal(upstream.requests.length, 0);
});

test("an unmatched model name is forwarded verbatim under the default policy", async (t) => {
  const upstream = await startUpstream((record, _request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "resp_1", model: "not-assigned" }));
  });
  t.after(() => upstream.close());
  const { route } = await setupRelay(t, upstream);

  // Every protocol forwards the unmatched name without rewriting the field.
  const cases = [
    { key: "codex", operation: "/responses", headers: { authorization: `Bearer ${INSTANCE_TOKEN}` } },
    { key: "chat", operation: "/chat/completions", headers: { authorization: `Bearer ${INSTANCE_TOKEN}` } },
    { key: "claude", operation: "/messages", headers: { "x-api-key": INSTANCE_TOKEN } },
  ];
  for (const testCase of cases) {
    const payload = JSON.stringify({ model: "not-assigned", input: "hi" });
    const response = await fetch(route(testCase.key, testCase.operation), {
      method: "POST",
      headers: { ...testCase.headers, "content-type": "application/json" },
      body: payload,
    });
    assert.equal(response.status, 200, testCase.key);
    // The identity rewrite leaves the request bytes intact.
    assert.equal(upstream.requests.at(-1).body.toString("utf8"), payload, testCase.key);
  }
});

test("a duplicate top-level model field aborts the upstream request", async (t) => {
  const upstream = await startUpstream((_record, _request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  t.after(() => upstream.close());
  const { route } = await setupRelay(t, upstream);

  const response = await fetch(route("codex", "/responses"), {
    method: "POST",
    headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
    body: '{"model":"public-codex","input":"hi","model":"public-codex"}',
  }).catch((error) => ({ status: 599, error }));
  assert.notEqual(response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (upstream.requests.length) {
    assert.equal(upstream.requests[0].completed, false, "the duplicate model request must never complete upstream");
  }
});

test("a multi-megabyte scalar after the model is forwarded with only the model changed", async (t) => {
  let upstreamRequest;
  const upstream = await startUpstream((record, _request, response) => {
    upstreamRequest = record;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "c1", model: "upstream-chat", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
  });
  t.after(() => upstream.close());
  const { route } = await setupRelay(t, upstream);

  const payload = JSON.stringify({ model: "public-chat", messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }] });
  const response = await fetch(route("chat", "/chat/completions"), {
    method: "POST",
    headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
    body: payload,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).model, "public-chat");
  await waitFor(() => upstreamRequest?.completed);
  assert.equal(upstreamRequest.body.toString("utf8"), payload.replace('"public-chat"', '"upstream-chat"'));
});

test("fixture-derived requests keep every captured top-level field except the model", async (t) => {
  const fixturesDir = path.join(__dirname, "fixtures/model-relay");
  const captures = ["codex-0.153.4-capture.json", "claude-code-2.1.286-capture.json", "opencode-1.18.29-capture.json"]
    .map((name) => JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8")))
    .filter((capture) => capture.artifact.app !== "claude");
  const upstream = await startUpstream((record, _request, response) => {
    if (record.url.startsWith("/v1/responses") || record.url.startsWith("/v1/chat/completions")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  t.after(() => upstream.close());
  const { route, entities } = await setupRelay(t, upstream);

  const keys = {
    codex: "codex",
    opencode: "chat",
  };
  for (const capture of captures) {
    const entity = entities[keys[capture.artifact.app]];
    const operation = capture.operations.find((entry) => entry.method === "POST");
    const external = entity.external;
    const body = Object.fromEntries(operation.body.topLevelKeys.map((key) => [key, key === "model" ? external : probeValue(key)]));
    const path = operation.path.replace(/^\/v1/, "").split("?")[0];
    const requestCount = upstream.requests.length;
    const response = await fetch(route(keys[capture.artifact.app], path), {
      method: "POST",
      headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `${capture.artifact.app} ${path}`);
    const request = upstream.requests[requestCount];
    await waitFor(() => request?.completed);
    const expected = JSON.stringify(Object.fromEntries(Object.entries(body).map(([key, value]) => [key, key === "model" ? entity.upstreamName : value])));
    assert.equal(request.body.toString("utf8"), expected, `${capture.artifact.app} request bytes`);
    assert.deepEqual(Object.keys(JSON.parse(request.body.toString("utf8"))), operation.body.topLevelKeys);
  }
});

function probeValue(key) {
  const probes = {
    stream: true,
    store: false,
    max_tokens: 64,
    tools: [{ type: "function", name: "probe_tool", parameters: { type: "object", properties: { query: { type: "string" } } } }],
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "probe 🚀 中文" }] }],
    messages: [{ role: "user", content: "probe 中文 🚀" }],
  };
  return probes[key] ?? `probe-${key}`;
}

test("an upstream model mismatch keeps the actual value and logs a safe diagnostic", async (t) => {
  const logs = [];
  const logger = { info: (data, message) => logs.push({ level: "info", data, message }), warn: (data, message) => logs.push({ level: "warn", data, message }), debug: () => undefined };
  const instance = relayInstance();
  const model = {
    id: "mdl_mismatch", name: "Mismatch", endpoint: "http://mismatch-upstream.invalid/v1", key: "mismatch-secret",
    model: "public-mismatch", modelNames: [{ name: "public-mismatch", upstreamName: "upstream-mismatch", order: 100 }],
    protocols: ["openai-responses"], app: "codex", enabled: true, order: 100, labels: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const service = new ModelRelayService({
    resolver: {
      instance: () => instance,
      relayEnabled: () => true,
      resolveRoute: () => ({ instance, model, protocol: "openai-responses", routeId: "rly_mismatch" }),
      resolveUpstreamModelName: () => "upstream-mismatch",
    },
    adapters: [createOpenAiResponsesAdapter()],
    log: logger,
    fetchImpl: async () => new Response(JSON.stringify({ model: "vendor-alias", output: "ok" }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const Fastify = require("fastify");
  const app = Fastify({ logger: false });
  service.registerRoutes(app);
  t.after(async () => app.close());
  await app.ready();

  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/model-relay/instances/inst_adapters/routes/rly_mismatch/v1/responses",
    headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
    payload: JSON.stringify({ model: "public-mismatch", input: "hi" }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().model, "vendor-alias");
  const serialized = JSON.stringify(logs);
  assert.ok(serialized.includes("MODEL_RELAY_UPSTREAM_MODEL_MISMATCH"));
  assert.equal(serialized.includes("upstream-mismatch"), false);
  assert.equal(serialized.includes("public-mismatch"), false);
  assert.equal(serialized.includes("mismatch-secret"), false);
});

test("an identity mapping keeps the actual value without a mismatch diagnostic", async (t) => {
  const logs = [];
  const logger = { info: (data, message) => logs.push({ level: "info", data, message }), warn: (data, message) => logs.push({ level: "warn", data, message }), debug: () => undefined };
  const instance = relayInstance();
  // A declared name that resolves to itself (or a passthrough of an unknown
  // name) remaps nothing, so the upstream answering with a different canonical
  // name is expected and must not spam the warn-level mismatch diagnostic.
  const model = {
    id: "mdl_identity", name: "Identity", endpoint: "http://identity-upstream.invalid/v1", key: "identity-secret",
    model: "public-identity", modelNames: [{ name: "public-identity", upstreamName: "public-identity", order: 100 }],
    protocols: ["openai-responses"], app: "codex", enabled: true, order: 100, labels: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const service = new ModelRelayService({
    resolver: {
      instance: () => instance,
      relayEnabled: () => true,
      resolveRoute: () => ({ instance, model, protocol: "openai-responses", routeId: "rly_identity" }),
      resolveUpstreamModelName: (_model, name) => name,
    },
    adapters: [createOpenAiResponsesAdapter()],
    log: logger,
    fetchImpl: async () => new Response(JSON.stringify({ model: "vendor-alias", output: "ok" }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const Fastify = require("fastify");
  const app = Fastify({ logger: false });
  service.registerRoutes(app);
  t.after(async () => app.close());
  await app.ready();

  const response = await app.inject({
    method: "POST",
    url: "/api/node-agent/model-relay/instances/inst_adapters/routes/rly_identity/v1/responses",
    headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
    payload: JSON.stringify({ model: "public-identity", input: "hi" }),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().model, "vendor-alias");
  assert.equal(JSON.stringify(logs).includes("MODEL_RELAY_UPSTREAM_MODEL_MISMATCH"), false);
});

test("an upstream error response is forwarded unchanged without model rewriting", async (t) => {
  const errorBody = JSON.stringify({ error: { type: "rate_limit_error", message: "upstream-chat is rate limited", model: "upstream-chat" } });
  const upstream = await startUpstream((_record, _request, response) => {
    response.writeHead(429, { "content-type": "application/json", "retry-after": "3" });
    response.end(errorBody);
  });
  t.after(() => upstream.close());
  const { route } = await setupRelay(t, upstream);

  const response = await fetch(route("chat", "/chat/completions"), {
    method: "POST",
    headers: { authorization: `Bearer ${INSTANCE_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "public-chat", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "3");
  assert.equal(await response.text(), errorBody);
});
