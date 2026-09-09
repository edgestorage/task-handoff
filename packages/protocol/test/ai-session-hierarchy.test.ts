import assert from "node:assert/strict";
import test from "node:test";

import {
  aiSessionRetentionCandidates,
  aiSessionRootNode,
  aiSessionSubtreePostorder,
  countAiSessionRootTrees,
  deriveAiSessionForest,
  filterAiSessionForest,
  flattenAiSessionForest,
  type AiSessionHierarchyRecord,
} from "../src/ai-session-hierarchy.ts";

const at = (minute: number) => `2026-09-09T00:${String(minute).padStart(2, "0")}:00.000Z`;
const session = (
  id: string,
  providerSessionId: string,
  options: Partial<AiSessionHierarchyRecord> = {},
): AiSessionHierarchyRecord => ({
  id,
  agent: "codex",
  providerSessionId,
  status: "idle",
  updatedAt: at(0),
  ...options,
});
const child = (
  id: string,
  providerSessionId: string,
  parentProviderSessionId: string,
  options: Partial<AiSessionHierarchyRecord> = {},
) => session(id, providerSessionId, {
  lineage: { kind: "subagent", parentProviderSessionId },
  ...options,
});

test("AI Session forest derives multi-level children without mutating authoritative records", () => {
  const input = [
    child("grandchild", "provider-grandchild", "provider-child", { updatedAt: at(9) }),
    session("parent", "provider-parent", { updatedAt: at(1) }),
    child("child", "provider-child", "provider-parent", { updatedAt: at(5) }),
    session("fork", "provider-fork", { lineage: { kind: "fork", parentProviderSessionId: "provider-parent" }, updatedAt: at(2) }),
  ];
  const before = JSON.stringify(input);
  const forest = deriveAiSessionForest(input);

  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(forest.roots.map((node) => node.session.id), ["parent", "fork"]);
  assert.deepEqual(forest.roots[0].children.map((node) => node.session.id), ["child"]);
  assert.deepEqual(forest.roots[0].children[0].children.map((node) => node.session.id), ["grandchild"]);
  assert.equal(forest.roots[0].aggregateUpdatedAt, at(9));
  assert.equal(countAiSessionRootTrees(forest), 2);
  assert.equal(aiSessionRootNode(forest, "grandchild")?.session.id, "parent");
  assert.deepEqual(aiSessionSubtreePostorder(forest, "parent").map((node) => node.session.id), ["grandchild", "child", "parent"]);
});

test("AI Session forest orders each sibling level by the node's own last user message", () => {
  const forest = deriveAiSessionForest([
    session("parent", "provider-parent", { lastUserMessageAt: at(1), updatedAt: at(9) }),
    child("new-child", "provider-new-child", "provider-parent", { lastUserMessageAt: at(8), updatedAt: at(2) }),
    child("old-child", "provider-old-child", "provider-parent", { lastUserMessageAt: at(3), updatedAt: at(8) }),
    session("other-root", "provider-other-root", { lastUserMessageAt: at(5), updatedAt: at(1) }),
  ], { orderBy: "last-user-message" });

  assert.deepEqual(forest.roots.map((node) => node.session.id), ["other-root", "parent"]);
  assert.deepEqual(forest.nodesById.get("parent")?.children.map((node) => node.session.id), ["new-child", "old-child"]);
});

test("AI Session last-user-message order has a stable identity fallback", () => {
  const input = [
    session("z", "provider-z", { updatedAt: at(9) }),
    session("a", "provider-a", { updatedAt: at(1) }),
  ];

  assert.deepEqual(
    deriveAiSessionForest(input, { orderBy: "last-user-message" }).roots.map((node) => node.session.id),
    ["a", "z"],
  );
});

test("AI Session forest preserves orphans and breaks self references and cycles deterministically", () => {
  const input = [
    child("orphan", "provider-orphan", "missing"),
    child("self", "provider-self", "provider-self"),
    child("cycle-a", "provider-a", "provider-b"),
    child("cycle-b", "provider-b", "provider-a"),
    child("cross-agent", "provider-cross-agent", "provider-other", { agent: "codex" }),
    session("other-agent-parent", "provider-other", { agent: "opencode" }),
  ];
  const forest = deriveAiSessionForest(input);

  assert.deepEqual(new Set(forest.roots.map((node) => node.session.id)), new Set(input.map((entry) => entry.id)));
  assert.equal(forest.nodesById.size, input.length);
  assert.deepEqual(forest.diagnostics.map((entry) => [entry.sessionId, entry.code]), [
    ["orphan", "orphan-parent"],
    ["self", "self-parent"],
    ["cross-agent", "cross-agent-parent"],
    ["cycle-a", "cycle"],
    ["cycle-b", "cycle"],
  ]);
  assert.equal(countAiSessionRootTrees(forest), 1);
});

test("cross-instance Story collections never connect identical provider identities", () => {
  const forest = deriveAiSessionForest([
    session("parent-a", "provider-parent", { instanceId: "instance-a" }),
    child("child-a", "provider-child-a", "provider-parent", { instanceId: "instance-a" }),
    child("child-b", "provider-child-b", "provider-parent", { instanceId: "instance-b" }),
  ]);
  assert.equal(forest.nodesById.get("child-a")?.parentSessionId, "parent-a");
  assert.equal(forest.nodesById.get("child-b")?.parentSessionId, undefined);
  assert.equal(forest.diagnostics.find((entry) => entry.sessionId === "child-b")?.code, "cross-instance-parent");
});

test("filtering retains ancestor paths and retention counts only wholly idle root trees", () => {
  const forest = deriveAiSessionForest([
    session("old-root", "old-root", { updatedAt: at(1), completedAt: at(2) }),
    child("old-child", "old-child", "old-root", { updatedAt: at(3), completedAt: at(4) }),
    session("active-root", "active-root", { updatedAt: at(5) }),
    child("active-child", "active-child", "active-root", { status: "waiting", updatedAt: at(8) }),
    child("orphan", "orphan", "missing", { updatedAt: at(0) }),
  ]);
  const filtered = filterAiSessionForest(forest, (entry) => entry.id === "old-child");
  assert.deepEqual(filtered.visibleSessionIds, new Set(["old-root", "old-child"]));
  assert.deepEqual(filtered.expandedSessionIds, new Set(["old-root"]));
  assert.deepEqual(flattenAiSessionForest(forest, {
    visibleSessionIds: filtered.visibleSessionIds,
    forcedExpandedSessionIds: filtered.expandedSessionIds,
  }).map((entry) => [entry.node.session.id, entry.depth]), [["old-root", 0], ["old-child", 1]]);

  const candidates = aiSessionRetentionCandidates(forest);
  assert.deepEqual(candidates.map((candidate) => candidate.root.id), ["old-root"]);
  assert.deepEqual(candidates[0].sessionIds, ["old-child", "old-root"]);
  assert.equal(candidates[0].lastActiveAt, at(4));
});
