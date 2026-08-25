import assert from "node:assert/strict";
import test from "node:test";
import { watch, watchEffect } from "vue";

import {
  createStreamingMessagesStore,
  streamingMessageKey,
  useStreamingMessagesStore,
} from "../src/apps/control-plane/useStreamingMessagesStore.ts";

const identity = (overrides = {}) => ({
  instanceId: "instance_1",
  sessionId: "session_1",
  turnId: "turn_1",
  itemId: "item_1",
  ...overrides,
});

const session = (overrides = {}) => ({
  id: "session_1",
  agent: "codex",
  activeTurnId: "turn_1",
  status: "running",
  phase: "responding",
  queue: { pendingCount: 0, items: [] },
  startedAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:01.000Z",
  turns: [{
    id: "turn_1",
    status: "running",
    revision: 1,
    lastMessage: "authoritative",
    updatedAt: "2026-07-18T00:00:01.000Z",
  }],
  lastMessage: "authoritative",
  ...overrides,
});

const meta = (overrides = {}) => ({
  instanceId: "instance_1",
  streamId: "stream_1",
  revision: 1,
  traceId: "trace_1",
  generatedAt: "2026-07-18T00:00:01.000Z",
  reason: "provider-event",
  ...overrides,
});

test("message keys preserve all four identity dimensions without delimiter collisions", () => {
  const left = streamingMessageKey(identity({ sessionId: "a\u0000b", turnId: "c" }));
  const right = streamingMessageKey(identity({ sessionId: "a", turnId: "b\u0000c" }));

  assert.notEqual(left, right);
  assert.equal(left, streamingMessageKey(identity({ sessionId: "a\u0000b", turnId: "c" })));
});

test("received text advances directly for the renderer", () => {
  const store = createStreamingMessagesStore();
  const id = identity();
  const entry = store.appendDelta({ identity: id, streamId: "stream_1", delta: "hello" });

  assert.equal(entry.value.receivedText, "hello");
  assert.equal(entry.value.status, "streaming");
});

test("authoritative completion corrects received text and sets its terminal state", () => {
  const store = createStreamingMessagesStore();
  const id = identity();
  const entry = store.appendDelta({ identity: id, streamId: "stream_1", delta: "helo" });
  store.settleAuthoritative({
    identity: id,
    streamId: "stream_1",
    text: "hello",
    status: "complete",
    generatedAt: "2026-07-18T00:00:02.000Z",
  });
  assert.equal(entry.value.receivedText, "hello");
  assert.equal(entry.value.status, "complete");
  assert.equal(entry.value.settledAt, "2026-07-18T00:00:02.000Z");
});

test("a new instance stream discards every stale message projection", () => {
  const store = createStreamingMessagesStore();
  const first = identity();
  const second = identity({ sessionId: "session_2", itemId: "item_2" });
  store.appendDelta({ identity: first, streamId: "stream_1", delta: "old" });
  store.appendDelta({ identity: second, streamId: "stream_1", delta: "also old" });

  assert.equal(store.replaceStream("instance_1", "stream_2"), true);
  assert.equal(store.message(first), undefined);
  assert.equal(store.message(second), undefined);
  assert.equal(store.size(), 0);

  const current = store.appendDelta({ identity: first, streamId: "stream_2", delta: "new" });
  assert.equal(current.value.receivedText, "new");
});

test("instance cleanup releases messages, active refs, indexes, and stream identity", () => {
  const store = createStreamingMessagesStore();
  const id = identity();
  const previousActive = store.activeMessage("instance_1", "session_1");
  store.appendDelta({ identity: id, streamId: "stream_1", delta: "old" });

  store.cleanupInstance("instance_1");

  assert.equal(previousActive.value, undefined);
  assert.equal(store.message(id), undefined);
  assert.equal(store.size(), 0);
  const nextActive = store.activeMessage("instance_1", "session_1");
  assert.notStrictEqual(nextActive, previousActive);
  const next = store.appendDelta({ identity: id, streamId: "stream_1", delta: "new" });
  assert.equal(next.value.receivedText, "new");
  assert.equal(nextActive.value, next);
});

test("a reconnect snapshot restores the authoritative item and its later delta continues it", () => {
  const store = createStreamingMessagesStore();
  const oldId = identity();
  store.appendDelta({ identity: oldId, streamId: "stream_1", delta: "stale" });

  store.applySnapshot({
    meta: meta({ streamId: "stream_2" }),
    snapshot: {
      runningCount: 1,
      waitingCount: 0,
      staleCount: 0,
      updatedAt: "2026-07-18T00:00:01.000Z",
      sessions: [session({
        lastMessage: "restored",
        lastMessageItemId: "item_1",
        turns: [{ id: "turn_1", status: "running", revision: 2, lastMessage: "restored", lastMessageItemId: "item_1" }],
      })],
    },
  });

  const restored = store.message(oldId);
  assert.equal(restored.value.receivedText, "restored");

  const continued = store.appendDelta({ identity: oldId, streamId: "stream_2", delta: " text" });
  assert.equal(continued.value.receivedText, "restored text");
  assert.equal(store.size(), 1);
});

test("the first assistant item after a reconnect does not inherit the previous item text", () => {
  const store = createStreamingMessagesStore();
  const previous = identity({ itemId: "item_previous" });
  const next = identity({ itemId: "item_next" });

  store.applySnapshot({
    meta: meta({ streamId: "stream_2" }),
    snapshot: {
      runningCount: 1,
      waitingCount: 0,
      staleCount: 0,
      updatedAt: "2026-07-18T00:00:01.000Z",
      sessions: [session({
        lastMessage: "previous response",
        lastMessageItemId: "item_previous",
        turns: [{ id: "turn_1", status: "running", revision: 2, lastMessage: "previous response", lastMessageItemId: "item_previous" }],
      })],
    },
  });

  const current = store.appendDelta({ identity: next, streamId: "stream_2", delta: "next response" });
  assert.equal(store.message(previous).value.receivedText, "previous response");
  assert.equal(current.value.receivedText, "next response");
  assert.equal(store.activeMessage("instance_1", "session_1").value, current);
});

test("a snapshot without an item identity is not guessed to be the next delta item", () => {
  const store = createStreamingMessagesStore();
  const next = identity({ itemId: "item_next" });

  store.applySnapshot({
    meta: meta({ streamId: "stream_2" }),
    snapshot: {
      runningCount: 1,
      waitingCount: 0,
      staleCount: 0,
      updatedAt: "2026-07-18T00:00:01.000Z",
      sessions: [session({
        lastMessage: "unidentified response",
        turns: [{ id: "turn_1", status: "running", revision: 2, lastMessage: "unidentified response" }],
      })],
    },
  });

  const current = store.appendDelta({ identity: next, streamId: "stream_2", delta: "new item" });
  assert.equal(current.value.receivedText, "new item");
});

test("snapshot and patch settle existing message identities while removed events clean sessions", () => {
  const store = createStreamingMessagesStore();
  const id = identity();
  const entry = store.appendDelta({ identity: id, streamId: "stream_1", delta: "draft" });

  store.applySnapshot({
    meta: meta(),
    snapshot: {
      runningCount: 0,
      waitingCount: 0,
      staleCount: 0,
      updatedAt: "2026-07-18T00:00:01.000Z",
      sessions: [session({
        status: "idle",
        turns: [{ id: "turn_1", status: "completed", revision: 2, lastMessage: "final", lastMessageItemId: "item_1" }],
        lastMessage: "final",
        lastMessageItemId: "item_1",
      })],
    },
  });
  assert.equal(entry.value.receivedText, "final");
  assert.equal(entry.value.status, "complete");

  store.applyPatch({
    meta: meta({ revision: 2 }),
    upserted: [session({ status: "failed", lastMessage: "final error", lastMessageItemId: "item_1", turns: undefined })],
    removed: [],
  });
  assert.equal(entry.value.receivedText, "final");
  assert.equal(entry.value.status, "failed");

  store.applyRemoved({
    meta: meta({ revision: 3 }),
    sessionIds: ["session_1"],
    expiresAt: "2026-07-18T01:00:00.000Z",
  });
  assert.equal(store.message(id), undefined);
});

test("terminal compact list projection preserves the complete streamed markdown", () => {
  const store = createStreamingMessagesStore();
  const id = identity();
  const completeMarkdown = "Result\n\n- first\n- second\n\n```js\nrun();\n```";
  const entry = store.appendDelta({
    identity: id,
    streamId: "stream_1",
    delta: completeMarkdown,
  });

  store.applyPatch({
    meta: meta({ revision: 2, generatedAt: "2026-07-18T00:00:02.000Z" }),
    upserted: [session({
      status: "idle",
      turns: undefined,
      lastMessage: "Result - first - second ```js run(); ```",
      lastMessageItemId: "item_1",
    })],
    removed: [],
  });

  assert.equal(entry.value.receivedText, completeMarkdown);
  assert.equal(entry.value.status, "complete");
  assert.equal(entry.value.settledAt, "2026-07-18T00:00:02.000Z");
});

test("updating one message preserves unrelated refs, values, and subscriptions", () => {
  const store = createStreamingMessagesStore();
  const activeId = identity();
  const unrelatedId = identity({ instanceId: "instance_2", sessionId: "session_2", itemId: "item_2" });
  const active = store.appendDelta({ identity: activeId, streamId: "stream_1", delta: "a" });
  const unrelated = store.appendDelta({ identity: unrelatedId, streamId: "stream_2", delta: "stable" });
  const unrelatedValue = unrelated.value;
  let unrelatedNotifications = 0;
  const stop = watch(unrelated, () => { unrelatedNotifications += 1; }, { flush: "sync" });

  store.appendDelta({ identity: activeId, streamId: "stream_1", delta: "b" });

  assert.equal(store.message(activeId), active);
  assert.equal(store.message(unrelatedId), unrelated);
  assert.equal(unrelated.value, unrelatedValue);
  assert.equal(unrelatedNotifications, 0);
  stop();
});

test("session active refs notify only when their own active item changes", () => {
  const store = createStreamingMessagesStore();
  const firstSessionItem = identity();
  const secondSessionItem = identity({ sessionId: "session_2", itemId: "item_2" });
  const firstActive = store.activeMessage("instance_1", "session_1");
  const secondActive = store.activeMessage("instance_1", "session_2");
  let firstNotifications = 0;
  let secondNotifications = 0;
  const stopFirst = watch(firstActive, () => { firstNotifications += 1; }, { flush: "sync" });
  const stopSecond = watch(secondActive, () => { secondNotifications += 1; }, { flush: "sync" });

  const first = store.appendDelta({ identity: firstSessionItem, streamId: "stream_1", delta: "a" });
  store.appendDelta({ identity: secondSessionItem, streamId: "stream_1", delta: "stable" });
  assert.equal(firstActive.value, first);
  assert.equal(firstNotifications, 1);
  assert.equal(secondNotifications, 1);

  store.appendDelta({ identity: firstSessionItem, streamId: "stream_1", delta: "b" });
  assert.equal(firstNotifications, 1);
  assert.equal(secondNotifications, 1);

  const next = store.appendDelta({
    identity: identity({ itemId: "item_next" }),
    streamId: "stream_1",
    delta: "next",
  });
  assert.equal(firstActive.value, next);
  assert.equal(firstNotifications, 2);
  assert.equal(secondNotifications, 1);

  store.cleanupSession("instance_1", "session_1");
  assert.equal(firstActive.value, undefined);
  assert.equal(firstNotifications, 3);
  assert.equal(secondNotifications, 1);
  assert.notStrictEqual(store.activeMessage("instance_1", "session_1"), firstActive);
  stopFirst();
  stopSecond();
});

test("different assistant items in the same turn never share accumulated text", () => {
  const store = createStreamingMessagesStore();
  const first = identity({ itemId: "item_first" });
  const second = identity({ itemId: "item_second" });

  store.appendDelta({ identity: first, streamId: "stream_1", delta: "first" });
  const next = store.appendDelta({ identity: second, streamId: "stream_1", delta: "second" });

  assert.equal(store.message(first).value.receivedText, "first");
  assert.equal(next.value.receivedText, "second");
  assert.equal(store.activeMessage("instance_1", "session_1").value, next);
});

test("a stale turn snapshot cannot overwrite a newer assistant item", () => {
  const store = createStreamingMessagesStore();
  const first = identity({ itemId: "item_first" });
  const second = identity({ itemId: "item_second" });
  store.appendDelta({ identity: first, streamId: "stream_1", delta: "first response" });
  const current = store.appendDelta({ identity: second, streamId: "stream_1", delta: "second response" });

  store.applySnapshot({
    meta: meta({ generatedAt: "2026-07-18T00:00:02.000Z" }),
    snapshot: {
      runningCount: 1,
      waitingCount: 0,
      staleCount: 0,
      updatedAt: "2026-07-18T00:00:02.000Z",
      sessions: [session({
        turns: [{ id: "turn_1", status: "running", revision: 2, lastMessage: "first response", lastMessageItemId: "item_first" }],
        lastMessage: "first response",
        lastMessageItemId: "item_first",
      })],
    },
  });

  assert.equal(current.value.receivedText, "second response");
  assert.equal(store.activeMessage("instance_1", "session_1").value, current);
});

test("a terminal snapshot replaces a stale active assistant item missed while unsubscribed", () => {
  const store = createStreamingMessagesStore();
  const progress = identity({ itemId: "item_progress" });
  const final = identity({ itemId: "item_final" });
  store.appendDelta({ identity: progress, streamId: "stream_1", delta: "early progress" });

  store.applySnapshot({
    meta: meta({ generatedAt: "2026-07-18T00:00:02.000Z" }),
    snapshot: {
      runningCount: 0,
      waitingCount: 0,
      staleCount: 0,
      updatedAt: "2026-07-18T00:00:02.000Z",
      sessions: [session({
        activeTurnId: undefined,
        status: "idle",
        turns: [{ id: "turn_1", status: "completed", revision: 3, lastMessage: "final response", lastMessageItemId: "item_final" }],
        lastMessage: "final response",
        lastMessageItemId: "item_final",
      })],
    },
  });

  const active = store.activeMessage("instance_1", "session_1").value;
  assert.equal(active, store.message(final));
  assert.equal(active.value.receivedText, "final response");
  assert.equal(active.value.status, "complete");
  assert.equal(store.message(progress).value.receivedText, "early progress");
});

test("a terminal snapshot without item identity still converges to the authoritative full text", () => {
  const store = createStreamingMessagesStore();
  const id = identity({ itemId: "item_live" });
  const entry = store.appendDelta({ identity: id, streamId: "stream_1", delta: "partial" });

  store.applySnapshot({
    meta: meta({ generatedAt: "2026-07-18T00:00:02.000Z" }),
    snapshot: {
      runningCount: 0,
      waitingCount: 0,
      staleCount: 0,
      updatedAt: "2026-07-18T00:00:02.000Z",
      sessions: [session({
        status: "idle",
        turns: [{ id: "turn_1", status: "completed", revision: 2, lastMessage: "partial plus the authoritative ending" }],
        lastMessage: "partial plus the authoritative ending",
      })],
    },
  });

  assert.equal(entry.value.receivedText, "partial plus the authoritative ending");
  assert.equal(entry.value.status, "complete");
});

test("a new turn does not keep the previous turn as the active streaming message", () => {
  const store = createStreamingMessagesStore();
  const previous = identity({ turnId: "turn_previous", itemId: "item_previous" });
  store.appendDelta({ identity: previous, streamId: "stream_1", delta: "previous response" });

  store.applySnapshot({
    meta: meta({ generatedAt: "2026-07-18T00:00:01.000Z" }),
    snapshot: {
      runningCount: 1,
      waitingCount: 0,
      staleCount: 0,
      updatedAt: "2026-07-18T00:00:01.000Z",
      sessions: [session({
        activeTurnId: "turn_new",
        lastMessage: "previous response",
        turns: [{ id: "turn_new", status: "running", revision: 1 }],
      })],
    },
  });

  assert.equal(store.activeMessage("instance_1", "session_1").value, undefined);
  const current = store.appendDelta({
    identity: identity({ turnId: "turn_new", itemId: "item_new" }),
    streamId: "stream_1",
    delta: "new response",
  });
  assert.equal(current.value.receivedText, "new response");
});

test("multiple board-style message views rerender only for their subscribed session", () => {
  const store = createStreamingMessagesStore();
  const firstId = identity();
  const secondId = identity({ sessionId: "session_2", itemId: "item_2" });
  const first = store.appendDelta({ identity: firstId, streamId: "stream_1", delta: "first" });
  const second = store.appendDelta({ identity: secondId, streamId: "stream_1", delta: "second" });
  const firstActive = store.activeMessage("instance_1", "session_1");
  const secondActive = store.activeMessage("instance_1", "session_2");
  let firstRenders = 0;
  let secondRenders = 0;
  const stopFirst = watchEffect(() => {
    firstActive.value?.value.receivedText;
    firstRenders += 1;
  }, { flush: "sync" });
  const stopSecond = watchEffect(() => {
    secondActive.value?.value.receivedText;
    secondRenders += 1;
  }, { flush: "sync" });

  store.appendDelta({ identity: firstId, streamId: "stream_1", delta: " updated" });
  assert.equal(first.value.receivedText, "first updated");
  assert.equal(second.value.receivedText, "second");
  assert.equal(firstRenders, 2);
  assert.equal(secondRenders, 1);
  stopFirst();
  stopSecond();
});

test("component-style subscription disposal does not own the module store lifecycle", () => {
  const store = useStreamingMessagesStore();
  store.clear();
  const id = identity();
  const entry = store.appendDelta({ identity: id, streamId: "stream_1", delta: "persistent" });
  let notifications = 0;
  const unmount = watch(entry, () => { notifications += 1; }, { flush: "sync" });
  unmount();

  store.appendDelta({ identity: id, streamId: "stream_1", delta: " state" });
  const reopened = useStreamingMessagesStore().message(id);

  assert.equal(reopened, entry);
  assert.equal(reopened.value.receivedText, "persistent state");
  assert.equal(notifications, 0);
  store.clear();
});
