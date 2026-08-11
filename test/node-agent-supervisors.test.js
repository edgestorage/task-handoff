const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const net = require("node:net");
const test = require("node:test");

const { allocateNodeAgentExternalListener, NodeAgentExternalListenerManager } = require("../packages/control-plane/src/node-agent/external-listener-manager.ts");
const { NodeAgentRecoverySupervisor } = require("../packages/control-plane/src/node-agent/recovery-supervisor.ts");
const {
  DEFAULT_LOCAL_PROCESS_READY_TIMEOUT_MS,
  LocalProcessSupervisor,
  localProcessReadyTimeoutMs,
} = require("../packages/control-plane/src/node-agent/runtimes/local-process-supervisor.ts");
const { InstanceOperationGate } = require("../packages/control-plane/src/node-agent/instances/instance-operation-gate.ts");
const { RuntimeAdapterRegistry } = require("../packages/control-plane/src/node-agent/runtimes/adapters.ts");

test("node-agent global shutdown stops only the Local Runtime adapter", async () => {
  const calls = [];
  const registry = new RuntimeAdapterRegistry(
    { stopAll: async () => calls.push("docker") },
    { stopAll: async () => calls.push("local") },
  );
  await registry.stopAll();
  assert.deepEqual(calls, ["local"]);
});

test("local process readiness timeout is production-safe and configurable", () => {
  assert.equal(localProcessReadyTimeoutMs(undefined), DEFAULT_LOCAL_PROCESS_READY_TIMEOUT_MS);
  assert.equal(localProcessReadyTimeoutMs("45000"), 45_000);
  assert.equal(localProcessReadyTimeoutMs("0"), DEFAULT_LOCAL_PROCESS_READY_TIMEOUT_MS);
  assert.equal(localProcessReadyTimeoutMs("invalid"), DEFAULT_LOCAL_PROCESS_READY_TIMEOUT_MS);
});

test("local recovery retries a transient failed state after bounded backoff", async () => {
  let clock = 1_000;
  const instance = { id: "inst_local", runtimeId: "runtime_local", status: "running", target: { status: "unknown" } };
  let restores = 0;
  const warnings = [];
  const supervisor = new NodeAgentRecoverySupervisor({
    state: {
      listInstances: () => [instance],
      requireRuntime: () => ({ type: "local" }),
      requireInstance: () => instance,
      applyInstanceLifecycle: (_id, event) => {
        if (event.type === "start-failed" || event.type === "runtime-exited") instance.status = "failed";
      },
    },
    runtimeAdapters: { stopAll: async () => undefined },
    convergence: { isRunning: () => false, cancel: async () => undefined, schedule: async () => undefined },
    restoreInstance: async () => {
      restores += 1;
      if (restores === 1) throw new Error("temporary startup failure");
    },
    autoImport: async () => undefined,
    provisionImage: () => undefined,
    stopImageProvisioning: async () => undefined,
    usesManagedArtifact: () => false,
    warn: (data) => warnings.push(data),
    error: () => undefined,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 100,
    nowMs: () => clock,
  });

  await supervisor.restoreManagedInstances();
  assert.equal(instance.status, "failed");
  assert.equal(restores, 1);
  assert.equal(warnings[0].attempt, 1);
  await supervisor.restoreManagedInstances();
  assert.equal(restores, 1);
  clock += 100;
  await supervisor.restoreManagedInstances();
  assert.equal(restores, 2);

  supervisor.handleUnexpectedLocalExit("inst_local", new Error("process exited"));
  assert.equal(instance.status, "failed");
  await supervisor.restoreManagedInstances();
  assert.equal(restores, 3);
});

test("an unexpected local exit wakes the supervisor and restores without waiting for the safety interval", async () => {
  const instance = { id: "inst_local_crash", runtimeId: "runtime_local", status: "running", target: { status: "online" } };
  let restores = 0;
  const supervisor = new NodeAgentRecoverySupervisor({
    state: {
      listInstances: () => [instance],
      requireRuntime: () => ({ type: "local" }),
      requireInstance: () => instance,
      applyInstanceLifecycle: (_id, event) => {
        if (event.type === "runtime-exited") instance.status = "failed";
      },
      controlledInstances: { put: () => undefined },
    },
    runtimeAdapters: { stopAll: async () => undefined },
    convergence: { isRunning: () => false, cancel: async () => undefined, schedule: async () => undefined },
    restoreInstance: async () => { restores += 1; },
    autoImport: async () => undefined,
    provisionImage: () => undefined,
    stopImageProvisioning: async () => undefined,
    usesManagedArtifact: () => false,
    warn: () => undefined,
    error: () => undefined,
    intervalMs: 60_000,
  });
  supervisor.markRestored(instance.id);
  supervisor.start();
  await new Promise((resolve) => setImmediate(resolve));

  supervisor.handleUnexpectedLocalExit(instance.id, new Error("child exited"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(restores, 1);
});

test("rapid successful local restarts still back off repeated crashes", async () => {
  let clock = 5_000;
  const instance = { id: "inst_crash_loop", runtimeId: "runtime_local", status: "running", target: { status: "online" } };
  let restores = 0;
  const supervisor = new NodeAgentRecoverySupervisor({
    state: {
      listInstances: () => [instance],
      requireRuntime: () => ({ type: "local" }),
      requireInstance: () => instance,
      applyInstanceLifecycle: (_id, event) => {
        if (event.type === "runtime-exited") instance.status = "failed";
      },
    },
    runtimeAdapters: { stopAll: async () => undefined },
    convergence: { isRunning: () => false, cancel: async () => undefined, schedule: async () => undefined },
    restoreInstance: async () => { restores += 1; instance.status = "running"; },
    autoImport: async () => undefined,
    provisionImage: () => undefined,
    stopImageProvisioning: async () => undefined,
    usesManagedArtifact: () => false,
    warn: () => undefined,
    error: () => undefined,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 100,
    crashStableWindowMs: 1_000,
    nowMs: () => clock,
  });

  supervisor.markRestored(instance.id);
  supervisor.handleUnexpectedLocalExit(instance.id, new Error("first crash"));
  await supervisor.restoreManagedInstances();
  assert.equal(restores, 1);

  supervisor.handleUnexpectedLocalExit(instance.id, new Error("second crash"));
  await supervisor.restoreManagedInstances();
  assert.equal(restores, 1);
  clock += 100;
  await supervisor.restoreManagedInstances();
  assert.equal(restores, 2);
});

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.killed = true;
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  return child;
}

test("local process supervisor reports only unexpected exits after readiness", async () => {
  const exits = [];
  const supervisor = new LocalProcessSupervisor(undefined, (event) => exits.push(event));
  const crashed = fakeChild(101);
  supervisor.track("inst_crashed", crashed);
  supervisor.markReady("inst_crashed", crashed);
  crashed.emit("exit", 17, null);
  assert.deepEqual(exits, [{ instanceId: "inst_crashed", pid: 101, code: 17, signal: null }]);

  const stopped = fakeChild(102);
  const shutdownStages = [];
  supervisor.track("inst_stopped", stopped, (event) => shutdownStages.push(event.stage));
  supervisor.markReady("inst_stopped", stopped);
  await supervisor.stop({ id: "inst_stopped" });
  assert.equal(exits.length, 1);
  assert.deepEqual(shutdownStages, ["graceful-signal-sent"]);

  const failedStartup = fakeChild(103);
  supervisor.track("inst_starting", failedStartup);
  failedStartup.emit("exit", 1, null);
  assert.equal(exits.length, 1);

  const exitedBeforeReadyCommit = fakeChild(104);
  supervisor.track("inst_ready_race", exitedBeforeReadyCommit);
  exitedBeforeReadyCommit.exitCode = 9;
  assert.equal(supervisor.markReady("inst_ready_race", exitedBeforeReadyCommit), false);
  assert.equal(exits.length, 1);
});

test("local process exit callback failures are isolated and diagnosed best effort", () => {
  const diagnostics = [];
  const supervisor = new LocalProcessSupervisor(
    undefined,
    () => { throw new Error("recovery callback failed"); },
    (error, event) => diagnostics.push({ error: error.message, instanceId: event.instanceId }),
  );
  const child = fakeChild(105);
  supervisor.track("inst_exit_callback", child);
  supervisor.markReady("inst_exit_callback", child);
  assert.doesNotThrow(() => child.emit("exit", 1, null));
  assert.deepEqual(diagnostics, [{ error: "recovery callback failed", instanceId: "inst_exit_callback" }]);

  const diagnosticFailure = new LocalProcessSupervisor(undefined, () => { throw new Error("recovery failed"); }, () => { throw new Error("logging failed"); });
  const second = fakeChild(106);
  diagnosticFailure.track("inst_exit_diagnostic", second);
  diagnosticFailure.markReady("inst_exit_diagnostic", second);
  assert.doesNotThrow(() => second.emit("exit", 1, null));
});

test("explicit stop intent waits for an active restore and suppresses exit recovery", async () => {
  const instance = { id: "inst_stop_race", runtimeId: "runtime_local", status: "running", target: { status: "unknown" } };
  let releaseRestore;
  const restoreGate = new Promise((resolve) => { releaseRestore = resolve; });
  let restores = 0;
  let lifecycleEvents = 0;
  const supervisor = new NodeAgentRecoverySupervisor({
    state: {
      listInstances: () => [instance],
      requireRuntime: () => ({ type: "local" }),
      requireInstance: () => instance,
      applyInstanceLifecycle: () => { lifecycleEvents += 1; },
    },
    runtimeAdapters: { stopAll: async () => undefined },
    convergence: { isRunning: () => false, cancel: async () => undefined, schedule: async () => undefined },
    restoreInstance: async () => {
      restores += 1;
      await restoreGate;
      if (restores === 1) throw new Error("restore lost race with stop");
    },
    autoImport: async () => undefined,
    provisionImage: () => undefined,
    stopImageProvisioning: async () => undefined,
    usesManagedArtifact: () => false,
    warn: () => undefined,
    error: () => undefined,
  });

  const restoring = supervisor.restoreManagedInstances();
  await new Promise((resolve) => setImmediate(resolve));
  let suppressionCompleted = false;
  const suppressing = supervisor.suppressRecovery(instance.id).then(() => { suppressionCompleted = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(suppressionCompleted, false);
  supervisor.handleUnexpectedLocalExit(instance.id, new Error("exit during stop"));
  assert.equal(lifecycleEvents, 0);

  releaseRestore();
  await Promise.all([restoring, suppressing]);
  await supervisor.restoreManagedInstances();
  assert.equal(restores, 1);
  supervisor.allowRecovery(instance.id);
  const retry = supervisor.restoreManagedInstances();
  await retry;
  assert.equal(restores, 2);
});

test("suppressed unexpected exit is replayed on failure and discarded on successful stop", async () => {
  const instance = { id: "inst_pending_exit", runtimeId: "runtime_local", status: "running", target: { status: "unknown" } };
  const events = [];
  const supervisor = new NodeAgentRecoverySupervisor({
    state: {
      listInstances: () => [instance],
      requireRuntime: () => ({ type: "local" }),
      requireInstance: () => instance,
      applyInstanceLifecycle: (_id, event) => { events.push(event.type); if (event.type === "runtime-exited") instance.status = "failed"; },
    },
    runtimeAdapters: { stopAll: async () => undefined },
    convergence: { isRunning: () => false, cancel: async () => undefined, schedule: async () => undefined },
    restoreInstance: async () => undefined,
    autoImport: async () => undefined,
    provisionImage: () => undefined,
    stopImageProvisioning: async () => undefined,
    usesManagedArtifact: () => false,
    warn: () => undefined,
    error: () => undefined,
  });

  supervisor.markRestored(instance.id);
  await supervisor.suppressRecovery(instance.id);
  supervisor.handleUnexpectedLocalExit(instance.id, new Error("crashed during failed stop"));
  assert.deepEqual(events, []);
  supervisor.allowRecovery(instance.id);
  assert.deepEqual(events, ["runtime-exited"]);

  instance.status = "running";
  supervisor.markRestored(instance.id);
  await supervisor.suppressRecovery(instance.id);
  supervisor.handleUnexpectedLocalExit(instance.id, new Error("exited during successful stop"));
  supervisor.completeSuppressedOperation(instance.id);
  supervisor.allowRecovery(instance.id);
  assert.deepEqual(events, ["runtime-exited"]);
});

test("replayed exit recovery cannot race a queued explicit start", async () => {
  const instance = { id: "inst_replay_start", runtimeId: "runtime_local", status: "running", target: { status: "unknown" } };
  const operations = new InstanceOperationGate();
  let restores = 0;
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  let startEntered;
  const startEnteredGate = new Promise((resolve) => { startEntered = resolve; });
  const supervisor = new NodeAgentRecoverySupervisor({
    state: {
      listInstances: () => [instance],
      requireRuntime: () => ({ type: "local" }),
      requireInstance: () => instance,
      applyInstanceLifecycle: (_id, event) => { if (event.type === "runtime-exited") instance.status = "failed"; },
    },
    runtimeAdapters: { stopAll: async () => undefined },
    convergence: { isRunning: () => false, cancel: async () => undefined, schedule: async () => undefined },
    restoreInstance: async () => { restores += 1; },
    autoImport: async () => undefined,
    provisionImage: () => undefined,
    stopImageProvisioning: async () => undefined,
    usesManagedArtifact: () => false,
    warn: () => undefined,
    error: () => undefined,
    runInstanceOperation: (id, operation) => operations.run(id, operation),
  });

  supervisor.markRestored(instance.id);
  await supervisor.suppressRecovery(instance.id);
  supervisor.handleUnexpectedLocalExit(instance.id, new Error("exit during failed stop"));
  const explicitStart = operations.run(instance.id, async () => {
    supervisor.allowRecovery(instance.id);
    instance.status = "starting";
    startEntered();
    await startGate;
    instance.status = "running";
    supervisor.markRestored(instance.id);
  });
  await startEnteredGate;
  const recovery = supervisor.restoreManagedInstances();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restores, 0);
  releaseStart();
  await Promise.all([explicitStart, recovery]);
  assert.equal(restores, 0);
});

test("successful stop clears the previous restored generation for later retry", async () => {
  const instance = { id: "inst_stop_then_failed_start", runtimeId: "runtime_local", status: "running", target: { status: "unknown" } };
  let restores = 0;
  const supervisor = new NodeAgentRecoverySupervisor({
    state: {
      listInstances: () => [instance],
      requireRuntime: () => ({ type: "local" }),
      requireInstance: () => instance,
      applyInstanceLifecycle: () => undefined,
      controlledInstances: { put: () => undefined },
    },
    runtimeAdapters: { stopAll: async () => undefined },
    convergence: { isRunning: () => false, cancel: async () => undefined, schedule: async () => undefined },
    restoreInstance: async () => { restores += 1; },
    autoImport: async () => undefined,
    provisionImage: () => undefined,
    stopImageProvisioning: async () => undefined,
    usesManagedArtifact: () => false,
    warn: () => undefined,
    error: () => undefined,
  });

  supervisor.markRestored(instance.id);
  await supervisor.suppressRecovery(instance.id);
  supervisor.completeSuppressedOperation(instance.id);
  supervisor.allowRecovery(instance.id);
  instance.status = "failed";
  await supervisor.restoreManagedInstances();
  assert.equal(restores, 1);
});

test("shutdown drops a recovery operation already queued behind the instance gate", async () => {
  const instance = { id: "inst_queued_shutdown", runtimeId: "runtime_docker", status: "running", target: { status: "unknown" } };
  const operations = new InstanceOperationGate();
  let releaseGate;
  const heldGate = new Promise((resolve) => { releaseGate = resolve; });
  let restores = 0;
  const supervisor = new NodeAgentRecoverySupervisor({
    state: {
      listInstances: () => [instance],
      requireRuntime: () => ({ type: "docker" }),
      requireInstance: () => instance,
      applyInstanceLifecycle: () => undefined,
      controlledInstances: { put: () => undefined },
    },
    runtimeAdapters: { stopAll: async () => undefined },
    convergence: { isRunning: () => false, cancel: async () => undefined, schedule: async () => undefined },
    restoreInstance: async () => { restores += 1; },
    autoImport: async () => undefined,
    provisionImage: () => undefined,
    stopImageProvisioning: async () => undefined,
    usesManagedArtifact: () => false,
    warn: () => undefined,
    error: () => undefined,
    runInstanceOperation: (id, operation) => operations.run(id, operation),
  });

  const holding = operations.run(instance.id, async () => heldGate);
  const recovery = supervisor.restoreManagedInstances();
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = supervisor.stop();
  releaseGate();
  await Promise.all([holding, recovery, stopping]);
  assert.equal(restores, 0);
});

test("a blocked instance gate does not head-of-line block recovery for another instance", async () => {
  const instances = [
    { id: "inst_blocked_a", runtimeId: "runtime_local", status: "running", target: { status: "unknown" } },
    { id: "inst_ready_b", runtimeId: "runtime_local", status: "running", target: { status: "unknown" } },
  ];
  const operations = new InstanceOperationGate();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const restores = [];
  const supervisor = new NodeAgentRecoverySupervisor({
    state: {
      listInstances: () => instances,
      requireRuntime: () => ({ type: "local" }),
      requireInstance: (id) => instances.find((instance) => instance.id === id),
      applyInstanceLifecycle: () => undefined,
    },
    runtimeAdapters: { stopAll: async () => undefined },
    convergence: { isRunning: () => false, cancel: async () => undefined, schedule: async () => undefined },
    restoreInstance: async (id) => { restores.push(id); },
    autoImport: async () => undefined,
    provisionImage: () => undefined,
    stopImageProvisioning: async () => undefined,
    usesManagedArtifact: () => false,
    warn: () => undefined,
    error: () => undefined,
    runInstanceOperation: (id, operation) => operations.run(id, operation),
  });

  const holding = operations.run(instances[0].id, async () => firstGate);
  const recovery = supervisor.restoreManagedInstances();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(restores, [instances[1].id]);
  releaseFirst();
  await Promise.all([holding, recovery]);
  assert.deepEqual(restores, [instances[1].id, instances[0].id]);
});

test("forgetting a deleted instance clears recovery suppression, backoff, and restored state", async () => {
  const instance = { id: "inst_recreated", runtimeId: "runtime_local", status: "running", target: { status: "unknown" } };
  let restores = 0;
  const supervisor = new NodeAgentRecoverySupervisor({
    state: {
      listInstances: () => [instance],
      requireRuntime: () => ({ type: "local" }),
      requireInstance: () => instance,
      applyInstanceLifecycle: (_id, event) => { if (event.type === "start-failed") instance.status = "failed"; },
    },
    runtimeAdapters: { stopAll: async () => undefined },
    convergence: { isRunning: () => false, cancel: async () => undefined, schedule: async () => undefined },
    restoreInstance: async () => { restores += 1; if (restores === 1) throw new Error("first restore failed"); },
    autoImport: async () => undefined,
    provisionImage: () => undefined,
    stopImageProvisioning: async () => undefined,
    usesManagedArtifact: () => false,
    warn: () => undefined,
    error: () => undefined,
    retryBaseDelayMs: 60_000,
  });

  await supervisor.restoreManagedInstances();
  await supervisor.suppressRecovery(instance.id);
  supervisor.forgetInstance(instance.id);
  await supervisor.restoreManagedInstances();
  assert.equal(restores, 2);

  instance.status = "running";
  supervisor.markRestored(instance.id);
  supervisor.forgetInstance(instance.id);
  await supervisor.restoreManagedInstances();
  assert.equal(restores, 3);
});

test("exit during post-start auto import invalidates the old restore continuation", async () => {
  const instance = { id: "inst_exit_auto_import", runtimeId: "runtime_local", status: "running", target: { status: "unknown" } };
  let restoreCalls = 0;
  let releaseImport;
  const importGate = new Promise((resolve) => { releaseImport = resolve; });
  let importStarted;
  const importStartedGate = new Promise((resolve) => { importStarted = resolve; });
  const supervisor = new NodeAgentRecoverySupervisor({
    state: {
      listInstances: () => [instance],
      requireRuntime: () => ({ type: "local" }),
      requireInstance: () => instance,
      applyInstanceLifecycle: (_id, event) => {
        if (event.type === "runtime-exited") instance.status = "failed";
      },
    },
    runtimeAdapters: { stopAll: async () => undefined },
    convergence: { isRunning: () => false, cancel: async () => undefined, schedule: async () => undefined },
    restoreInstance: async () => { restoreCalls += 1; },
    autoImport: async () => {
      importStarted();
      await importGate;
    },
    provisionImage: () => undefined,
    stopImageProvisioning: async () => undefined,
    usesManagedArtifact: () => false,
    warn: () => undefined,
    error: () => undefined,
  });

  const firstRestore = supervisor.restoreManagedInstances();
  await importStartedGate;
  supervisor.handleUnexpectedLocalExit(instance.id, new Error("child exited during import"));
  releaseImport();
  await firstRestore;
  await supervisor.restoreManagedInstances();
  assert.equal(restoreCalls, 2);
});

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
  assert.deepEqual(restoreCalls, ["inst_first", "inst_second"]);
  assert.equal(autoImports, 0);
  assert.equal(cancelCalls, 2);
  assert.equal(stopAllCalls, 1);
});

test("external listener updates execute serially", async () => {
  const server = new EventEmitter();
  const events = [];
  const persistedPorts = [];
  const publishedPorts = [];
  let releaseFirstListen;
  const firstListenGate = new Promise((resolve) => { releaseFirstListen = resolve; });
  const manager = new NodeAgentExternalListenerManager({
    app: { server, log: { error: () => undefined } },
    state: { runningInstanceCount: () => 0, setListenerPort: () => undefined },
    settings: { put: (settings) => persistedPorts.push(settings.externalListener.port) },
    config: { bindScope: "loopback", port: 18091 },
    source: "bootstrap",
    onActiveListener: (listener) => publishedPorts.push(listener.port),
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
  assert.deepEqual(publishedPorts, [18092, 18093]);
  assert.equal(manager.current().port, 18093);
});

test("desktop node-agent listener allocation skips an occupied preferred port", async (t) => {
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => occupied.close());
  const address = occupied.address();
  assert.equal(typeof address, "object");

  const allocated = await allocateNodeAgentExternalListener({ bindScope: "loopback", port: address.port }, 2);
  assert.equal(allocated.bindScope, "loopback");
  assert.equal(allocated.port, address.port + 1);
});
