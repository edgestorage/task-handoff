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
  assert.equal(reduced.target.web, "http://127.0.0.1:32000");
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

test("unexpected runtime exit uses the canonical failed offline transition", () => {
  const current = instance({
    status: "running",
    health: "ok",
    connectionStatus: "online",
    agentStatus: "online",
    ready: true,
  });
  const reduced = reduceInstanceLifecycle(current, {
    type: "runtime-exited",
    error: new Error("process exited with code 17"),
  });

  assert.equal(reduced.status, "failed");
  assert.equal(reduced.health, "failed");
  assert.equal(reduced.connectionStatus, "offline");
  assert.equal(reduced.agentStatus, "offline");
  assert.equal(reduced.ready, false);
  assert.equal(reduced.workspace.error, "process exited with code 17");
});

test("stop request persists stopping intent before asynchronous shutdown", () => {
  const reduced = reduceInstanceLifecycle(instance({ status: "running", ready: true }), {
    type: "stop-requested",
  });
  assert.equal(reduced.status, "stopping");
  assert.equal(reduced.ready, false);
});

test("stop failure restores lifecycle-owned state from the pre-stop generation", () => {
  const baseline = instance({
    status: "running",
    health: "ok",
    connectionStatus: "online",
    agentStatus: "online",
    targetStatus: "reachable",
    uiAccessStatus: "reachable",
    ready: true,
    target: { strategy: "direct-port", status: "reachable", web: "http://127.0.0.1:32000" },
  });
  const stopping = reduceInstanceLifecycle(baseline, { type: "stop-requested" });
  const reduced = reduceInstanceLifecycle(stopping, { type: "stop-failed", baseline });

  assert.equal(reduced.status, "running");
  assert.equal(reduced.health, "ok");
  assert.equal(reduced.connectionStatus, "online");
  assert.equal(reduced.agentStatus, "online");
  assert.equal(reduced.ready, true);
  assert.equal(reduced.target.status, "reachable");
});

test("stop failure preserves a newer authoritative lifecycle report", () => {
  const baseline = instance({ status: "running", health: "ok", ready: true, stateRevision: 4 });
  const newer = instance({
    status: "running",
    health: "degraded",
    connectionStatus: "online",
    agentStatus: "online",
    ready: true,
    stateRevision: 6,
    lastHeartbeatAt: "2026-07-28T00:00:03.000Z",
  });
  const reduced = reduceInstanceLifecycle(newer, { type: "stop-failed", baseline });
  assert.equal(reduced, newer);
  assert.equal(reduced.health, "degraded");
});

test("a newer runtime exit generation invalidates an older start completion", () => {
  const baseline = instance({ status: "starting", stateRevision: 4 });
  const exited = instance({
    status: "failed",
    health: "failed",
    connectionStatus: "offline",
    agentStatus: "offline",
    ready: false,
    stateRevision: 5,
    workspace: { status: "pending", error: "child exited" },
  });
  const reduced = reduceInstanceLifecycle(exited, {
    type: "runtime-lifecycle-completed",
    baseline,
    observation: {
      status: "registering",
      connectionStatus: "online",
      runtime: { pid: 4242 },
    },
  });

  assert.equal(reduced.status, "failed");
  assert.equal(reduced.connectionStatus, "offline");
  assert.equal(reduced.workspace.error, "child exited");
  assert.equal(reduced.runtime.pid, undefined);
});
