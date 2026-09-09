const assert = require("node:assert/strict");
const test = require("node:test");
const { registerWorkspaceRequire } = require("./workspace-require.js");

registerWorkspaceRequire();

const { StoryIdleSessionRetentionCoordinator } = require("../packages/control-plane/src/node-agent/stories/idle-retention.ts");

function candidate(index) {
  return {
    sessionId: `root-${index}`,
    storyId: "story-1",
    status: "idle",
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  };
}

function coordinatorWith(fetchImpl, warn = () => undefined) {
  const instance = { id: "inst-1", registrationToken: "token" };
  return new StoryIdleSessionRetentionCoordinator(
    { listInstances: () => [instance] },
    {
      exists: async (storyId) => storyId === "story-1",
      retentionSettings: async () => ({ maxIdleAiSessions: 5 }),
    },
    fetchImpl,
    async () => "http://instance.test",
    warn,
  );
}

test("Story idle retention closes the oldest root tree when a sixth root becomes eligible", async () => {
  const requests = [];
  const roots = Array.from({ length: 6 }, (_, index) => candidate(index));
  const coordinator = coordinatorWith(async (url, init = {}) => {
    requests.push({ url, init });
    return init.method === "POST"
      ? { ok: true, status: 200 }
      : { ok: true, status: 200, json: async () => ({ data: roots }) };
  });

  await coordinator.reconcile();

  const closes = requests.filter((request) => request.init.method === "POST");
  assert.equal(closes.length, 1);
  assert.equal(new URL(closes[0].url).pathname, "/api/internal/node-agent/ai-sessions/root-0/close");
});

test("Story idle retention retries a failed root-tree close without consuming its quota", async () => {
  const roots = Array.from({ length: 6 }, (_, index) => candidate(index));
  const warnings = [];
  let attempts = 0;
  const coordinator = coordinatorWith(async (_url, init = {}) => {
    if (init.method !== "POST") return { ok: true, status: 200, json: async () => ({ data: roots }) };
    attempts += 1;
    return attempts === 1 ? { ok: false, status: 409 } : { ok: true, status: 200 };
  }, (data, message) => warnings.push({ data, message }));

  await coordinator.reconcile();
  await coordinator.reconcile();

  assert.equal(attempts, 2);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].data.sessionId, "root-0");
});
