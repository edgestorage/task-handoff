const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AiSessionSummarySchema } = require("../packages/protocol/src/ai-sessions.ts");
const { controlPlaneStorePaths } = require("../packages/control-plane/src/control-plane/persistence/paths.ts");
const { AiSessionUnreadStore } = require("../packages/control-plane/src/control-plane/sessions/ai-session-unread-store.ts");

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-ai-unread-"));
}

function session(status, updatedAt) {
  return AiSessionSummarySchema.parse({
    id: "session_1",
    agent: "codex",
    status,
    phase: "unknown",
    startedAt: "2026-07-25T00:00:00.000Z",
    updatedAt,
    queue: {},
  });
}

function snapshot(item) {
  return {
    runningCount: item.status === "running" ? 1 : 0,
    waitingCount: item.status === "waiting" ? 1 : 0,
    staleCount: 0,
    sessions: [item],
    updatedAt: item.updatedAt,
  };
}

test("AI session unread state tracks only the latest round and persists", () => {
  const paths = controlPlaneStorePaths(tempDataDir());
  const changes = [];
  const store = new AiSessionUnreadStore(paths, { onChanged: (state) => changes.push(state) });
  store.init();

  const running1 = session("running", "2026-07-25T00:00:01.000Z");
  store.reconcile("instance_1", snapshot(running1));
  assert.equal(store.decorate("instance_1", snapshot(running1)).sessions[0].unread, false);

  const completed1 = session("idle", "2026-07-25T00:00:02.000Z");
  store.reconcile("instance_1", snapshot(completed1));
  assert.equal(store.decorate("instance_1", snapshot(completed1)).sessions[0].unread, true);
  assert.equal(changes.at(-1).unread, true);

  assert.equal(store.markRead("instance_1", "session_1", running1.updatedAt).unread, true);
  assert.equal(store.markRead("instance_1", "session_1", completed1.updatedAt).unread, false);

  store.reconcile("instance_1", snapshot(completed1));
  assert.equal(store.decorate("instance_1", snapshot(completed1)).sessions[0].unread, false);

  store.reconcile("instance_1", snapshot(session("running", "2026-07-25T00:00:03.000Z")));
  const failed2 = session("failed", "2026-07-25T00:00:04.000Z");
  store.reconcile("instance_1", snapshot(failed2));
  assert.equal(store.decorate("instance_1", snapshot(failed2)).sessions[0].unread, true);

  const restored = new AiSessionUnreadStore(paths);
  restored.init();
  assert.equal(restored.decorate("instance_1", snapshot(failed2)).sessions[0].unread, true);

  const running3 = session("running", "2026-07-25T00:00:05.000Z");
  restored.reconcile("instance_1", snapshot(running3));
  assert.equal(restored.decorate("instance_1", snapshot(running3)).sessions[0].unread, false);
});
