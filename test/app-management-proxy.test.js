const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { EventEmitter } = require("node:events");
const WebSocket = require("ws");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();
require.extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, allowSyntheticDefaultImports: true },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { ControlledInstanceGateway } = require("../packages/control-plane/src/control-plane/instances/gateway.ts");
const { NodeAgentInstanceEventForwarder } = require("../packages/control-plane/src/node-agent/events.ts");
const { eventTopic } = require("../packages/protocol/src/events.ts");
const { parseInstanceAppManagementSnapshot } = require("../packages/control-plane/src/control-plane/application/service.ts");

const instance = {
  id: "inst_apps",
  name: "Apps Instance",
  nodeId: "node_apps",
  connectionStatus: "online",
  agentStatus: "online",
  target: { web: "http://127.0.0.1:19000" },
};
const node = { id: "node_apps" };

function transportWithRequest(request) {
  return { request, requestStream: request, proxyWebSocket() {} };
}

test("control-plane gateway sends app management requests through the generic node instance proxy unchanged", async () => {
  const requests = [];
  const gateway = new ControlledInstanceGateway({
    requireNode: () => node,
    nodeAgentTransport: () => transportWithRequest(async (_node, route, init) => {
      requests.push({ route, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ data: { job: { id: "job_apps", appId: "chromium" } } }), { status: 202, headers: { "content-type": "application/json" } });
    }),
  });
  const result = await gateway.request(instance, "/apps/chromium/install", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "request_apps" }),
  });
  assert.equal(result.job.id, "job_apps");
  assert.deepEqual(requests, [{
    route: "/instances/inst_apps/proxy",
    body: {
      path: "/api/apps/chromium/install",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "request_apps" }),
    },
  }]);
  assert.equal(requests[0].body.path.includes("job_apps"), false);
});

test("structured controlled-instance conflicts survive the proxy boundary", async () => {
  const gateway = new ControlledInstanceGateway({
    requireNode: () => node,
    nodeAgentTransport: () => transportWithRequest(async () => new Response(JSON.stringify({
      error: { code: "app_sessions_running", message: "App has running sessions.", details: { sessionIds: ["session_apps"] } },
    }), { status: 409, headers: { "content-type": "application/json" } })),
  });
  await assert.rejects(
    gateway.request(instance, "/apps/chromium/uninstall", { method: "POST", body: "{}" }),
    (error) => error.code === "app_sessions_running" && error.statusCode === 409 && error.details.sessionIds[0] === "session_apps",
  );
});

test("offline instances fail before stale inventory can be treated as management capability", async () => {
  let requests = 0;
  const gateway = new ControlledInstanceGateway({
    requireNode: () => node,
    nodeAgentTransport: () => transportWithRequest(async () => { requests += 1; return new Response("{}"); }),
  });
  await assert.rejects(
    gateway.request({ ...instance, connectionStatus: "offline", agentStatus: "offline", appInventory: { items: [], issues: [], observedAt: new Date().toISOString() } }, "/apps/management"),
    (error) => error.code === "INSTANCE_UNREACHABLE",
  );
  assert.equal(requests, 0);
});

test("instances do not accept proxy traffic while their runtime is not ready", async () => {
  let requests = 0;
  const gateway = new ControlledInstanceGateway({
    requireNode: () => node,
    nodeAgentTransport: () => transportWithRequest(async () => { requests += 1; return new Response("{}"); }),
  });
  await assert.rejects(
    gateway.request({
      ...instance,
      ready: false,
      runtimeVersion: { desiredVersion: "0.0.13", actualVersion: "0.0.11", phase: "installing", attempt: 1 },
    }, "/apps/management"),
    (error) => error.code === "INSTANCE_NOT_READY" && error.statusCode === 409 && error.runtimePhase === "installing",
  );
  assert.equal(requests, 0);
});

test("a ready instance keeps accepting proxy traffic after runtime convergence fails", async () => {
  let requests = 0;
  const gateway = new ControlledInstanceGateway({
    requireNode: () => node,
    nodeAgentTransport: () => transportWithRequest(async () => {
      requests += 1;
      return new Response(JSON.stringify({ data: { ok: true } }), { headers: { "content-type": "application/json" } });
    }),
  });
  const result = await gateway.request({
    ...instance,
    ready: true,
    runtimeVersion: {
      desiredVersion: "0.0.13",
      actualVersion: "0.0.11",
      phase: "failed",
      attempt: 3,
      error: { code: "INSTANCE_RUNTIME_INSTALL_FAILED", message: "install failed", retryable: true },
    },
  }, "/apps/management");
  assert.deepEqual(result, { ok: true });
  assert.equal(requests, 1);
});

test("old controlled-instance responses are reported as unsupported instead of management state", () => {
  assert.throws(
    () => parseInstanceAppManagementSnapshot({ items: [], observedAt: "2026-07-16T00:00:00.000Z" }),
    (error) => error.code === "INSTANCE_APP_MANAGEMENT_UNSUPPORTED" && error.statusCode === 409,
  );
});

test("node-agent forwards authoritative app jobs with the instance id scope", () => {
  class FakeSocket extends EventEmitter {
    constructor() { super(); this.readyState = WebSocket.CONNECTING; this.sent = []; }
    send(value) { this.sent.push(JSON.parse(String(value))); }
    close() {}
  }
  const input = new FakeSocket();
  const outputFrames = [];
  const forwarder = new NodeAgentInstanceEventForwarder({
    listInstances: () => [{ id: "inst_apps", target: { api: "http://127.0.0.1:19000" } }],
  }, undefined, {
    createSocket: () => input,
    setIntervalFn: () => ({ timer: true }),
    clearIntervalFn: () => undefined,
  });
  const output = new EventEmitter();
  output.readyState = WebSocket.OPEN;
  output.send = (value) => outputFrames.push(JSON.parse(String(value)));
  forwarder.addOutput(output);
  input.readyState = WebSocket.OPEN;
  input.emit("open");
  assert.equal(input.sent[0].topics.includes("apps"), true);
  input.emit("message", JSON.stringify({
    v: 1, id: "evt_apps", seq: 7, type: "app.management", topic: "apps", createdAt: "2026-07-16T00:00:00.000Z",
    payload: { type: "app-management", sequence: 4, observedAt: "2026-07-16T00:00:00.000Z", job: { id: "job_apps", appId: "chromium" } },
  }));
  assert.equal(outputFrames[0].type, "node-agent.event.forwarded");
  assert.equal(outputFrames[0].event.scope.instanceId, "inst_apps");
  assert.equal(outputFrames[0].event.payload.job.id, "job_apps");
  assert.equal(eventTopic("app.management"), "apps");
  forwarder.stop();
});

test("node-agent waits for matched runtime convergence before opening instance event streams", () => {
  class FakeSocket extends EventEmitter {
    constructor() { super(); this.readyState = WebSocket.CONNECTING; }
    close() {}
  }
  const instanceState = {
    id: "inst_converging",
    ready: false,
    runtimeVersion: { desiredVersion: "0.0.13", actualVersion: "0.0.11", phase: "restarting", attempt: 1 },
    target: { api: "http://127.0.0.1:19000" },
  };
  const sockets = [];
  const forwarder = new NodeAgentInstanceEventForwarder({ listInstances: () => [instanceState] }, undefined, {
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setIntervalFn: () => ({ timer: true }),
    clearIntervalFn: () => undefined,
  });
  const output = new EventEmitter();
  output.readyState = WebSocket.OPEN;
  output.send = () => undefined;

  forwarder.addOutput(output);
  assert.equal(sockets.length, 0);

  instanceState.ready = true;
  instanceState.runtimeVersion = { ...instanceState.runtimeVersion, actualVersion: "0.0.13", phase: "matched" };
  forwarder.syncNow();
  assert.equal(sockets.length, 1);
  forwarder.stop();
});

test("node-agent app management remains a transport concern", () => {
  const source = fs.readFileSync(path.join(__dirname, "../packages/control-plane/src/node-agent/app.ts"), "utf8");
  assert.match(source, /instances\/:id\/proxy/);
  assert.doesNotMatch(source, /AppManagementManager|createAppRecipeExecutor|selectInstallRecipe/);
});
