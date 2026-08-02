const assert = require("node:assert/strict");
const test = require("node:test");

const { ControlledInstanceSchema } = require("../packages/protocol/src/control-plane.ts");
const { InstanceImageProvisioningController } = require("../packages/control-plane/src/node-agent/instances/image-provisioning.ts");

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
