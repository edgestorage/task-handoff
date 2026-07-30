const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ControlledInstanceSchema } = require("../packages/protocol/src/control-plane.ts");
const { RuntimeConvergenceCoordinator } = require("../packages/control-plane/src/node-agent/runtime-convergence.ts");
const { NodeUpdateJobs } = require("../packages/control-plane/src/node-agent/updates.ts");
const { nodeAgentStorePaths } = require("../packages/control-plane/src/node-agent/persistence/paths.ts");

function instance(overrides = {}) {
  const timestamp = new Date().toISOString();
  return ControlledInstanceSchema.parse({
    id: "inst_runtime",
    name: "Runtime",
    source: { type: "local-folder", path: "/workspace" },
    sourceSnapshot: {},
    modelSelection: {},
    nodeId: "node_1",
    runtimeId: "runtime_1",
    status: "running",
    health: "ok",
    connectionStatus: "online",
    agentStatus: "online",
    targetStatus: "reachable",
    uiAccessStatus: "reachable",
    controlMode: "controlled",
    build: { component: "controlled-instance", packageVersion: "1.0.0" },
    ready: true,
    capabilities: {},
    config: {},
    workspace: { status: "ready" },
    target: { strategy: "direct-port", web: "http://127.0.0.1:8080", status: "reachable" },
    access: { strategy: "node-proxy", status: "reachable" },
    apps: { runningCount: 0, problemCount: 0 },
    aiSessions: { runningCount: 0, waitingCount: 0, sessions: [], updatedAt: timestamp },
    runtime: { kind: "docker", containerId: "container_1", labels: {} },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

function memoryStore(initial) {
  const records = new Map([[initial.id, initial]]);
  return {
    records,
    get: (id) => records.get(id),
    put(value) {
      records.set(value.id, value);
      return value;
    },
  };
}

test("runtime reconciliation installs, restarts, and verifies one exact version", async () => {
  const store = memoryStore(instance());
  const calls = [];
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install(value, version) {
      calls.push(["install", value.runtime.containerId, version]);
    },
    async restart(value) {
      calls.push(["restart", value.runtime.containerId]);
      store.put(ControlledInstanceSchema.parse({
        ...store.get(value.id),
        build: { component: "controlled-instance", packageVersion: "2.0.0" },
      }));
    },
  }, { verificationTimeoutMs: 0 });

  const first = coordinator.schedule("inst_runtime");
  const second = coordinator.schedule("inst_runtime");
  assert.equal(first, second);
  const updated = await first;
  assert.deepEqual(calls, [["install", "container_1", "2.0.0"], ["restart", "container_1"]]);
  assert.equal(updated.runtime.containerId, "container_1");
  assert.equal(updated.runtimeVersion.phase, "matched");
  assert.equal(updated.runtimeVersion.actualVersion, "2.0.0");
  assert.equal(updated.ready, true);
});

test("runtime reconciliation never restores registered over a newer running heartbeat", async () => {
  const initial = instance({
    status: "registered",
    ready: false,
    runtimeVersion: {
      desiredVersion: "1.0.0",
      actualVersion: "1.0.0",
      phase: "matched",
      attempt: 0,
    },
  });
  const store = memoryStore(initial);
  let inspectStarted;
  let finishInspection;
  const inspectionStarted = new Promise((resolve) => { inspectStarted = resolve; });
  const inspectionGate = new Promise((resolve) => { finishInspection = resolve; });
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "1.0.0", {
    async isInstalled() {
      inspectStarted();
      await inspectionGate;
      return true;
    },
    async install() { throw new Error("must not install"); },
    async restart() { throw new Error("must not restart"); },
  });

  const convergence = coordinator.schedule("inst_runtime");
  await inspectionStarted;
  store.put(ControlledInstanceSchema.parse({
    ...store.get("inst_runtime"),
    status: "running",
    ready: false,
    lastHeartbeatAt: "2026-07-28T00:00:01.000Z",
  }));
  finishInspection();

  const updated = await convergence;
  assert.equal(updated.status, "running");
  assert.equal(updated.runtimeVersion.phase, "matched");
  assert.equal(updated.ready, true);
});

test("stopped instances remain pending until a start is requested", async () => {
  const store = memoryStore(instance({ status: "stopped", ready: false }));
  let installs = 0;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install() { installs += 1; },
    async restart() {},
  });

  const updated = await coordinator.schedule("inst_runtime");
  assert.equal(installs, 0);
  assert.equal(updated.runtimeVersion.phase, "pending");
  assert.equal(updated.ready, false);
});

test("an explicit stop cancels restart after an in-flight install", async () => {
  const store = memoryStore(instance());
  let finishInstall;
  let restarts = 0;
  let rollbacks = 0;
  const installGate = new Promise((resolve) => { finishInstall = resolve; });
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install() { await installGate; },
    async restart() { restarts += 1; },
    async rollback() { rollbacks += 1; },
  });

  const convergence = coordinator.schedule("inst_runtime");
  while (store.get("inst_runtime").runtimeVersion?.phase !== "installing") await new Promise((resolve) => setImmediate(resolve));
  coordinator.cancel("inst_runtime");
  store.put(ControlledInstanceSchema.parse({ ...store.get("inst_runtime"), status: "stopped", ready: false }));
  finishInstall();

  const updated = await convergence;
  assert.equal(restarts, 0);
  assert.equal(rollbacks, 0);
  assert.equal(updated.status, "stopped");
  assert.equal(updated.runtimeVersion.phase, "pending");
});

test("a passive trigger cannot clear stop intent but an explicit start can resume", async () => {
  const store = memoryStore(instance({ status: "stopped", ready: false }));
  let installs = 0;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install() { installs += 1; },
    async restart(value) {
      store.put(ControlledInstanceSchema.parse({
        ...store.get(value.id),
        status: "running",
        build: { component: "controlled-instance", packageVersion: "2.0.0" },
      }));
    },
  }, { verificationTimeoutMs: 0 });

  coordinator.cancel("inst_runtime");
  const passive = await coordinator.schedule("inst_runtime");
  assert.equal(installs, 0);
  assert.equal(passive.runtimeVersion.phase, "pending");

  const resumed = await coordinator.schedule("inst_runtime", { startRequested: true });
  assert.equal(installs, 1);
  assert.equal(resumed.runtimeVersion.phase, "matched");
});

test("cancellation while draining does not force, install, restart, or roll back", async () => {
  const store = memoryStore(instance({ apps: { runningCount: 1, problemCount: 0 } }));
  let releasePoll;
  let forced = 0;
  let installs = 0;
  let restarts = 0;
  let rollbacks = 0;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async onForcedDrain() { forced += 1; },
    async install() { installs += 1; },
    async restart() { restarts += 1; },
    async rollback() { rollbacks += 1; },
  }, {
    drainTimeoutMs: 60_000,
    pollIntervalMs: 1,
    delay: () => new Promise((resolve) => { releasePoll = resolve; }),
  });

  const convergence = coordinator.schedule("inst_runtime");
  while (store.get("inst_runtime").runtimeVersion?.phase !== "draining" || !releasePoll) await new Promise((resolve) => setImmediate(resolve));
  coordinator.cancel("inst_runtime");
  releasePoll();

  const updated = await convergence;
  assert.equal(updated.runtimeVersion.phase, "pending");
  assert.deepEqual({ forced, installs, restarts, rollbacks }, { forced: 0, installs: 0, restarts: 0, rollbacks: 0 });
});

test("cancellation during restart exits pending without rollback", async () => {
  const store = memoryStore(instance());
  let finishRestart;
  let restarts = 0;
  let rollbacks = 0;
  const restartGate = new Promise((resolve) => { finishRestart = resolve; });
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install() {},
    async restart() {
      restarts += 1;
      await restartGate;
    },
    async rollback() { rollbacks += 1; },
  });

  const convergence = coordinator.schedule("inst_runtime");
  while (store.get("inst_runtime").runtimeVersion?.phase !== "restarting") await new Promise((resolve) => setImmediate(resolve));
  const cancelled = coordinator.cancel("inst_runtime");
  assert.equal(cancelled, convergence);
  finishRestart();

  const updated = await convergence;
  assert.equal(updated.runtimeVersion.phase, "pending");
  assert.equal(restarts, 1);
  assert.equal(rollbacks, 0);
});

test("cancellation during verification exits pending without rollback", async () => {
  const store = memoryStore(instance());
  let releasePoll;
  let rollbacks = 0;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install() {},
    async restart() {},
    async rollback() { rollbacks += 1; },
  }, {
    verificationTimeoutMs: 60_000,
    pollIntervalMs: 1,
    delay: () => new Promise((resolve) => { releasePoll = resolve; }),
  });

  const convergence = coordinator.schedule("inst_runtime");
  while (store.get("inst_runtime").runtimeVersion?.phase !== "verifying" || !releasePoll) await new Promise((resolve) => setImmediate(resolve));
  coordinator.cancel("inst_runtime");
  releasePoll();

  const updated = await convergence;
  assert.equal(updated.runtimeVersion.phase, "pending");
  assert.equal(rollbacks, 0);
});

test("a stopped instance with a matched runtime remains not ready", async () => {
  const store = memoryStore(instance({
    status: "stopped",
    ready: false,
    build: { component: "controlled-instance", packageVersion: "2.0.0" },
  }));
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install() { throw new Error("must not install"); },
    async restart() { throw new Error("must not restart"); },
  });

  const updated = await coordinator.schedule("inst_runtime");
  assert.equal(updated.runtimeVersion.phase, "matched");
  assert.equal(updated.ready, false);
});

test("retryable failures use bounded exponential backoff and eventually converge", async () => {
  const store = memoryStore(instance());
  const delays = [];
  let installs = 0;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install() {
      installs += 1;
      if (installs < 3) throw new Error(`temporary failure ${installs}`);
    },
    async restart(value) {
      store.put(ControlledInstanceSchema.parse({
        ...store.get(value.id),
        build: { component: "controlled-instance", packageVersion: "2.0.0" },
      }));
    },
  }, {
    verificationTimeoutMs: 0,
    maxAttempts: 3,
    retryBaseDelayMs: 10,
    retryMaxDelayMs: 15,
    delay: async (milliseconds) => { delays.push(milliseconds); },
  });

  const updated = await coordinator.schedule("inst_runtime");
  assert.equal(installs, 3);
  assert.deepEqual(delays, [10, 15]);
  assert.equal(updated.runtimeVersion.attempt, 3);
  assert.equal(updated.runtimeVersion.phase, "matched");
});

test("a failed attempt batch remains diagnostic until the recovery supervisor retries it", async () => {
  const store = memoryStore(instance());
  let installs = 0;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install() {
      installs += 1;
      throw new Error("registry unavailable");
    },
    async restart() {},
  }, {
    maxAttempts: 2,
    retryBaseDelayMs: 0,
    delay: async () => {},
  });

  const updated = await coordinator.schedule("inst_runtime");
  assert.equal(installs, 2);
  assert.equal(updated.runtimeVersion.phase, "failed");
  assert.equal(updated.runtimeVersion.attempt, 2);
  assert.equal(updated.runtimeVersion.error.retryable, true);
  assert.match(updated.runtimeVersion.error.message, /paused after 2 attempts and will retry/);
  assert.match(updated.runtimeVersion.error.message, /Last error: registry unavailable/);

  const recovered = await coordinator.schedule("inst_runtime");
  assert.equal(installs, 2, "the coordinator waits for the recovery supervisor instead of spinning in one request");
  assert.equal(recovered.runtimeVersion.phase, "failed");
});

test("the recovery supervisor can retry a failed attempt batch after dependencies return", async () => {
  const store = memoryStore(instance());
  let installs = 0;
  let dependencyReady = false;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install() {
      installs += 1;
      if (!dependencyReady) throw new Error("Docker daemon unavailable");
    },
    async restart() {
      const current = store.get("inst_runtime");
      store.put({ ...current, instanceVersion: "2.0.0", build: { ...current.build, packageVersion: "2.0.0" } });
    },
  }, {
    maxAttempts: 1,
    retryBaseDelayMs: 0,
    verificationTimeoutMs: 0,
    delay: async () => {},
  });

  const exhausted = await coordinator.schedule("inst_runtime");
  assert.equal(exhausted.runtimeVersion.phase, "failed");
  dependencyReady = true;

  const recovered = await coordinator.schedule("inst_runtime", { retryFailed: true });
  assert.equal(recovered.runtimeVersion.phase, "matched");
  assert.equal(recovered.runtimeVersion.attempt, 1);
  assert.equal(installs, 2);
});

test("executor error codes outside the convergence protocol retain their message without invalidating state", async () => {
  const store = memoryStore(instance());
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install() {
      throw Object.assign(new Error("launcher asset does not exist"), { code: "ENOENT" });
    },
    async restart() {},
  }, { maxAttempts: 1 });

  const updated = await coordinator.schedule("inst_runtime");
  assert.equal(updated.runtimeVersion.phase, "failed");
  assert.equal(updated.runtimeVersion.error.code, "INSTANCE_RUNTIME_INSTALL_FAILED");
  assert.match(updated.runtimeVersion.error.message, /launcher asset does not exist/);
});

test("an interrupted phase keeps the last concrete convergence error", async () => {
  const previousError = {
    code: "INSTANCE_RUNTIME_INSTALL_FAILED",
    message: "docker cp could not find the launcher asset",
    expectedVersion: "2.0.0",
    actualVersion: "1.0.0",
    retryable: true,
  };
  const store = memoryStore(instance({
    ready: false,
    runtimeVersion: {
      desiredVersion: "2.0.0",
      actualVersion: "1.0.0",
      phase: "installing",
      attempt: 1,
      error: previousError,
    },
  }));
  let observedError;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install(value) {
      observedError = value.runtimeVersion.error;
      throw Object.assign(new Error("second install failed"), { code: "ENOENT" });
    },
    async restart() {},
  }, { maxAttempts: 2, retryBaseDelayMs: 0, delay: async () => {} });

  const updated = await coordinator.schedule("inst_runtime");
  assert.equal(observedError.message, previousError.message);
  assert.match(updated.runtimeVersion.error.message, /Last error: second install failed/);
});

test("non-retryable failures stop immediately", async () => {
  const store = memoryStore(instance());
  let installs = 0;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install() {
      installs += 1;
      throw {
        code: "INSTANCE_BASE_RUNTIME_INCOMPATIBLE",
        message: "launcher ABI is incompatible",
        retryable: false,
      };
    },
    async restart() {},
  }, { maxAttempts: 3, retryBaseDelayMs: 0, delay: async () => {} });

  const updated = await coordinator.schedule("inst_runtime");
  assert.equal(installs, 1);
  assert.equal(updated.runtimeVersion.error.code, "INSTANCE_BASE_RUNTIME_INCOMPATIBLE");
  assert.equal(updated.runtimeVersion.error.retryable, false);
});

test("convergence is version-direction agnostic and can move to an older desired version", async () => {
  const store = memoryStore(instance({
    build: { component: "controlled-instance", packageVersion: "3.0.0" },
  }));
  const installed = [];
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install(_value, version) { installed.push(version); },
    async restart(value) {
      store.put(ControlledInstanceSchema.parse({
        ...store.get(value.id),
        build: { component: "controlled-instance", packageVersion: "2.0.0" },
      }));
    },
  }, { verificationTimeoutMs: 0 });

  const updated = await coordinator.schedule("inst_runtime");
  assert.deepEqual(installed, ["2.0.0"]);
  assert.equal(updated.runtimeVersion.actualVersion, "2.0.0");
  assert.equal(updated.runtimeVersion.phase, "matched");
});

test("concurrent triggers are single-flight and merge a start request", async () => {
  const store = memoryStore(instance({ status: "stopped", ready: false }));
  let installs = 0;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install() { installs += 1; },
    async restart(value) {
      store.put(ControlledInstanceSchema.parse({
        ...store.get(value.id),
        build: { component: "controlled-instance", packageVersion: "2.0.0" },
      }));
    },
  }, { verificationTimeoutMs: 0 });

  const passive = coordinator.schedule("inst_runtime");
  const requested = coordinator.schedule("inst_runtime", { startRequested: true });
  assert.equal(passive, requested);
  const updated = await passive;
  assert.equal(installs, 1);
  assert.equal(updated.runtimeVersion.phase, "matched");
});

test("a matching reported version still repairs a missing active runtime release", async () => {
  const store = memoryStore(instance({
    status: "stopped",
    ready: false,
    build: { component: "controlled-instance", packageVersion: "2.0.0" },
  }));
  let installed = false;
  let installs = 0;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async isInstalled() { return installed; },
    async install() {
      installs += 1;
      installed = true;
    },
    async restart() {},
  }, { verificationTimeoutMs: 0 });

  const updated = await coordinator.schedule("inst_runtime", { startRequested: true });
  assert.equal(installs, 1);
  assert.equal(updated.runtimeVersion.phase, "matched");
  assert.equal(updated.ready, false);
});

test("same-version artifact install failures retain the artifact error and never roll back an unmanaged release", async () => {
  const store = memoryStore(instance({
    build: { component: "controlled-instance", packageVersion: "0.0.1" },
  }));
  let rollbacks = 0;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "0.0.1", {
    async isInstalled() { return false; },
    async install() {
      throw { code: "INSTANCE_RUNTIME_INSTALL_FAILED", message: "bootstrap stderr", retryable: true };
    },
    async restart() {},
    async rollback() { rollbacks += 1; },
  }, { maxAttempts: 2, retryBaseDelayMs: 0, delay: async () => {} });

  const failed = await coordinator.schedule("inst_runtime");
  assert.equal(rollbacks, 0);
  assert.equal(failed.runtimeVersion.error.code, "INSTANCE_RUNTIME_INSTALL_FAILED");
  assert.match(failed.runtimeVersion.error.message, /bootstrap stderr/);
  const repeated = await coordinator.schedule("inst_runtime");
  assert.equal(repeated.runtimeVersion.error.code, "INSTANCE_RUNTIME_INSTALL_FAILED");
  assert.match(repeated.runtimeVersion.error.message, /bootstrap stderr/);
});

test("recovery normalizes an interrupted phase and continues from the recorded attempt", async () => {
  const store = memoryStore(instance({
    ready: false,
    runtimeVersion: {
      desiredVersion: "2.0.0",
      actualVersion: "1.0.0",
      phase: "restarting",
      attempt: 1,
      lastAttemptAt: new Date(0).toISOString(),
    },
  }));
  let observedAttempt;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install(value) { observedAttempt = value.runtimeVersion.attempt; },
    async restart(value) {
      store.put(ControlledInstanceSchema.parse({
        ...store.get(value.id),
        build: { component: "controlled-instance", packageVersion: "2.0.0" },
      }));
    },
  }, { verificationTimeoutMs: 0, maxAttempts: 3 });

  const updated = await coordinator.schedule("inst_runtime");
  assert.equal(observedAttempt, 2);
  assert.equal(updated.runtimeVersion.desiredVersion, "2.0.0");
  assert.equal(updated.runtimeVersion.attempt, 2);
  assert.equal(updated.runtimeVersion.phase, "matched");
});

test("a new desired version resets an exhausted attempt budget from an older rollout", async () => {
  const store = memoryStore(instance({
    ready: false,
    runtimeVersion: {
      desiredVersion: "1.5.0",
      actualVersion: "1.0.0",
      phase: "failed",
      attempt: 3,
      error: {
        code: "INSTANCE_RUNTIME_INSTALL_FAILED",
        message: "old rollout exhausted",
        expectedVersion: "1.5.0",
        actualVersion: "1.0.0",
        retryable: false,
      },
    },
  }));
  let observedAttempt;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install(value) { observedAttempt = value.runtimeVersion.attempt; },
    async restart(value) {
      store.put(ControlledInstanceSchema.parse({
        ...store.get(value.id),
        build: { component: "controlled-instance", packageVersion: "2.0.0" },
      }));
    },
  }, { verificationTimeoutMs: 0, maxAttempts: 3 });

  const updated = await coordinator.schedule("inst_runtime");
  assert.equal(observedAttempt, 1);
  assert.equal(updated.runtimeVersion.attempt, 1);
  assert.equal(updated.runtimeVersion.phase, "matched");
});

test("active instances drain for a bounded time and still converge", async () => {
  let clock = 0;
  const active = instance({ apps: { runningCount: 1, problemCount: 0 } });
  const store = memoryStore(active);
  let forced = 0;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async onForcedDrain() { forced += 1; },
    async install() {},
    async restart(value) {
      store.put(ControlledInstanceSchema.parse({
        ...store.get(value.id),
        build: { component: "controlled-instance", packageVersion: "2.0.0" },
      }));
    },
  }, {
    now: () => new Date(clock),
    delay: async (milliseconds) => { clock += milliseconds; },
    drainTimeoutMs: 10,
    pollIntervalMs: 5,
    verificationTimeoutMs: 0,
  });

  const updated = await coordinator.schedule("inst_runtime");
  assert.equal(forced, 1);
  assert.equal(updated.runtimeVersion.phase, "matched");
});

test("verification failures remain diagnostic without moving away from the desired release", async () => {
  const store = memoryStore(instance());
  let rollbacks = 0;
  const coordinator = new RuntimeConvergenceCoordinator(store, () => "2.0.0", {
    async install() {},
    async restart() {},
    async rollback() {
      rollbacks += 1;
    },
  }, { verificationTimeoutMs: 0, maxAttempts: 1 });

  const updated = await coordinator.schedule("inst_runtime");
  assert.equal(rollbacks, 0);
  assert.equal(updated.runtimeVersion.phase, "failed");
  assert.equal(updated.runtimeVersion.error.code, "INSTANCE_RUNTIME_VERIFICATION_FAILED");
  assert.equal(updated.ready, false);
});

test("Node rollout succeeds only after every expected running instance matches", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-rollout-"));
  const jobs = new NodeUpdateJobs(nodeAgentStorePaths(dataDir));
  jobs.init();
  const check = {
    source: "npm",
    channel: "stable",
    currentVersion: "1.0.0",
    availableVersion: "2.0.0",
    runtimeArtifacts: [],
    impact: {
      runningInstanceCount: 2,
      stoppedInstanceCount: 1,
      activeInstanceCount: 0,
      restartInstanceCount: 2,
      runningInstanceIds: ["inst_1", "inst_2"],
      stoppedInstanceIds: ["inst_3"],
      activeInstanceIds: [],
    },
    updateAvailable: true,
    supported: true,
    checkedAt: new Date().toISOString(),
  };
  const created = jobs.create("node_1", check);
  jobs.patch(created.id, {
    status: "converging-instances",
    rollout: { ...created.rollout, phase: "converging-instances", nodeVersion: "2.0.0" },
  });

  jobs.reconcileRollouts([
    { id: "inst_1", ready: true, runtimeVersion: { desiredVersion: "2.0.0", actualVersion: "2.0.0", phase: "matched" } },
    { id: "inst_2", ready: false, runtimeVersion: { desiredVersion: "2.0.0", actualVersion: "1.0.0", phase: "installing" } },
  ], "2.0.0");
  assert.equal(jobs.records.get(created.id).status, "converging-instances");
  assert.equal(jobs.records.get(created.id).rollout.matchedInstanceCount, 1);

  jobs.reconcileRollouts([
    { id: "inst_1", ready: true, runtimeVersion: { desiredVersion: "2.0.0", actualVersion: "2.0.0", phase: "matched" } },
    { id: "inst_2", ready: true, runtimeVersion: { desiredVersion: "2.0.0", actualVersion: "2.0.0", phase: "matched" } },
  ], "2.0.0");
  const succeeded = jobs.records.get(created.id);
  assert.equal(succeeded.status, "succeeded");
  assert.equal(succeeded.rollout.matchedInstanceCount, 2);
  assert.equal(succeeded.rollout.pendingInstanceCount, 0);
});

test("Node rollout recovers after node restart and succeeds immediately with no running instances", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-rollout-recovery-"));
  const jobs = new NodeUpdateJobs(nodeAgentStorePaths(dataDir));
  jobs.init();
  const check = {
    source: "npm",
    channel: "stable",
    currentVersion: "1.0.0",
    availableVersion: "2.0.0",
    runtimeArtifacts: [],
    impact: {
      runningInstanceCount: 0,
      stoppedInstanceCount: 1,
      activeInstanceCount: 0,
      restartInstanceCount: 0,
      runningInstanceIds: [],
      stoppedInstanceIds: ["inst_stopped"],
      activeInstanceIds: [],
    },
    updateAvailable: true,
    supported: true,
    checkedAt: new Date().toISOString(),
  };
  const created = jobs.create("node_1", check);
  jobs.patch(created.id, {
    status: "restarting-node",
    rollout: { ...created.rollout, phase: "restarting-node" },
  });

  jobs.reconcileRollouts([
    { id: "inst_stopped", status: "stopped", ready: false, runtimeVersion: { desiredVersion: "1.0.0", actualVersion: "1.0.0", phase: "matched" } },
  ], "2.0.0");

  const succeeded = jobs.records.get(created.id);
  assert.equal(succeeded.status, "succeeded");
  assert.equal(succeeded.rollout.nodeVersion, "2.0.0");
  assert.equal(succeeded.rollout.deferredInstanceCount, 1);
  assert.equal(succeeded.rollout.pendingInstanceCount, 0);
});

test("instances stopped during rollout are deferred instead of blocking forever", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-rollout-deferred-"));
  const jobs = new NodeUpdateJobs(nodeAgentStorePaths(dataDir));
  jobs.init();
  const check = {
    source: "npm",
    channel: "stable",
    currentVersion: "1.0.0",
    availableVersion: "2.0.0",
    runtimeArtifacts: [],
    impact: {
      runningInstanceCount: 1,
      stoppedInstanceCount: 0,
      activeInstanceCount: 0,
      restartInstanceCount: 1,
      runningInstanceIds: ["inst_stopped"],
      stoppedInstanceIds: [],
      activeInstanceIds: [],
    },
    updateAvailable: true,
    supported: true,
    checkedAt: new Date().toISOString(),
  };
  const created = jobs.create("node_1", check);
  jobs.patch(created.id, {
    status: "converging-instances",
    rollout: { ...created.rollout, phase: "converging-instances", nodeVersion: "2.0.0" },
  });

  jobs.reconcileRollouts([
    { id: "inst_stopped", status: "stopped", ready: false, runtimeVersion: { desiredVersion: "2.0.0", actualVersion: "1.0.0", phase: "pending" } },
  ], "2.0.0");

  const succeeded = jobs.records.get(created.id);
  assert.equal(succeeded.status, "succeeded");
  assert.equal(succeeded.rollout.deferredInstanceCount, 1);
  assert.equal(succeeded.rollout.pendingInstanceCount, 0);
});

test("instances stopped by a convergence failure degrade the rollout", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-rollout-failed-stop-"));
  const jobs = new NodeUpdateJobs(nodeAgentStorePaths(dataDir));
  jobs.init();
  const timestamp = new Date().toISOString();
  const created = jobs.create("node_1", {
    source: "npm",
    channel: "stable",
    currentVersion: "1.0.0",
    availableVersion: "2.0.0",
    runtimeArtifacts: [],
    impact: {
      runningInstanceCount: 1,
      stoppedInstanceCount: 0,
      activeInstanceCount: 0,
      restartInstanceCount: 1,
      runningInstanceIds: ["inst_failed"],
      stoppedInstanceIds: [],
      activeInstanceIds: [],
    },
    updateAvailable: true,
    supported: true,
    checkedAt: timestamp,
  });
  jobs.patch(created.id, { status: "converging-instances", rollout: { ...created.rollout, phase: "converging-instances", nodeVersion: "2.0.0" } });

  jobs.reconcileRollouts([{
    id: "inst_failed",
    status: "failed",
    ready: false,
    runtimeVersion: { desiredVersion: "2.0.0", actualVersion: "1.0.0", phase: "failed" },
  }], "2.0.0");

  const degraded = jobs.records.get(created.id);
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.rollout.failedInstanceCount, 1);
  assert.equal(degraded.rollout.deferredInstanceCount, 0);
});
