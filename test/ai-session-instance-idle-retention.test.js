const assert = require("node:assert/strict");
const test = require("node:test");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();

const { InstanceIdleSessionRetentionCoordinator } = require("../packages/control-plane/src/node-agent/stories/idle-retention.ts");

test("instance idle retention closes the oldest idle sessions above the 100-session budget", async () => {
  const instance = { id: "inst_1", registrationToken: "token" };
  const requests = [];
  const idle = Array.from({ length: 103 }, (_, index) => ({
    sessionId: `session-${index}`,
    status: "idle",
    completedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  const running = { sessionId: "session-running", status: "running", completedAt: undefined };

  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (init.method === "POST") {
      return { ok: true, status: 200 };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [...idle, running] }),
    };
  };

  const coordinator = new InstanceIdleSessionRetentionCoordinator(
    { listInstances: () => [instance] },
    fetchImpl,
    async () => "http://instance.test",
    () => undefined,
  );

  await coordinator.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const closed = requests
    .filter((request) => request.init.method === "POST")
    .map((request) => new URL(request.url).pathname.split("/").at(-2));
  assert.deepEqual(closed, ["session-0", "session-1", "session-2"]);
});

test("instance idle retention leaves instances at or below the 100-session budget untouched", async () => {
  const instance = { id: "inst_1", registrationToken: "token" };
  const requests = [];
  const idle = Array.from({ length: 100 }, (_, index) => ({
    sessionId: `session-${index}`,
    status: "idle",
    completedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));

  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    if (init.method === "POST") {
      return { ok: true, status: 200 };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: idle }),
    };
  };

  const coordinator = new InstanceIdleSessionRetentionCoordinator(
    { listInstances: () => [instance] },
    fetchImpl,
    async () => "http://instance.test",
    () => undefined,
  );

  await coordinator.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(requests.some((request) => request.init.method === "POST"), false);
});
