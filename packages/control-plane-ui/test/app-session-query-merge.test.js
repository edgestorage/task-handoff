import assert from "node:assert/strict";
import test from "node:test";
import { mergeAppSessionQueryData } from "../src/api/appSessionMerge.ts";

function entry(instanceId, streamId, revision, sessionIds) {
  const updatedAt = `2026-09-23T15:46:${String(revision).padStart(2, "0")}.000Z`;
  return {
    instanceId,
    streamId,
    revision,
    lastEventAt: updatedAt,
    appSessions: {
      runningCount: sessionIds.length,
      problemCount: 0,
      sessions: sessionIds.map((id) => ({ id, status: "running", bindings: [] })),
      updatedAt,
    },
  };
}

test("an in-flight App Session response cannot overwrite a newer stream revision", () => {
  const current = { updatedAt: "2026-09-23T15:46:11.000Z", instances: [entry("instance-a", "stream-a", 11, ["app-a"])] };
  const stale = { updatedAt: "2026-09-23T15:46:10.000Z", instances: [entry("instance-a", "stream-a", 10, ["app-a", "app-stopped"])] };

  const merged = mergeAppSessionQueryData(current, stale);

  assert.equal(merged.instances[0].revision, 11);
  assert.deepEqual(merged.instances[0].appSessions.sessions.map((session) => session.id), ["app-a"]);
});

test("App Session query data accepts newer revisions and stream resets", () => {
  const current = { updatedAt: "2026-09-23T15:46:11.000Z", instances: [entry("instance-a", "stream-a", 11, ["app-a"])] };
  const newer = { updatedAt: "2026-09-23T15:46:12.000Z", instances: [entry("instance-a", "stream-a", 12, ["app-a", "app-b"])] };
  const reset = { updatedAt: "2026-09-23T15:46:13.000Z", instances: [entry("instance-a", "stream-b", 1, [])] };

  assert.equal(mergeAppSessionQueryData(current, newer), newer);
  assert.equal(mergeAppSessionQueryData(current, reset), reset);
});
