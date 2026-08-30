const assert = require("node:assert/strict");
const test = require("node:test");
const {
  DESKTOP_NODE_AGENT_GRACEFUL_TIMEOUT_MS,
  ensureDesktopNodeAgent,
  inspectExistingDesktopControlPlane,
  inspectStartedDesktopControlPlane,
  inspectExistingDesktopNodeAgent,
  stopExistingDesktopNodeAgent,
} = require("../src/node-agent-handoff.cjs");

test("desktop node-agent graceful timeout covers the Local Runtime shutdown window", () => {
  assert.equal(DESKTOP_NODE_AGENT_GRACEFUL_TIMEOUT_MS, 20_000);
  assert.ok(DESKTOP_NODE_AGENT_GRACEFUL_TIMEOUT_MS > 12_000);
});

function owner(overrides = {}) {
  return {
    component: "node-agent",
    pid: 1234,
    dataDir: "/desktop/node-agent",
    token: "owner-token",
    startIdentity: "test:owner-start",
    ...overrides,
  };
}

test("desktop detects a verified Control Plane before replacing its node agent", () => {
  const existing = owner({ component: "control-plane", dataDir: "/desktop/control-plane" });
  assert.deepEqual(inspectExistingDesktopControlPlane({
    readOwner: () => existing,
    isAlive: () => true,
    processIdentity: () => existing.startIdentity,
  }), { status: "running", owner: existing });
  assert.equal(inspectExistingDesktopControlPlane({
    readOwner: () => existing,
    isAlive: () => true,
    processIdentity: () => "test:reused-pid",
  }).status, "stale");
});

test("desktop identifies the Control Plane it started from the singleton owner", () => {
  const existing = owner({
    component: "control-plane",
    dataDir: "/desktop/control-plane",
    host: "127.0.0.1",
    port: 18081,
  });
  assert.deepEqual(inspectStartedDesktopControlPlane({
    pid: existing.pid,
    dataDir: existing.dataDir,
    host: existing.host,
    port: existing.port,
    inspectOptions: {
      readOwner: () => existing,
      isAlive: () => true,
      processIdentity: () => existing.startIdentity,
    },
  }), { status: "running", owner: existing });
});

test("desktop rejects a Control Plane singleton owned by another launch", () => {
  const existing = owner({
    component: "control-plane",
    dataDir: "/server/control-plane",
    host: "127.0.0.1",
    port: 18081,
  });
  assert.equal(inspectStartedDesktopControlPlane({
    pid: 5678,
    dataDir: "/desktop/control-plane",
    host: existing.host,
    port: existing.port,
    inspectOptions: {
      readOwner: () => existing,
      isAlive: () => true,
      processIdentity: () => existing.startIdentity,
    },
  }).status, "foreign");
});

test("desktop node-agent ensure state machine replaces an existing verified owner", async () => {
  const existing = owner();
  const child = { pid: 5678 };
  const health = { listener: { port: 18092 } };
  let alive = true;
  const signals = [];
  const result = await ensureDesktopNodeAgent({
    dataDir: existing.dataDir,
    inspectOptions: {
      readOwner: () => alive ? existing : undefined,
      isAlive: () => alive,
      processIdentity: () => existing.startIdentity,
    },
    stopOptions: {
      signal: (_pid, signal) => {
        signals.push(signal);
        alive = false;
      },
      wait: async () => {},
    },
    start: () => child,
    waitUntilReady: async (startedChild) => {
      assert.equal(startedChild, child);
      return health;
    },
  });
  assert.deepEqual(result, { action: "started", child, health });
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("desktop node-agent ensure state machine starts when no owner exists", async () => {
  const child = { pid: 5678 };
  const health = { listener: { port: 18092 } };
  const result = await ensureDesktopNodeAgent({
    dataDir: "/desktop/node-agent",
    inspectOptions: { readOwner: () => undefined },
    start: () => child,
    waitUntilReady: async (startedChild) => {
      assert.equal(startedChild, child);
      return health;
    },
  });
  assert.deepEqual(result, { action: "started", child, health });
});

test("desktop stops the previous node agent for its own data directory", async () => {
  const existing = owner();
  let alive = true;
  const signals = [];
  const result = await stopExistingDesktopNodeAgent({
    dataDir: "/desktop/node-agent",
    readOwner: () => alive ? existing : undefined,
    isAlive: () => alive,
    processIdentity: () => existing.startIdentity,
    signal: (_pid, signal) => {
      signals.push(signal);
      alive = false;
    },
    wait: async () => {},
  });

  assert.equal(result.status, "stopped");
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("desktop never stops a node agent owned by another data directory", async () => {
  const existing = owner({ dataDir: "/server/node-agent" });
  const signals = [];
  const result = await stopExistingDesktopNodeAgent({
    dataDir: "/desktop/node-agent",
    readOwner: () => existing,
    isAlive: () => true,
    processIdentity: () => existing.startIdentity,
    signal: (_pid, signal) => signals.push(signal),
  });

  assert.equal(result.status, "foreign");
  assert.deepEqual(signals, []);
});

test("desktop force-stops the same owner when graceful shutdown times out", async () => {
  const existing = owner();
  let alive = true;
  const signals = [];
  const result = await stopExistingDesktopNodeAgent({
    dataDir: "/desktop/node-agent",
    readOwner: () => alive ? existing : undefined,
    isAlive: () => alive,
    processIdentity: () => existing.startIdentity,
    signal: (_pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") alive = false;
    },
    wait: async () => {},
    gracefulTimeoutMs: 0,
    forceTimeoutMs: 1,
  });

  assert.equal(result.status, "forced");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("desktop does not force a replacement lock owner", async () => {
  const existing = owner();
  const replacement = owner({ pid: 5678, token: "replacement-token" });
  let reads = 0;
  const signals = [];
  const result = await stopExistingDesktopNodeAgent({
    dataDir: "/desktop/node-agent",
    readOwner: () => reads++ === 0 ? existing : replacement,
    isAlive: () => true,
    processIdentity: () => existing.startIdentity,
    signal: (_pid, signal) => signals.push(signal),
    wait: async () => {},
    gracefulTimeoutMs: 0,
  });

  assert.equal(result.status, "stopped");
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("desktop never signals a reused pid from a stale node-agent lock", async () => {
  const existing = owner();
  const signals = [];
  const result = await stopExistingDesktopNodeAgent({
    dataDir: "/desktop/node-agent",
    readOwner: () => existing,
    isAlive: () => true,
    processIdentity: () => "test:replacement-start",
    signal: (_pid, signal) => signals.push(signal),
  });

  assert.equal(result.status, "stale");
  assert.deepEqual(signals, []);
});

test("desktop refuses to signal an owner whose process identity cannot be read", async () => {
  const existing = owner();
  const signals = [];
  const result = await stopExistingDesktopNodeAgent({
    dataDir: "/desktop/node-agent",
    readOwner: () => existing,
    isAlive: () => true,
    processIdentity: () => undefined,
    signal: (_pid, signal) => signals.push(signal),
  });

  assert.equal(result.status, "unverified");
  assert.deepEqual(signals, []);
});

test("desktop revalidates process identity before forcing a timed-out owner", async () => {
  const existing = owner();
  const signals = [];
  let identityReads = 0;
  const result = await stopExistingDesktopNodeAgent({
    dataDir: "/desktop/node-agent",
    readOwner: () => existing,
    isAlive: () => true,
    processIdentity: () => identityReads++ === 0 ? existing.startIdentity : "test:replacement-start",
    signal: (_pid, signal) => signals.push(signal),
    wait: async () => {},
    gracefulTimeoutMs: 0,
  });

  assert.equal(result.status, "stopped");
  assert.deepEqual(signals, ["SIGTERM"]);
});
