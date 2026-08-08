const assert = require("node:assert/strict");
const test = require("node:test");
const { createDesktopServiceLifecycle, desktopShutdownPolicy } = require("../src/desktop-service-lifecycle.cjs");

test("desktop shutdown policies preserve node-agent except for update or incomplete boot", () => {
  assert.deepEqual(desktopShutdownPolicy("quit"), { controlPlane: true, nodeAgent: false });
  assert.deepEqual(desktopShutdownPolicy("update"), { controlPlane: true, nodeAgent: true });
  assert.deepEqual(desktopShutdownPolicy("boot-failure", { nodeAgentReady: true }), { controlPlane: true, nodeAgent: false });
  assert.deepEqual(desktopShutdownPolicy("boot-failure", { nodeAgentReady: false }), { controlPlane: true, nodeAgent: true });
});

test("desktop lifecycle serializes shutdown and still attempts node-agent after a Control Plane failure", async () => {
  const calls = [];
  let releaseControlPlane;
  const lifecycle = createDesktopServiceLifecycle({
    stopControlPlane: () => new Promise((_resolve, reject) => { releaseControlPlane = () => { calls.push("control-plane"); reject(new Error("control-plane failed")); }; }),
    stopNodeAgent: async () => { calls.push("node-agent"); },
  });
  lifecycle.markRunning();
  const first = lifecycle.stop("update");
  const second = lifecycle.stop("quit");
  assert.equal(first, second);
  releaseControlPlane();
  await assert.rejects(first, /control-plane failed/);
  assert.deepEqual(calls, ["control-plane", "node-agent"]);
  assert.deepEqual(lifecycle.snapshot(), {
    phase: "stop-failed",
    reason: "update",
    requested: { controlPlane: true, nodeAgent: true },
    stopped: { controlPlane: false, nodeAgent: true },
  });
});

test("desktop lifecycle merges an update request into an in-flight normal quit", async () => {
  const calls = [];
  let releaseControlPlane;
  const lifecycle = createDesktopServiceLifecycle({
    stopControlPlane: () => new Promise((resolve) => {
      releaseControlPlane = () => { calls.push("control-plane"); resolve(); };
    }),
    stopNodeAgent: async () => { calls.push("node-agent"); },
  });
  const quit = lifecycle.stop("quit");
  const update = lifecycle.stop("update");
  assert.equal(quit, update);
  releaseControlPlane();
  await quit;
  assert.deepEqual(calls, ["control-plane", "node-agent"]);
  assert.deepEqual(lifecycle.snapshot(), {
    phase: "stopped",
    reason: "update",
    requested: { controlPlane: true, nodeAgent: true },
    stopped: { controlPlane: true, nodeAgent: true },
  });
});
