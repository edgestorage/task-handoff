const assert = require("node:assert/strict");
const test = require("node:test");
const { createDesktopServiceSupervisor } = require("../src/desktop-service-supervisor.cjs");

test("desktop service supervisor publishes authoritative component and endpoint state", () => {
  const supervisor = createDesktopServiceSupervisor();
  const states = [];
  const unsubscribe = supervisor.subscribe((state) => states.push(state));
  supervisor.markStarting();
  supervisor.markNodeAgentRunning();
  supervisor.markRunning("http://127.0.0.1:18083");
  assert.equal(supervisor.endpoint(), "http://127.0.0.1:18083");
  assert.deepEqual(supervisor.snapshot(), {
    phase: "running",
    controlPlane: "running",
    nodeAgent: "running",
    endpoint: "http://127.0.0.1:18083",
    error: undefined,
  });
  assert.equal(states.length, 4);
  unsubscribe();
});

test("unexpected component exit degrades the service without discarding its endpoint", () => {
  const supervisor = createDesktopServiceSupervisor();
  supervisor.markStarting();
  supervisor.markRunning("http://127.0.0.1:18081");
  supervisor.markComponentStopped("control-plane", "control plane exited");
  assert.deepEqual(supervisor.snapshot(), {
    phase: "degraded",
    controlPlane: "failed",
    nodeAgent: "running",
    endpoint: "http://127.0.0.1:18081",
    error: "control plane exited",
  });
  supervisor.markStopping();
  supervisor.markComponentStopped("node-agent");
  supervisor.markStopped();
  assert.equal(supervisor.snapshot().phase, "stopped");
});
