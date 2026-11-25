import assert from "node:assert/strict";
import test from "node:test";

import { createControlPlaneAiSessionsApi } from "../src/ai-sessions.ts";

const now = "2026-11-25T00:00:00.000Z";

function api() {
  const paths = [];
  const transport = {
    async request(path) {
      paths.push(path);
      if (path.includes("/history")) return { data: { items: [] } };
      if (path.includes("/sync")) return { data: { updatedAt: now, instances: [] } };
      if (path.includes("sinceRevision=")) {
        return { data: { streamId: "stream", instanceId: "ins_1", sinceRevision: 1, latestRevision: 1, earliestRetainedRevision: 0, events: [] } };
      }
      return { data: { updatedAt: now, instances: [] } };
    },
  };
  return { paths, sessions: createControlPlaneAiSessionsApi(transport) };
}

test("current AI Session list, refresh, delta and sync queries request suggestions", async () => {
  const { paths, sessions } = api();
  await sessions.list();
  await sessions.refresh();
  await sessions.list(undefined, "ins_1");
  await sessions.delta("ins_1", "stream", 1);
  await sessions.sync([{ instanceId: "ins_1", streamId: "stream", revision: 1 }]);

  assert.equal(paths.length, 5);
  for (const path of paths) {
    const query = new URLSearchParams(new URL(path, "http://localhost").search);
    assert.equal(query.get("nextInputSuggestion"), "1", path);
    assert.equal(query.get("hierarchy"), "subagents", path);
  }
});

test("history remains on the subagent hierarchy only because it has no suggestion model", async () => {
  const { paths, sessions } = api();
  await sessions.history("ins_1");
  await sessions.historyDetail("ins_1", "ses_0000000000001");
  for (const path of paths) {
    assert.match(path, /hierarchy=subagents/);
    assert.doesNotMatch(path, /nextInputSuggestion/);
  }
});
