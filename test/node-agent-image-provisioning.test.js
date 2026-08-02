const assert = require("node:assert/strict");
const test = require("node:test");

const { ControlledInstanceSchema } = require("../packages/protocol/src/control-plane.ts");
const { InstanceImageProvisioningController } = require("../packages/control-plane/src/node-agent/instances/image-provisioning.ts");
const { InstanceOperationGate } = require("../packages/control-plane/src/node-agent/instances/instance-operation-gate.ts");

function imageProvisioningInstance(generation) {
  const timestamp = "2026-08-02T00:00:00.000Z";
  return ControlledInstanceSchema.parse({
    id: "inst_image_generation",
    name: "image generation",
    source: { type: "local-folder", path: "/workspace" },
    sourceSnapshot: {},
    modelSelection: {},
    nodeId: "node_1",
    runtimeId: "runtime_docker",
    imageSnapshot: {
      id: "img_1",
      origin: "custom",
      name: "Image",
      repository: "example/app",
      tag: "latest",
      requestedReference: "example/app:latest",
      pullPolicy: "if-not-present",
      capabilities: [],
      optionalApps: [],
      defaultEnv: {},
      labels: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    imageProvisioning: {
      phase: "pulling-image",
      requestedReference: "example/app:latest",
      generation,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
    status: "provisioning",
    health: "unknown",
    connectionStatus: "offline",
    agentStatus: "offline",
    targetStatus: "unknown",
    uiAccessStatus: "unknown",
    controlMode: "controlled",
    ready: false,
    capabilities: {},
    config: {},
    workspace: { status: "pending" },
    target: { strategy: "node-proxy", status: "unknown" },
    apps: { runningCount: 0, problemCount: 0 },
    aiSessions: { runningCount: 0, waitingCount: 0, sessions: [], updatedAt: timestamp },
    runtime: { kind: "docker", labels: {} },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

test("stale image provisioning completion cannot overwrite a newer generation", async () => {
  let stored = imageProvisioningInstance(1);
  let resolveEnsure;
  const ensure = new Promise((resolve) => {
    resolveEnsure = resolve;
  });
  let writes = 0;
  let syncs = 0;
  const state = {
    controlledInstances: {
      get: () => stored,
      put: (instance) => {
        writes += 1;
        stored = instance;
        return instance;
      },
    },
  };
  const controller = new InstanceImageProvisioningController(state, {
    ensure: () => ensure,
  }, {
    sync: () => { syncs += 1; },
    diagnostic: () => undefined,
    warn: () => undefined,
    publish: () => undefined,
  });

  const provisioning = controller.provision(stored);
  const newer = imageProvisioningInstance(2);
  stored = newer;
  resolveEnsure({
    requestedReference: "example/app:latest",
    resolvedDigest: `sha256:${"a".repeat(64)}`,
    resolvedReference: `example/app@sha256:${"a".repeat(64)}`,
    pulled: true,
  });
  await provisioning;

  assert.equal(stored, newer);
  assert.equal(stored.imageProvisioning.generation, 2);
  assert.equal(writes, 0);
  assert.equal(syncs, 0);
});

test("same instance image generation provisions and starts only once", async () => {
  let stored = ControlledInstanceSchema.parse({
    ...imageProvisioningInstance(1),
    status: "starting",
  });
  let resolveEnsure;
  const ensure = new Promise((resolve) => {
    resolveEnsure = resolve;
  });
  let ensureCalls = 0;
  let startCalls = 0;
  const state = {
    controlledInstances: {
      get: () => stored,
      put: (instance) => {
        stored = instance;
        return instance;
      },
    },
  };
  const controller = new InstanceImageProvisioningController(state, {
    ensure: () => {
      ensureCalls += 1;
      return ensure;
    },
  }, {
    sync: () => undefined,
    diagnostic: () => undefined,
    warn: () => undefined,
    publish: () => undefined,
  });

  const first = controller.provision(stored, async () => { startCalls += 1; });
  const second = controller.provision(stored, async () => { startCalls += 1; });
  assert.equal(first, second);
  resolveEnsure({
    requestedReference: "example/app:latest",
    resolvedDigest: `sha256:${"a".repeat(64)}`,
    resolvedReference: `example/app@sha256:${"a".repeat(64)}`,
    pulled: true,
  });
  await Promise.all([first, second]);

  assert.equal(ensureCalls, 1);
  assert.equal(startCalls, 1);
});

test("stopping image provisioning cancels in-flight work and suppresses later effects", async () => {
  let stored = ControlledInstanceSchema.parse({
    ...imageProvisioningInstance(1),
    status: "starting",
  });
  let phaseListener;
  let terminalListener;
  let provisioningSignal;
  let cancellationSeen = false;
  let writes = 0;
  let syncs = 0;
  let publications = 0;
  let starts = 0;
  let ensureCalls = 0;
  const controller = new InstanceImageProvisioningController({
    controlledInstances: {
      get: () => stored,
      put: (instance) => {
        writes += 1;
        stored = instance;
        return instance;
      },
    },
  }, {
    ensure: (_reference, onPhase, onTerminal, signal) => {
      ensureCalls += 1;
      phaseListener = onPhase;
      terminalListener = onTerminal;
      provisioningSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          cancellationSeen = true;
          setImmediate(() => reject(Object.assign(new Error("pull aborted"), { code: "RUNTIME_COMMAND_ABORTED" })));
        }, { once: true });
      });
    },
  }, {
    sync: () => { syncs += 1; },
    diagnostic: () => undefined,
    warn: () => undefined,
    publish: () => { publications += 1; },
  });

  const provisioning = controller.provision(stored, async () => { starts += 1; });
  let stopCompleted = false;
  const stopping = controller.stop().then(() => { stopCompleted = true; });
  await Promise.resolve();
  assert.equal(stopCompleted, false);
  assert.equal(provisioningSignal.aborted, true);
  assert.equal(cancellationSeen, true);

  phaseListener("pulling-image");
  terminalListener({ sequence: 1, data: "late output" });
  await Promise.all([provisioning, stopping]);

  assert.equal(writes, 0);
  assert.equal(syncs, 0);
  assert.equal(publications, 0);
  assert.equal(starts, 0);
  await controller.provision(stored, async () => { starts += 1; });
  assert.equal(ensureCalls, 1);
  assert.equal(starts, 0);
});

test("image-ready continuation rechecks stopped state behind the shared lifecycle gate", async () => {
  let stored = ControlledInstanceSchema.parse({ ...imageProvisioningInstance(1), status: "starting" });
  let resolveEnsure;
  const ensure = new Promise((resolve) => { resolveEnsure = resolve; });
  let releaseStop;
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  let starts = 0;
  const operations = new InstanceOperationGate();
  const controller = new InstanceImageProvisioningController({
    controlledInstances: {
      get: () => stored,
      put: (instance) => { stored = instance; return instance; },
    },
  }, { ensure: () => ensure }, {
    sync: () => undefined,
    diagnostic: () => undefined,
    warn: () => undefined,
    publish: () => undefined,
    runInstanceOperation: (id, operation) => operations.run(id, operation),
  });

  const stopping = operations.run(stored.id, async () => {
    stored = ControlledInstanceSchema.parse({ ...stored, status: "stopped" });
    await stopGate;
  });
  const provisioning = controller.provision(stored, async () => { starts += 1; });
  resolveEnsure({
    requestedReference: "example/app:latest",
    resolvedDigest: `sha256:${"b".repeat(64)}`,
    resolvedReference: `example/app@sha256:${"b".repeat(64)}`,
    pulled: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 0);
  releaseStop();
  await Promise.all([stopping, provisioning]);

  assert.equal(stored.status, "stopped");
  assert.equal(stored.imageProvisioning.phase, "ready");
  assert.equal(starts, 0);
});

test("image-ready continuation drops a deleted instance behind the shared lifecycle gate", async () => {
  let stored = ControlledInstanceSchema.parse({ ...imageProvisioningInstance(1), status: "starting" });
  let resolveEnsure;
  const ensure = new Promise((resolve) => { resolveEnsure = resolve; });
  let releaseDelete;
  const deleteGate = new Promise((resolve) => { releaseDelete = resolve; });
  let writes = 0;
  let starts = 0;
  const operations = new InstanceOperationGate();
  const controller = new InstanceImageProvisioningController({
    controlledInstances: {
      get: () => stored,
      put: (instance) => { writes += 1; stored = instance; return instance; },
    },
  }, { ensure: () => ensure }, {
    sync: () => undefined,
    diagnostic: () => undefined,
    warn: () => undefined,
    publish: () => undefined,
    runInstanceOperation: (id, operation) => operations.run(id, operation),
  });

  const deleting = operations.run(stored.id, async () => {
    stored = undefined;
    await deleteGate;
  });
  const provisioning = controller.provision(imageProvisioningInstance(1), async () => { starts += 1; });
  resolveEnsure({
    requestedReference: "example/app:latest",
    resolvedDigest: `sha256:${"c".repeat(64)}`,
    resolvedReference: `example/app@sha256:${"c".repeat(64)}`,
    pulled: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseDelete();
  await Promise.all([deleting, provisioning]);

  assert.equal(stored, undefined);
  assert.equal(writes, 0);
  assert.equal(starts, 0);
});

test("late image phase and failure cannot overwrite an explicit stop", async () => {
  for (const outcome of ["phase", "failure"]) {
    let stored = ControlledInstanceSchema.parse({ ...imageProvisioningInstance(1), status: "starting" });
    const stoppedPhase = stored.imageProvisioning.phase;
    let phaseListener;
    let rejectEnsure;
    const ensure = new Promise((_resolve, reject) => { rejectEnsure = reject; });
    let releaseStop;
    const stopGate = new Promise((resolve) => { releaseStop = resolve; });
    const operations = new InstanceOperationGate();
    const controller = new InstanceImageProvisioningController({
      controlledInstances: {
        get: () => stored,
        put: (instance) => { stored = instance; return instance; },
      },
    }, {
      ensure: (_reference, onPhase) => {
        phaseListener = onPhase;
        return ensure;
      },
    }, {
      sync: () => undefined,
      diagnostic: () => undefined,
      warn: () => undefined,
      publish: () => undefined,
      runInstanceOperation: (id, operation) => operations.run(id, operation),
    });

    const provisioning = controller.provision(stored);
    await new Promise((resolve) => setImmediate(resolve));
    const stopping = operations.run(stored.id, async () => {
      stored = ControlledInstanceSchema.parse({ ...stored, status: "stopped" });
      await stopGate;
    });
    if (outcome === "phase") phaseListener("checking-image");
    else rejectEnsure(new Error("pull failed after stop"));
    await new Promise((resolve) => setImmediate(resolve));
    releaseStop();
    if (outcome === "phase") rejectEnsure(new Error("finish test"));
    await Promise.all([stopping, provisioning]);

    assert.equal(stored.status, "stopped");
    assert.equal(stored.imageProvisioning.phase, stoppedPhase);
  }
});

test("old image completion cannot overwrite a recreated instance with the same id and generation", async () => {
  const original = ControlledInstanceSchema.parse({ ...imageProvisioningInstance(1), status: "starting" });
  let stored = original;
  let resolveEnsure;
  const ensure = new Promise((resolve) => { resolveEnsure = resolve; });
  const operations = new InstanceOperationGate();
  let starts = 0;
  const controller = new InstanceImageProvisioningController({
    controlledInstances: {
      get: () => stored,
      put: (instance) => { stored = instance; return instance; },
    },
  }, { ensure: () => ensure }, {
    sync: () => undefined,
    diagnostic: () => undefined,
    warn: () => undefined,
    publish: () => undefined,
    runInstanceOperation: (id, operation) => operations.run(id, operation),
  });

  const provisioning = controller.provision(original, async () => { starts += 1; });
  stored = ControlledInstanceSchema.parse({
    ...imageProvisioningInstance(1),
    status: "starting",
    createdAt: "2026-08-02T00:00:01.000Z",
    updatedAt: "2026-08-02T00:00:01.000Z",
  });
  const recreated = stored;
  resolveEnsure({
    requestedReference: "example/app:latest",
    resolvedDigest: `sha256:${"d".repeat(64)}`,
    resolvedReference: `example/app@sha256:${"d".repeat(64)}`,
    pulled: true,
  });
  await provisioning;

  assert.equal(stored, recreated);
  assert.equal(starts, 0);
});

test("a failed gated phase update is observed and prevents a ready commit", async () => {
  let stored = imageProvisioningInstance(1);
  let putCalls = 0;
  const warnings = [];
  const controller = new InstanceImageProvisioningController({
    controlledInstances: {
      get: () => stored,
      put: (instance) => {
        putCalls += 1;
        if (putCalls === 1) throw new Error("phase persistence failed");
        stored = instance;
        return instance;
      },
    },
  }, {
    ensure: async (_reference, onPhase) => {
      onPhase("pulling-image");
      return {
        requestedReference: "example/app:latest",
        resolvedDigest: `sha256:${"e".repeat(64)}`,
        resolvedReference: `example/app@sha256:${"e".repeat(64)}`,
        pulled: true,
      };
    },
  }, {
    sync: () => undefined,
    diagnostic: () => undefined,
    warn: (data) => warnings.push(data),
    publish: () => undefined,
    runInstanceOperation: (id, operation) => new InstanceOperationGate().run(id, operation),
  });

  await controller.provision(stored);
  assert.equal(stored.status, "failed");
  assert.equal(stored.imageProvisioning.phase, "failed");
  assert.equal(warnings[0].error, "phase persistence failed");
});

test("shutdown cancels image mutations already queued behind the instance gate", async () => {
  let stored = ControlledInstanceSchema.parse({ ...imageProvisioningInstance(1), status: "starting" });
  let writes = 0;
  let starts = 0;
  let phaseListener;
  let resolveEnsure;
  const ensure = new Promise((resolve) => { resolveEnsure = resolve; });
  let releaseGate;
  const heldGate = new Promise((resolve) => { releaseGate = resolve; });
  const operations = new InstanceOperationGate();
  const controller = new InstanceImageProvisioningController({
    controlledInstances: {
      get: () => stored,
      put: (instance) => { writes += 1; stored = instance; return instance; },
    },
  }, {
    ensure: (_reference, onPhase) => { phaseListener = onPhase; return ensure; },
  }, {
    sync: () => undefined,
    diagnostic: () => undefined,
    warn: () => undefined,
    publish: () => undefined,
    runInstanceOperation: (id, operation) => operations.run(id, operation),
  });

  const holding = operations.run(stored.id, async () => heldGate);
  const provisioning = controller.provision(stored, async () => { starts += 1; });
  await new Promise((resolve) => setImmediate(resolve));
  phaseListener("pulling-image");
  resolveEnsure({
    requestedReference: "example/app:latest",
    resolvedDigest: `sha256:${"f".repeat(64)}`,
    resolvedReference: `example/app@sha256:${"f".repeat(64)}`,
    pulled: true,
  });
  const stopping = controller.stop();
  releaseGate();
  await Promise.all([holding, provisioning, stopping]);

  assert.equal(writes, 0);
  assert.equal(starts, 0);
});
