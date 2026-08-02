const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { NodeAgentExternalListenerManager } = require("../packages/control-plane/src/node-agent/external-listener-manager.ts");
const { NodeAgentRecoverySupervisor } = require("../packages/control-plane/src/node-agent/recovery-supervisor.ts");

test("recovery shutdown waits for the active cycle and prevents later restores", async () => {
  const instances = [
    { id: "inst_first", runtimeId: "runtime_docker", status: "running", target: { status: "unknown" } },
    { id: "inst_second", runtimeId: "runtime_docker", status: "running", target: { status: "unknown" } },
  ];
  let releaseRestore;
  const restoreGate = new Promise((resolve) => { releaseRestore = resolve; });
  const restoreCalls = [];
  let autoImports = 0;
  let stopAllCalls = 0;
  let cancelCalls = 0;
  let imageProvisioningStops = 0;
  const supervisor = new NodeAgentRecoverySupervisor({
    state: {
      listInstances: () => instances,
      requireRuntime: () => ({ type: "docker" }),
      requireInstance: (id) => instances.find((instance) => instance.id === id),
      applyInstanceLifecycle: () => undefined,
      controlledInstances: { put: () => undefined },
    },
    runtimeAdapters: {
      stopAll: async () => { stopAllCalls += 1; },
    },
    convergence: {
      isRunning: () => false,
      cancel: async () => { cancelCalls += 1; },
      schedule: async () => undefined,
    },
    restoreInstance: async (id) => {
      restoreCalls.push(id);
      await restoreGate;
    },
    autoImport: async () => { autoImports += 1; },
    provisionImage: () => undefined,
    stopImageProvisioning: async () => { imageProvisioningStops += 1; },
    usesManagedArtifact: () => false,
    warn: () => undefined,
    error: () => undefined,
    intervalMs: 60_000,
  });

  supervisor.start();
  await new Promise((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = supervisor.stop().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(stopAllCalls, 0);
  assert.equal(imageProvisioningStops, 1);

  releaseRestore();
  await stopping;
  assert.deepEqual(restoreCalls, ["inst_first"]);
  assert.equal(autoImports, 0);
  assert.equal(cancelCalls, 2);
  assert.equal(stopAllCalls, 1);
});

test("external listener updates execute serially", async () => {
  const server = new EventEmitter();
  const events = [];
  const persistedPorts = [];
  let releaseFirstListen;
  const firstListenGate = new Promise((resolve) => { releaseFirstListen = resolve; });
  const manager = new NodeAgentExternalListenerManager({
    app: { server, log: { error: () => undefined } },
    state: { runningInstanceCount: () => 0, setListenerPort: () => undefined },
    settings: { put: (settings) => persistedPorts.push(settings.externalListener.port) },
    config: { bindScope: "loopback", port: 18091 },
    source: "bootstrap",
  });
  manager.stop = async () => { events.push("stop"); };
  manager.listen = async (config) => {
    events.push(`listen:${config.port}`);
    if (config.port === 18092) await firstListenGate;
  };

  const first = manager.update({ bindScope: "loopback", port: 18092 });
  await new Promise((resolve) => setImmediate(resolve));
  const second = manager.update({ bindScope: "loopback", port: 18093 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["stop", "listen:18092"]);

  releaseFirstListen();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["stop", "listen:18092", "stop", "listen:18093"]);
  assert.deepEqual(persistedPorts, [18092, 18093]);
  assert.equal(manager.current().port, 18093);
});
