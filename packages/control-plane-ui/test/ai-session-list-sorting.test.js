import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  aiSessionLastUserMessageTime,
  sortedAiSessionsByLastUserMessage,
} from "../src/apps/control-plane/useInstanceSessions.ts";

const panel = fs.readFileSync(new URL("../src/apps/control-plane/instance-detail/AiSessionPanel.vue", import.meta.url), "utf8");

function session(id, status, turns = [], overrides = {}) {
  return {
    id,
    agent: "codex",
    cwd: "/workspace",
    status,
    phase: "unknown",
    turns,
    toolCallsSinceLastMessage: 0,
    queue: { pendingCount: 0, items: [] },
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function userTurn(id, startedAt, overrides = {}) {
  return {
    id,
    userPrompt: `Prompt ${id}`,
    status: "completed",
    revision: 0,
    startedAt,
    ...overrides,
  };
}

test("instance AI session list keeps status priority ahead of user message recency", () => {
  const recentIdle = session("recent-idle", "idle", [userTurn("idle", "2026-07-18T12:00:00.000Z")]);
  const oldWaiting = session("old-waiting", "waiting", [userTurn("waiting", "2026-07-17T12:00:00.000Z")]);

  assert.deepEqual(
    sortedAiSessionsByLastUserMessage([recentIdle, oldWaiting]).map(({ id }) => id),
    ["old-waiting", "recent-idle"],
  );
});

test("instance AI session list can sort directly by user message recency", () => {
  const recentIdle = session("recent-idle", "idle", [userTurn("idle", "2026-07-18T12:00:00.000Z")]);
  const oldWaiting = session("old-waiting", "waiting", [userTurn("waiting", "2026-07-17T12:00:00.000Z")]);

  assert.deepEqual(
    sortedAiSessionsByLastUserMessage([recentIdle, oldWaiting], false).map(({ id }) => id),
    ["recent-idle", "old-waiting"],
  );
});

test("instance AI sessions with the same status sort by the last user message descending", () => {
  const older = session("older", "idle", [userTurn("older", "2026-07-18T10:00:00.000Z")]);
  const newer = session("newer", "idle", [
    userTurn("newer-1", "2026-07-18T09:00:00.000Z"),
    userTurn("newer-2", "2026-07-18T11:00:00.000Z", { updatedAt: "2026-07-18T14:00:00.000Z" }),
  ]);

  assert.deepEqual(
    sortedAiSessionsByLastUserMessage([older, newer]).map(({ id }) => id),
    ["newer", "older"],
  );
});

test("assistant and session updates do not change last user message time", () => {
  const value = session("stable", "running", [
    userTurn("turn", "2026-07-18T08:00:00.000Z", {
      lastMessage: "Later assistant response",
      updatedAt: "2026-07-18T16:00:00.000Z",
      completedAt: "2026-07-18T16:00:00.000Z",
    }),
  ], { updatedAt: "2026-07-18T17:00:00.000Z" });

  assert.equal(aiSessionLastUserMessageTime(value), Date.parse("2026-07-18T08:00:00.000Z"));
});

test("missing user message timestamps sort after known timestamps with a stable fallback", () => {
  const known = session("known", "idle", [userTurn("known", "2026-07-18T08:00:00.000Z")]);
  const unknownB = session("unknown-b", "idle", [userTurn("unknown-b", undefined)]);
  const unknownA = session("unknown-a", "idle", [userTurn("unknown-a", "invalid")]);

  assert.deepEqual(
    sortedAiSessionsByLastUserMessage([unknownB, known, unknownA]).map(({ id }) => id),
    ["known", "unknown-a", "unknown-b"],
  );
});

test("instance detail sidebar uses the local user-message sorter", () => {
  assert.match(panel, /sortedAiSessionsByLastUserMessage\(filteredSessions\.value, sortSessionsByStatus\.value\)/);
  assert.match(panel, />\s*Sort by status\s*</);
  assert.match(panel, /SORT_BY_STATUS_STORAGE_KEY/);
});
