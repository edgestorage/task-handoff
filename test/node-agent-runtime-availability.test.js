const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RuntimeAvailabilityMonitor,
  runtimeAvailabilityIntervalMs,
} = require("../packages/control-plane/src/node-agent/runtime-availability.ts");

function dockerRuntime(overrides = {}) {
  return {
    id: "runtime_local_docker",
    nodeId: "node_1",
    name: "Local Docker",
    type: "docker",
    status: "unknown",
    accessStrategy: "direct-port",
    capabilities: {},
    labels: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

test("runtime availability interval falls back for missing or invalid configuration", () => {
  assert.equal(runtimeAvailabilityIntervalMs(undefined), 15_000);
  assert.equal(runtimeAvailabilityIntervalMs("  "), 15_000);
  assert.equal(runtimeAvailabilityIntervalMs("0"), 15_000);
  assert.equal(runtimeAvailabilityIntervalMs("nope"), 15_000);
  assert.equal(runtimeAvailabilityIntervalMs("250"), 1_000);
  assert.equal(runtimeAvailabilityIntervalMs("45000"), 45_000);
  assert.equal(runtimeAvailabilityIntervalMs(30_000), 30_000);
});

test("runtime availability monitor keeps the runtime record authoritative and only reports transitions", async () => {
  let current = dockerRuntime();
  let probe = {
    status: "offline",
    capabilities: { daemon: { status: "offline", error: "dial unix docker.sock: connect: no such file or directory" } },
  };
  const applied = [];
  const available = [];
  const unavailable = [];
  const monitor = new RuntimeAvailabilityMonitor({
    listTargets: () => [{ runtime: current, probe: async () => probe }],
    apply: (runtime, patch) => {
      applied.push(patch.status);
      current = { ...runtime, ...patch };
    },
    onAvailable: (next, previous) => available.push(`${previous.status}->${next.status}`),
    onUnavailable: (next, previous) => unavailable.push(`${previous.status}->${next.status}`),
  }, { intervalMs: 60_000 });

  try {
    await monitor.checkNow();
    assert.equal(current.status, "offline");
    assert.deepEqual(applied, ["offline"]);
    assert.deepEqual(unavailable, ["unknown->offline"]);

    // Docker comes back: the probe result is projected and recovery is announced.
    probe = { status: "online", capabilities: { daemon: { status: "online", hostPlatform: "darwin" } } };
    await monitor.checkNow();
    assert.equal(current.status, "online");
    assert.deepEqual(available, ["offline->online"]);

    // Unchanged probes stay write-free so the monitor cannot churn the runtime record.
    await monitor.checkNow();
    assert.deepEqual(applied, ["offline", "online"]);
    assert.deepEqual(available, ["offline->online"]);
  } finally {
    monitor.stop();
  }
});

test("runtime availability monitor isolates probe failures from the runtime record", async () => {
  const current = dockerRuntime({ status: "online" });
  const errors = [];
  let applies = 0;
  const monitor = new RuntimeAvailabilityMonitor({
    listTargets: () => [{
      runtime: current,
      probe: async () => { throw new Error("docker CLI missing"); },
    }],
    apply: () => { applies += 1; },
    onProbeError: (runtime, error) => errors.push([runtime.id, error.message]),
  }, { intervalMs: 60_000 });

  try {
    await monitor.checkNow();
    assert.equal(applies, 0);
    assert.deepEqual(errors, [["runtime_local_docker", "docker CLI missing"]]);
    assert.equal(current.status, "online");
  } finally {
    monitor.stop();
  }
});

test("runtime availability monitor probes a single runtime on demand for manual checks", async () => {
  let current = dockerRuntime();
  let probes = 0;
  const monitor = new RuntimeAvailabilityMonitor({
    listTargets: () => [{
      runtime: current,
      probe: async () => {
        probes += 1;
        return { status: "online", capabilities: { daemon: { status: "online" } } };
      },
    }],
    apply: (runtime, patch) => { current = { ...runtime, ...patch }; },
  }, { intervalMs: 60_000 });

  try {
    assert.equal(await monitor.checkRuntime("runtime_local_docker"), true);
    assert.equal(await monitor.checkRuntime("runtime_not_monitored"), false);
    assert.equal(probes, 1);
    assert.equal(current.status, "online");
  } finally {
    monitor.stop();
  }
});
