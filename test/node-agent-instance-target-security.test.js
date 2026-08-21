const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CONTROL_PLANE_PROTOCOL_VERSION,
  ControlledInstanceHeartbeatSchema,
  ControlledInstanceRegisterSchema,
  ControlledInstanceSchema,
} = require("../packages/protocol/src/control-plane.ts");
const { nodeLocalInstanceWebBase } = require("../packages/control-plane/src/node-agent/instance-target.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");
const { LocalDockerExecutor } = require("../packages/control-plane/src/node-agent/runtimes/docker.ts");
const { NodeAgentState } = require("../packages/control-plane/src/node-agent/state.ts");
const { ControlledInstanceGateway } = require("../packages/control-plane/src/control-plane/instances/gateway.ts");

const timestamp = "2026-08-21T00:00:00.000Z";
const appInventory = { observedAt: timestamp, items: [], issues: [] };

function reportedTarget(web) {
  return { strategy: "direct-port", status: "reachable", web, api: `${web}/api` };
}

function report(target) {
  return {
    protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
    appInventory,
    target,
  };
}

function controlledInstance(overrides = {}) {
  return ControlledInstanceSchema.parse({
    id: "inst_target_security",
    name: "target security",
    source: { type: "local-folder", path: "/workspace" },
    sourceSnapshot: {},
    modelSelection: {},
    nodeId: "node_target_security",
    runtimeId: "runtime_local_host",
    target: { strategy: "direct-port", status: "reachable", web: "http://127.0.0.1:32100", api: "http://127.0.0.1:32100/api" },
    runtime: { kind: "local", port: 32100, labels: {} },
    registrationToken: "instance-secret",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

test("controlled-instance report schemas accept the v0.0.21 legacy target shape", () => {
  for (const target of [
    reportedTarget("http://127.0.0.1:2375"),
    reportedTarget("http://host.docker.internal:8081"),
    reportedTarget("http://169.254.169.254"),
  ]) {
    assert.deepEqual(ControlledInstanceRegisterSchema.parse(report(target)).target, target);
    assert.deepEqual(ControlledInstanceHeartbeatSchema.parse(report(target)).target, target);
  }
});

test("register and heartbeat cannot overwrite the node-owned runtime target", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-target-security-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const state = new NodeAgentState(
    nodeAgentStorePaths(dataDir),
    "node_target_security",
    "http://127.0.0.1:8091",
    "http://host.docker.internal:8091",
    8091,
    "linux",
  );
  state.init();
  state.controlledInstances.put(controlledInstance());

  const registered = state.registerInstance(
    "inst_target_security",
    report(reportedTarget("http://127.0.0.1:2375")),
    "instance-secret",
  );
  assert.equal(registered.target.web, "http://127.0.0.1:32100");
  assert.equal(registered.target.api, "http://127.0.0.1:32100/api");

  const heartbeat = state.heartbeatInstance(
    "inst_target_security",
    report(reportedTarget("http://169.254.169.254")),
    "instance-secret",
  );
  assert.equal(heartbeat.target.web, "http://127.0.0.1:32100");
  assert.equal(heartbeat.target.api, "http://127.0.0.1:32100/api");
});

test("node-agent endpoint validation ignores stored targets", () => {
  assert.equal(nodeLocalInstanceWebBase(controlledInstance()), "http://127.0.0.1:32100");
  assert.equal(nodeLocalInstanceWebBase(controlledInstance({
    target: reportedTarget("http://169.254.169.254"),
  })), "http://127.0.0.1:32100", "local runtime port is authoritative over a poisoned stored target");

  for (const web of ["http://host.docker.internal:8081", "http://169.254.169.254"]) {
    const docker = controlledInstance({
      runtime: { kind: "docker", containerName: "task-handoff-inst_target_security", labels: {} },
      target: reportedTarget(web),
    });
    assert.throws(() => nodeLocalInstanceWebBase(docker), (error) => error.code === "NODE_INSTANCE_WEB_ENDPOINT_MISSING");
  }
});

test("Docker endpoint resolution uses the owned container mapping instead of stored target", async () => {
  const calls = [];
  const executor = new LocalDockerExecutor(async (_command, args) => {
    calls.push(args);
    if (args[0] === "inspect" && args[2] === "{{.Id}}") return { stdout: "container-owned\n", stderr: "" };
    if (args[0] === "port") return { stdout: "127.0.0.1:32100\n", stderr: "" };
    throw new Error(`Unexpected docker command: ${args.join(" ")}`);
  }, { portResolutionRetryDelaysMs: [0] });
  const instance = controlledInstance({
    runtime: { kind: "docker", containerName: "task-handoff-inst_target_security", containerId: "container-owned", labels: {} },
    target: reportedTarget("http://127.0.0.1:2375"),
  });

  const web = await executor.resolveInstanceWeb({ instance });

  assert.equal(web, "http://127.0.0.1:32100");
  assert.deepEqual(calls, [
    ["inspect", "--format", "{{.Id}}", "task-handoff-inst_target_security"],
    ["port", "task-handoff-inst_target_security", "8080/tcp"],
  ]);
});

test("control plane routes through node transport and never dereferences a node-reported target", async () => {
  const calls = [];
  const gateway = new ControlledInstanceGateway({
    requireNode: (nodeId) => ({ id: nodeId }),
    nodeAgentTransport: () => ({
      request: async (node, route, init) => {
        calls.push({ node, route, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  });
  const instance = controlledInstance({
    ready: true,
    connectionStatus: "online",
    agentStatus: "online",
    runtime: { kind: "docker", containerName: "task-handoff-inst_target_security", labels: {} },
    target: reportedTarget("http://169.254.169.254"),
  });

  assert.deepEqual(await gateway.request(instance, "/status"), { ok: true });
  assert.deepEqual(calls, [{
    node: { id: "node_target_security" },
    route: "/instances/inst_target_security/proxy",
    body: { path: "/api/status", method: "GET", headers: {} },
  }]);
});
