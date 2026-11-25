import assert from "node:assert/strict";
import test from "node:test";
import type { AiSessionSummary } from "@task-handoff/protocol/ai-sessions";
import { deriveAiSessionForest } from "@task-handoff/protocol/ai-session-hierarchy";
import { latestStorySessionForCreation, storySessionAttentionByKey, storySessionRootsInForest } from "../src/story-sessions.ts";

const startedAt = "2026-09-04T00:00:00.000Z";

function session(overrides: Partial<AiSessionSummary> & { id: string }): AiSessionSummary & { instanceId: string } {
  return {
    agent: "codex",
    creationSource: "ai-session",
    instanceId: "instance-1",
    phase: "unknown",
    providerSessionId: overrides.id,
    queue: { revision: 0, pendingCount: 0, items: [] },
    startedAt,
    status: "idle",
    subAgents: [],
    toolCallsSinceLastMessage: 0,
    unread: false,
    updatedAt: startedAt,
    ...overrides,
  };
}

const forest = (...sessions: (AiSessionSummary & { instanceId: string })[]) => deriveAiSessionForest(sessions, { orderBy: "last-user-message" });

test("Story roots are the newest first and stay scoped to the Story node", () => {
  const roots = storySessionRootsInForest(forest(
    session({ id: "old", storyId: "story-1", lastUserMessageAt: "2026-09-04T00:01:00.000Z" }),
    session({ id: "new", storyId: "story-1", lastUserMessageAt: "2026-09-04T00:05:00.000Z" }),
    session({ id: "other-story", storyId: "story-2", lastUserMessageAt: "2026-09-04T00:09:00.000Z" }),
    session({ id: "other-node", instanceId: "instance-2", storyId: "story-1", lastUserMessageAt: "2026-09-04T00:09:00.000Z" }),
  ), "story-1", ["instance-1"]);

  assert.deepEqual(roots.map((root) => root.session.id), ["new", "old"]);
});

test("closed Story sessions never seed creation defaults", () => {
  const snapshot = forest(
    session({ id: "closed", storyId: "story-1", lastUserMessageAt: "2026-09-04T00:09:00.000Z", actions: { send: false, close: false } }),
    session({ id: "open", storyId: "story-1", lastUserMessageAt: "2026-09-04T00:02:00.000Z" }),
  );

  assert.equal(latestStorySessionForCreation(snapshot, "story-1", ["instance-1"])?.id, "open");
  assert.deepEqual(storySessionRootsInForest(snapshot, "story-1", ["instance-1"]).map((root) => root.session.id), ["closed", "open"]);
});

test("derived sessions inherit through their root, not their own activity", () => {
  const snapshot = forest(
    session({ id: "root", storyId: "story-1", providerSessionId: "provider-root", lastUserMessageAt: "2026-09-04T00:01:00.000Z" }),
    session({
      id: "child",
      storyId: "story-1",
      lineage: { kind: "subagent", parentProviderSessionId: "provider-root" },
      lastUserMessageAt: "2026-09-04T00:10:00.000Z",
    }),
  );

  assert.equal(latestStorySessionForCreation(snapshot, "story-1", ["instance-1"])?.id, "root");
});

test("a Story without a usable session yields no defaults", () => {
  assert.equal(latestStorySessionForCreation(forest(session({ id: "unassigned" })), "story-1", ["instance-1"]), undefined);
  assert.equal(latestStorySessionForCreation(forest(session({ id: "elsewhere", storyId: "story-1" })), "story-1", []), undefined);
});

test("Story attention includes hidden descendants and chooses the highest status for each owner node", () => {
  const root = session({ id: "root", storyId: "shared", status: "running", unread: true });
  const failed = session({ id: "failed-root", storyId: "shared", status: "failed" });
  const child = session({
    id: "child",
    lineage: { kind: "subagent", parentProviderSessionId: failed.providerSessionId },
    status: "waiting",
    phase: "approval",
  });
  const otherNode = session({ id: "other-node", storyId: "shared", instanceId: "instance-2", unread: true });
  const plainWaiting = session({ id: "plain-waiting", storyId: "plain-waiting", status: "waiting" });
  const unassigned = session({ id: "unassigned", status: "failed" });
  const nodeIds = new Map([["instance-1", "node-a"], ["instance-2", "node-b"]]);
  const nodeId = (instanceId: string) => nodeIds.get(instanceId);

  assert.deepEqual(storySessionAttentionByKey(forest(root, failed, child, otherNode, plainWaiting, unassigned), nodeId), new Map([
    ["node-a:shared", "approval"], ["node-b:shared", "unread"],
  ]));
  assert.equal(storySessionAttentionByKey(forest(root, failed), nodeId).get("node-a:shared"), "failed");
  assert.equal(storySessionAttentionByKey(forest(root), nodeId).get("node-a:shared"), "running");
  assert.equal(storySessionAttentionByKey(forest(plainWaiting), nodeId).size, 0);
});
