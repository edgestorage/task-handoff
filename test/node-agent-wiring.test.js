const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const Fastify = require("fastify");

const { registerInstanceLifecycleRoutes } = require("../packages/control-plane/src/node-agent/instances/lifecycle-routes.ts");
const { InstanceOperationGate } = require("../packages/control-plane/src/node-agent/instances/instance-operation-gate.ts");
const { LocalhostRuntimeAdapter } = require("../packages/control-plane/src/node-agent/runtimes/local-adapter.ts");
const { ControlledInstanceSchema } = require("../packages/protocol/src/control-plane.ts");
const { EventEmitter } = require("node:events");

test("node-agent app wires local runtime exits into immediate recovery", () => {
  const filename = path.join(__dirname, "../packages/control-plane/src/node-agent/app.ts");
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const adapters = [];
  const visit = (node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "LocalhostRuntimeAdapter") {
      adapters.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  assert.equal(adapters.length, 1);
  const exitHandler = adapters[0].arguments?.[5];
  assert.ok(exitHandler && ts.isArrowFunction(exitHandler), "LocalhostRuntimeAdapter must receive an unexpected-exit callback");
  let recoveryCall;
  const findRecoveryCall = (node) => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "recoverySupervisor"
      && node.expression.name.text === "handleUnexpectedLocalExit"
    ) {
      recoveryCall = node;
    }
    ts.forEachChild(node, findRecoveryCall);
  };
  findRecoveryCall(exitHandler);

  assert.ok(recoveryCall, "unexpected local exits must be forwarded to recoverySupervisor.handleUnexpectedLocalExit");
  assert.equal(recoveryCall.arguments[0]?.getText(source), "event.instanceId");
});

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test("localhost adapter forwards supervised process exits to its recovery callback", () => {
  const exits = [];
  const adapter = new LocalhostRuntimeAdapter(
    async () => ({ stdout: "", stderr: "" }),
    { dataDir: os.tmpdir() },
    () => "http://127.0.0.1:8091",
    undefined,
    undefined,
    (event) => exits.push(event),
  );
  const child = fakeChild(701);

  adapter.processSupervisor.track("inst_adapter_exit", child);
  assert.equal(adapter.processSupervisor.markReady("inst_adapter_exit", child), true);
  child.exitCode = 17;
  child.emit("exit", 17, null);

  assert.deepEqual(exits, [{ instanceId: "inst_adapter_exit", pid: 701, code: 17, signal: null }]);
});

test("localhost adapter rejects startup when readiness cannot be committed", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-adapter-ready-commit-"));
  const adapter = new LocalhostRuntimeAdapter(
    async () => ({ stdout: "", stderr: "" }),
    { dataDir },
    () => "http://127.0.0.1:8091",
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
  );
  t.after(() => adapter.processSupervisor.stopAll());
  adapter.processSupervisor.stop = async () => undefined;
  adapter.processSupervisor.track = () => undefined;
  adapter.processSupervisor.waitUntilHealthy = async () => true;
  adapter.processSupervisor.markReady = () => false;
  adapter.processSupervisor.release = () => undefined;

  await assert.rejects(adapter.start({
    instance: {
      id: "inst_ready_commit",
      name: "ready commit",
      registrationToken: "registration-token",
      source: { type: "local-folder", path: dataDir },
      runtime: { kind: "local", labels: {}, port: 32123 },
    },
    project: { id: "project_ready_commit" },
    node: { id: "node_ready_commit" },
    runtime: { id: "runtime_ready_commit" },
    modelEnv: {},
  }), (error) => error.code === "LOCAL_INSTANCE_PROCESS_NOT_READY");
});

function lifecycleRouteHarness(options = {}) {
  const calls = [];
  const lifecycleEvents = [];
  const baselineInstance = ControlledInstanceSchema.parse({
    id: "inst_routes",
    name: "routes",
    source: { type: "local-folder", path: "/workspace" },
    sourceSnapshot: {},
    modelSelection: {},
    nodeId: "node_routes",
    runtimeId: "runtime_local",
    runtime: { kind: "local", labels: {} },
    status: "running",
    health: "ok",
    connectionStatus: "online",
    agentStatus: "online",
    targetStatus: "reachable",
    uiAccessStatus: "reachable",
    controlMode: "controlled",
    ready: false,
    capabilities: {},
    config: {},
    workspace: { status: "ready", path: "/workspace" },
    target: { strategy: "node-proxy", status: "reachable" },
    apps: { runningCount: 0, problemCount: 0 },
    aiSessions: { runningCount: 0, waitingCount: 0, sessions: [], updatedAt: "2026-08-02T00:00:00.000Z" },
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  });
  let instance = baselineInstance;
  const app = Fastify({ logger: false });
  const state = {
    requireInstance: () => instance,
    requireRuntime: () => ({ id: "runtime_local", type: "local" }),
    putInstance: (value) => value,
    deleteInstance: () => true,
    applyLifecycle: (_id, event) => {
      lifecycleEvents.push(event);
      calls.push(`lifecycle:${event.type}`);
      if (event.type === "stop-requested") instance = { ...instance, status: "stopping" };
      if (event.type === "stop-failed") instance = event.baseline;
      if (event.type === "runtime-lifecycle-completed") {
        instance = {
          ...instance,
          ...event.observation,
          runtime: event.observation.runtime ? { ...instance.runtime, ...event.observation.runtime } : instance.runtime,
          target: event.observation.target ? { ...instance.target, ...event.observation.target } : instance.target,
        };
      }
      return instance;
    },
    context: (target) => ({ instance: target }),
  };
  const adapter = {
    stop: async (context) => {
      calls.push("adapter:stop");
      options.stopInstanceObserved?.(context.instance);
      await options.stopGate;
      if (options.failStop) throw new Error("stop failed");
    },
    delete: async (context) => {
      calls.push("adapter:delete");
      options.deleteInstanceObserved?.(context.instance);
      await options.deleteGate;
      if (options.failDelete) throw new Error("delete failed");
    },
    restart: async () => {
      calls.push("adapter:restart");
      options.restartEntered?.();
      await options.restartGate;
      if (options.failRestart) throw new Error("restart failed");
      return options.restartResult || {};
    },
  };
  const convergence = {
    cancel: async () => {
      calls.push("convergence:cancel");
      options.onCancel?.();
      await options.cancelGate;
      if (options.failCancel) throw new Error("cancel failed");
    },
    schedule: async () => {
      calls.push("convergence:schedule");
      options.scheduleEntered?.();
      await options.scheduleGate;
      return instance;
    },
  };
  const hooks = {
    start: async (_id, shouldContinue) => {
      calls.push("hook:start");
      options.startEntered?.();
      await options.startGate;
      options.startContinuationObserved?.(shouldContinue?.());
      if (options.failStart) throw new Error("start failed");
      return instance;
    },
    sync: () => { calls.push("hook:sync"); },
    isManaged: () => options.isManaged !== false,
    probe: async () => "unknown",
    autoImport: async () => undefined,
    markRestarted: () => undefined,
    allowRecovery: () => { calls.push("recovery:allow"); },
    suppressRecovery: async () => { calls.push("recovery:suppress"); },
    forgetRecovery: () => { calls.push("recovery:forget"); },
    completeSuppressedRecovery: () => { calls.push("recovery:complete-suppressed"); },
    deleteMetadata: () => { calls.push("metadata:delete"); },
    diagnostic: () => undefined,
  };
  const operationGate = new InstanceOperationGate();
  const operations = {
    run: (id, operation) => {
      options.operationEnqueued?.();
      return operationGate.run(id, operation);
    },
    intent: (id) => operationGate.intent(id),
    invalidate: (id) => operationGate.invalidate(id),
    isIntentCurrent: (id, intent) => operationGate.isIntentCurrent(id, intent),
    clearIntent: (id) => operationGate.clearIntent(id),
  };
  registerInstanceLifecycleRoutes(app, state, { forRuntime: () => adapter }, convergence, hooks, operations);
  return {
    app,
    calls,
    lifecycleEvents,
    baselineInstance,
    replaceInstance: (next) => { instance = ControlledInstanceSchema.parse(next); },
  };
}

test("instance lifecycle routes order recovery suppression and allowance around runtime actions", async (t) => {
  for (const entry of [
    {
      method: "POST",
      url: "/api/node-agent/instances/inst_routes/stop",
      expected: ["convergence:cancel", "lifecycle:stop-requested", "recovery:suppress", "adapter:stop", "lifecycle:stop-completed", "recovery:complete-suppressed", "hook:sync"],
    },
    {
      method: "POST",
      url: "/api/node-agent/instances/inst_routes/delete",
      expected: ["convergence:cancel", "lifecycle:stop-requested", "recovery:suppress", "adapter:delete", "recovery:forget", "metadata:delete", "hook:sync"],
    },
    {
      method: "POST",
      url: "/api/node-agent/instances/inst_routes/start",
      payload: {},
      expected: ["recovery:allow", "hook:start"],
    },
    {
      method: "POST",
      url: "/api/node-agent/instances/inst_routes/restart",
      payload: {},
      expected: ["recovery:allow", "convergence:schedule", "hook:sync"],
    },
  ]) {
    await t.test(entry.url.split("/").at(-1), async () => {
      const { app, calls } = lifecycleRouteHarness();
      try {
        const response = await app.inject(entry);
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(calls, entry.expected);
      } finally {
        await app.close();
      }
    });
  }
});

test("failed stop and delete compensate lifecycle state before allowing recovery", async (t) => {
  for (const entry of [
    { action: "stop", option: "failStop", adapterCall: "adapter:stop" },
    { action: "delete", option: "failDelete", adapterCall: "adapter:delete" },
  ]) {
    await t.test(entry.action, async () => {
      const { app, calls, lifecycleEvents, baselineInstance } = lifecycleRouteHarness({ [entry.option]: true });
      try {
        const response = await app.inject({ method: "POST", url: `/api/node-agent/instances/inst_routes/${entry.action}` });
        assert.equal(response.statusCode, 500);
        assert.deepEqual(calls, [
          "convergence:cancel",
          "lifecycle:stop-requested",
          "recovery:suppress",
          entry.adapterCall,
          "lifecycle:stop-failed",
          "hook:sync",
          "recovery:allow",
        ]);
        const stopFailed = lifecycleEvents.find((event) => event.type === "stop-failed");
        assert.equal(stopFailed.baseline, baselineInstance);
        assert.equal(stopFailed.baseline.status, "running");
      } finally {
        await app.close();
      }
    });
  }
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("per-instance lifecycle queue serializes stop before restart", async () => {
  const gate = deferred();
  const { app, calls } = lifecycleRouteHarness({ stopGate: gate.promise, failRestart: true, isManaged: false });
  try {
    const stopping = app.inject({ method: "POST", url: "/api/node-agent/instances/inst_routes/stop" });
    while (!calls.includes("adapter:stop")) await new Promise((resolve) => setImmediate(resolve));
    const restarting = app.inject({ method: "POST", url: "/api/node-agent/instances/inst_routes/restart", payload: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.includes("adapter:restart"), false);
    gate.resolve();
    assert.equal((await stopping).statusCode, 200);
    assert.equal((await restarting).statusCode, 500);
    assert.ok(calls.indexOf("adapter:restart") > calls.indexOf("lifecycle:stop-completed"));
  } finally {
    await app.close();
  }
});

test("per-instance lifecycle queue serializes delete before start", async () => {
  const gate = deferred();
  const { app, calls } = lifecycleRouteHarness({ deleteGate: gate.promise, failStart: true });
  try {
    const deleting = app.inject({ method: "POST", url: "/api/node-agent/instances/inst_routes/delete" });
    while (!calls.includes("adapter:delete")) await new Promise((resolve) => setImmediate(resolve));
    const starting = app.inject({ method: "POST", url: "/api/node-agent/instances/inst_routes/start", payload: {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.includes("hook:start"), false);
    gate.resolve();
    assert.equal((await deleting).statusCode, 200);
    assert.equal((await starting).statusCode, 500);
    assert.ok(calls.indexOf("hook:start") > calls.indexOf("recovery:forget"));
  } finally {
    await app.close();
  }
});

test("a rejected lifecycle operation does not poison the per-instance queue", async () => {
  const { app, calls } = lifecycleRouteHarness({ failCancel: true, failStart: true });
  try {
    const stopping = app.inject({ method: "POST", url: "/api/node-agent/instances/inst_routes/stop" });
    const starting = app.inject({ method: "POST", url: "/api/node-agent/instances/inst_routes/start", payload: {} });
    assert.equal((await stopping).statusCode, 500);
    assert.equal((await starting).statusCode, 500);
    assert.equal(calls.includes("hook:start"), true);
  } finally {
    await app.close();
  }
});

test("stop cancels in-flight start, reconcile, and restart before waiting for lifecycle serialization", async (t) => {
  for (const entry of [
    { name: "start", url: "/api/node-agent/instances/inst_routes/start", gateOption: "startGate", enteredOption: "startEntered", activeStatus: 200 },
    { name: "reconcile", url: "/api/node-agent/instances/inst_routes/runtime/reconcile", gateOption: "scheduleGate", enteredOption: "scheduleEntered", activeStatus: 409 },
    { name: "restart", url: "/api/node-agent/instances/inst_routes/restart", gateOption: "restartGate", enteredOption: "restartEntered", activeStatus: 409, isManaged: false },
  ]) {
    await t.test(entry.name, async () => {
      const blocked = deferred();
      const entered = deferred();
      const continuationValues = [];
      let activeCompleted = false;
      let cancelObservedBeforeActiveCompletion = false;
      const options = {
        [entry.gateOption]: blocked.promise,
        [entry.enteredOption]: entered.resolve,
        onCancel: () => {
          cancelObservedBeforeActiveCompletion = !activeCompleted;
          blocked.resolve();
        },
        startContinuationObserved: (value) => continuationValues.push(value),
        isManaged: entry.isManaged,
      };
      const { app, calls } = lifecycleRouteHarness(options);
      try {
        const active = app.inject({ method: "POST", url: entry.url, payload: {} });
        await entered.promise;
        void active.then(() => { activeCompleted = true; });
        const stopping = app.inject({ method: "POST", url: "/api/node-agent/instances/inst_routes/stop" });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(calls.includes("convergence:cancel"), true);
        assert.equal(cancelObservedBeforeActiveCompletion, true);
        assert.equal((await active).statusCode, entry.activeStatus);
        assert.equal((await stopping).statusCode, 200);
        if (entry.name === "start") assert.deepEqual(continuationValues, [false]);
        assert.ok(calls.indexOf("convergence:cancel") < calls.indexOf("adapter:stop"));
      } finally {
        blocked.resolve();
        await app.close();
      }
    });
  }
});

test("node-agent app forwards lifecycle cancellation into the start continuation guard", () => {
  const source = fs.readFileSync(path.join(__dirname, "../packages/control-plane/src/node-agent/app.ts"), "utf8");
  assert.match(source, /start:\s*\(id, shouldContinue\)\s*=>\s*startInstanceWithFailureState\(id, "request", shouldContinue\)/);
  assert.match(source, /if \(!shouldContinue\(\)\) return state\.requireInstance\(id\);/);
  assert.ok(
    source.indexOf("if (!shouldContinue()) return state.requireInstance(id);")
      < source.indexOf("await startNodeInstance(state, runtimeAdapters"),
    "the continuation guard must run before starting the runtime",
  );
});

test("a later stop supersedes a start already queued behind the instance gate", async () => {
  const stopGate = deferred();
  const startQueued = deferred();
  let operationCount = 0;
  const { app, calls } = lifecycleRouteHarness({
    stopGate: stopGate.promise,
    operationEnqueued: () => {
      operationCount += 1;
      if (operationCount === 2) startQueued.resolve();
    },
  });
  try {
    const firstStop = app.inject({ method: "POST", url: "/api/node-agent/instances/inst_routes/stop" });
    while (!calls.includes("adapter:stop")) await new Promise((resolve) => setImmediate(resolve));
    const queuedStart = app.inject({ method: "POST", url: "/api/node-agent/instances/inst_routes/start", payload: {} });
    void queuedStart.then(() => undefined);
    await startQueued.promise;
    const finalStop = app.inject({ method: "POST", url: "/api/node-agent/instances/inst_routes/stop" });
    await new Promise((resolve) => setImmediate(resolve));
    stopGate.resolve();

    assert.equal((await firstStop).statusCode, 200);
    const startResponse = await queuedStart;
    assert.equal(startResponse.statusCode, 409, startResponse.body);
    assert.equal((await finalStop).statusCode, 200);
    assert.equal(calls.includes("hook:start"), false);
  } finally {
    stopGate.resolve();
    await app.close();
  }
});

test("delete re-reads the authoritative instance after cancellation settles", async () => {
  const cancellation = deferred();
  const cancelEntered = deferred();
  let deletedInstance;
  const harness = lifecycleRouteHarness({
    cancelGate: cancellation.promise,
    onCancel: cancelEntered.resolve,
    deleteInstanceObserved: (instance) => { deletedInstance = instance; },
  });
  try {
    const deleting = harness.app.inject({ method: "POST", url: "/api/node-agent/instances/inst_routes/delete" });
    await cancelEntered.promise;
    harness.replaceInstance({
      ...harness.baselineInstance,
      runtime: { ...harness.baselineInstance.runtime, port: 45678 },
      updatedAt: "2026-08-02T00:00:01.000Z",
    });
    cancellation.resolve();

    assert.equal((await deleting).statusCode, 200);
    assert.equal(deletedInstance.runtime.port, 45678);
  } finally {
    cancellation.resolve();
    await harness.app.close();
  }
});

test("a cancelled restart commits its runtime identity before stop consumes it", async () => {
  const restart = deferred();
  const restartEntered = deferred();
  let stoppedInstance;
  const harness = lifecycleRouteHarness({
    isManaged: false,
    restartGate: restart.promise,
    restartEntered: restartEntered.resolve,
    restartResult: { runtime: { port: 45679 } },
    onCancel: restart.resolve,
    stopInstanceObserved: (instance) => { stoppedInstance = instance; },
  });
  try {
    const restarting = harness.app.inject({ method: "POST", url: "/api/node-agent/instances/inst_routes/restart", payload: {} });
    await restartEntered.promise;
    const stopping = harness.app.inject({ method: "POST", url: "/api/node-agent/instances/inst_routes/stop" });

    assert.equal((await restarting).statusCode, 409);
    assert.equal((await stopping).statusCode, 200);
    assert.equal(stoppedInstance.runtime.port, 45679);
  } finally {
    restart.resolve();
    await harness.app.close();
  }
});

test("instance operation intents invalidate continuations without waiting for the queue", async () => {
  const operations = new InstanceOperationGate();
  const initial = operations.intent("inst_intent");
  assert.equal(operations.isIntentCurrent("inst_intent", initial), true);

  const destructive = operations.invalidate("inst_intent");
  assert.equal(operations.isIntentCurrent("inst_intent", initial), false);
  assert.equal(operations.isIntentCurrent("inst_intent", destructive), true);

  operations.clearIntent("inst_intent");
  assert.equal(operations.isIntentCurrent("inst_intent", destructive), false);
});
