import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AiSessionMessageDeltaCoalescer } from "../packages/controlled-instance/src/web/ai-session-message-delta-coalescer.ts";
import { createStreamingMessagesStore } from "../packages/control-plane-ui/src/apps/control-plane/useStreamingMessagesStore.ts";
import { createStreamingTestEnvironment } from "./support/streaming-test-tools.mjs";

const fixtureUrl = new URL("./fixtures/ai-session/codex-markdown-stream.real.jsonl", import.meta.url);
const records = (await readFile(fixtureUrl, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
const [metadata, ...events] = records;
const realDeltas = events.filter((event) => event.aiSessionEvent?.type === "ai-session.message-delta");
const completed = events.find((event) => event.raw.method === "item/completed")?.raw.params.item.text;

for (const [terminal, status, flushReason] of [
  ["completed", "complete", "completed"],
  ["failed", "failed", "failed"],
  ["waiting", "waiting", "waiting"],
  ["interrupted", "complete", "interrupted"],
]) {
  test(`real WebSocket deltas converge exactly when the session is ${terminal}`, () => {
    const replay = createReplay();
    replayAll(replay);
    replay.coalescer.flushAll(flushReason);
    const entry = replay.store.activeMessage(metadata.instanceId, metadata.sessionId).value;
    replay.store.settleAuthoritative({
      identity: entry.value,
      streamId: "real-stream",
      text: completed,
      status,
      generatedAt: new Date().toISOString(),
    });
    assert.equal(entry.value.receivedText, completed);
    assert.equal(entry.value.status, status);
    assert.ok(replay.coalescer.diagnostics().emittedEventCount < realDeltas.length);
  });
}

test("a reconnect stream discards the old real queue and rebuilds exact text", () => {
  const replay = createReplay();
  replaySome(replay, realDeltas.slice(0, Math.floor(realDeltas.length / 2)), "old-stream");
  const old = replay.store.activeMessage(metadata.instanceId, metadata.sessionId).value;
  assert.ok(old.value.receivedText.length > 0);
  replay.store.replaceStream(metadata.instanceId, "real-stream");
  assert.equal(replay.store.activeMessage(metadata.instanceId, metadata.sessionId).value, undefined);
  replayAll(replay);
  replay.coalescer.flushAll("authoritative-event");
  const current = replay.store.activeMessage(metadata.instanceId, metadata.sessionId).value;
  assert.notStrictEqual(current, old);
  assert.equal(current.value.receivedText, completed);
});

test("the store exposes exact coalesced text without owning a display backlog", () => {
  const replay = createReplay();
  replayAll(replay);
  replay.coalescer.flushAll("completed");
  const entry = replay.store.activeMessage(metadata.instanceId, metadata.sessionId).value;
  assert.equal(entry.value.receivedText, completed);
  assert.equal(replay.environment.animationFrames.pendingFrameCount, 0);
});

function createReplay(options = {}) {
  const environment = createStreamingTestEnvironment(options);
  const store = createStreamingMessagesStore();
  const coalescer = new AiSessionMessageDeltaCoalescer({
    clock: environment.clock,
    emit: (payload) => store.appendDelta({
      identity: payload,
      streamId: "real-stream",
      delta: payload.delta,
      generatedAt: payload.generatedAt,
    }),
  });
  return { coalescer, environment, store };
}

function replayAll(replay) {
  replaySome(replay, realDeltas, "real-stream");
}

function replaySome(replay, deltas, streamId) {
  for (const event of deltas) {
    const payload = event.aiSessionEvent.payload;
    if (streamId === "real-stream") replay.coalescer.push(payload);
    else replay.store.appendDelta({ identity: payload, streamId, delta: payload.delta, generatedAt: payload.generatedAt });
  }
}
