const assert = require("node:assert/strict");
const test = require("node:test");

const { ControlledInstanceSchema } = require("../packages/protocol/src/control-plane.ts");
const { reduceInstanceLifecycle } = require("../packages/control-plane/src/node-agent/instance-lifecycle-state.ts");

function instance(overrides = {}) {
  return ControlledInstanceSchema.parse({
    id: "inst_lifecycle",
    name: "lifecycle",
    source: { type: "local-folder", path: "/workspace" },
    sourceSnapshot: {},
    modelSelection: {},
    nodeId: "node_1",
    runtimeId: "runtime_1",
    status: "created",
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
    aiSessions: { runningCount: 0, waitingCount: 0, sessions: [], updatedAt: "2026-07-28T00:00:00.000Z" },
    runtime: { kind: "docker", containerId: "container_1", labels: {} },
    stateRevision: 1,
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    ...overrides,
  });
}

test("instance lifecycle reducer preserves an authoritative heartbeat that races runtime start", () => {
  const baseline = instance({ status: "starting", stateRevision: 4 });
  const heartbeat = instance({
    status: "running",
    health: "ok",
    connectionStatus: "online",
    agentStatus: "online",
    targetStatus: "reachable",
    uiAccessStatus: "reachable",
    ready: true,
    target: { strategy: "node-proxy", status: "reachable", web: "http://instance:8080" },
    workspace: { status: "ready", path: "/workspace" },
    apps: { runningCount: 2, problemCount: 0 },
    stateRevision: 6,
    lastHeartbeatAt: "2026-07-28T00:00:01.000Z",
  });

  const reduced = reduceInstanceLifecycle(heartbeat, {
    type: "runtime-lifecycle-completed",
    baseline,
    observation: {
      status: "registering",
      agentStatus: "unknown",
      target: { strategy: "direct-port", status: "reachable", web: "http://127.0.0.1:32000" },
      workspace: { status: "pending" },
      runtime: { containerName: "task-handoff-inst_lifecycle" },
    },
  }, "2026-07-28T00:00:02.000Z");

  assert.equal(reduced.status, "running");
  assert.equal(reduced.agentStatus, "online");
  assert.equal(reduced.ready, true);
  assert.equal(reduced.target.web, "http://instance:8080");
  assert.equal(reduced.workspace.status, "ready");
  assert.equal(reduced.runtime.containerName, "task-handoff-inst_lifecycle");
  assert.equal(reduced.apps.runningCount, 2);
});

test("instance lifecycle reducer applies runtime start facts when no newer heartbeat exists", () => {
  const baseline = instance({ status: "starting", stateRevision: 4 });
  const reduced = reduceInstanceLifecycle(baseline, {
    type: "runtime-lifecycle-completed",
    baseline,
    observation: {
      status: "registering",
      connectionStatus: "online",
      target: { strategy: "direct-port", status: "reachable", web: "http://127.0.0.1:32000" },
      runtime: { containerName: "task-handoff-inst_lifecycle" },
    },
  }, "2026-07-28T00:00:02.000Z");

  assert.equal(reduced.status, "registering");
  assert.equal(reduced.connectionStatus, "online");
  assert.equal(reduced.ready, false);
  assert.equal(reduced.target.web, "http://127.0.0.1:32000");
});

test("stop completion consumes the latest snapshot and only normalizes lifecycle-owned fields", () => {
  const latest = instance({
    status: "running",
    health: "ok",
    connectionStatus: "online",
    agentStatus: "online",
    ready: true,
    apps: { runningCount: 3, problemCount: 0 },
    workspace: { status: "ready", path: "/workspace/new" },
    target: { strategy: "direct-port", status: "reachable", web: "http://127.0.0.1:32000" },
    runtime: { kind: "local", pid: 4321, port: 32000, labels: { nonce: "fresh" } },
    stateRevision: 8,
  });
  const reduced = reduceInstanceLifecycle(latest, {
    type: "stop-completed",
  }, "2026-07-28T00:00:02.000Z");

  assert.equal(reduced.status, "stopped");
  assert.equal(reduced.agentStatus, "offline");
  assert.equal(reduced.ready, false);
  assert.equal(reduced.apps.runningCount, 3);
  assert.equal(reduced.workspace.path, "/workspace/new");
  assert.equal(reduced.target.status, "unknown");
  assert.equal(reduced.target.web, "http://127.0.0.1:32000");
  assert.equal(reduced.runtime.pid, 4321);
  assert.equal(reduced.runtime.labels.nonce, "fresh");
});

test("start failure has one canonical offline state transition", () => {
  const current = instance({ status: "starting", connectionStatus: "online", agentStatus: "online" });
  const reduced = reduceInstanceLifecycle(current, {
    type: "start-failed",
    error: new Error("launcher failed"),
  }, "2026-07-28T00:00:02.000Z");

  assert.equal(reduced.status, "failed");
  assert.equal(reduced.health, "failed");
  assert.equal(reduced.connectionStatus, "offline");
  assert.equal(reduced.agentStatus, "offline");
  assert.equal(reduced.ready, false);
  assert.equal(reduced.workspace.error, "launcher failed");
});
