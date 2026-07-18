import assert from "node:assert/strict";
import test from "node:test";

import { AiSessionMessageDeltaCoalescer } from "../packages/controlled-instance/src/web/ai-session-message-delta-coalescer.ts";
import { FakeClock } from "./support/streaming-test-tools.mjs";

function delta(overrides = {}) {
  return {
    instanceId: "instance-1",
    nodeId: "node-1",
    sessionId: "session-1",
    providerSessionId: "provider-session-1",
    turnId: "turn-1",
    itemId: "item-1",
    delta: "a",
    generatedAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

function setup(options = {}) {
  const clock = new FakeClock();
  const emitted = [];
  const coalescer = new AiSessionMessageDeltaCoalescer({
    clock,
    emit: (payload) => emitted.push(payload),
    ...options,
  });
  return { clock, emitted, coalescer };
}

test("coalesces one message in order and uses the last delta metadata", () => {
  const { clock, emitted, coalescer } = setup();
  coalescer.push(delta({ delta: "hel", generatedAt: "2026-07-18T00:00:00.001Z" }));
  coalescer.push(delta({ delta: "lo", generatedAt: "2026-07-18T00:00:00.020Z" }));

  clock.advanceBy(31);
  assert.deepEqual(emitted, []);
  clock.advanceBy(1);

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].delta, "hello");
  assert.equal(emitted[0].generatedAt, "2026-07-18T00:00:00.020Z");
  assert.equal(coalescer.pendingCount, 0);
});

test("isolates every field in the instance, session, turn, and item key", () => {
  for (const differentIdentity of [
    { instanceId: "instance-2" },
    { sessionId: "session-2" },
    { turnId: "turn-2" },
    { itemId: "item-2" },
  ]) {
    const { emitted, coalescer } = setup();
    coalescer.push(delta({ delta: "a" }));
    coalescer.push(delta({ ...differentIdentity, delta: "1" }));
    coalescer.push(delta({ delta: "b" }));
    coalescer.push(delta({ ...differentIdentity, delta: "2" }));

    coalescer.flushAll();
    assert.deepEqual(emitted.map((payload) => payload.delta), ["ab", "12"]);
  }
});

test("does not renew the first batch timer while input continues", () => {
  const { clock, emitted, coalescer } = setup();
  coalescer.push(delta({ delta: "a" }));
  clock.advanceBy(10);
  coalescer.push(delta({ delta: "b" }));
  clock.advanceBy(10);
  coalescer.push(delta({ delta: "c" }));
  clock.advanceBy(11);
  coalescer.push(delta({ delta: "d" }));

  assert.deepEqual(emitted, []);
  clock.advanceBy(1);
  assert.deepEqual(emitted.map((payload) => payload.delta), ["abcd"]);
});

test("accepts only coalescing windows from 20ms through 50ms", () => {
  for (const windowMs of [20, 50]) {
    const { clock, emitted, coalescer } = setup({ windowMs });
    coalescer.push(delta());
    clock.advanceBy(windowMs - 1);
    assert.equal(emitted.length, 0);
    clock.advanceBy(1);
    assert.equal(emitted.length, 1);
  }

  for (const windowMs of [0, 19, 51, Number.NaN]) {
    assert.throws(() => setup({ windowMs }), /between 20ms and 50ms/);
  }
});

test("message terminal states can flush their related delta before publication", () => {
  for (const terminalState of ["completed", "failed", "waiting", "interrupted"]) {
    const { emitted, coalescer } = setup();
    const payload = delta({ delta: terminalState });
    coalescer.push(payload);

    assert.equal(coalescer.flush(payload, terminalState), true, terminalState);
    emitted.push({ type: terminalState });
    assert.deepEqual(emitted.map((event) => event.delta ?? event.type), [terminalState, terminalState]);
  }
});

test("flushing one message leaves other message buffers pending", () => {
  const { clock, emitted, coalescer } = setup();
  const first = delta({ delta: "first" });
  const second = delta({ sessionId: "session-2", delta: "second" });
  coalescer.push(first);
  coalescer.push(second);

  assert.equal(coalescer.flush(first), true);
  assert.deepEqual(emitted.map((payload) => payload.delta), ["first"]);
  assert.equal(coalescer.pendingCount, 1);

  clock.advanceBy(32);
  assert.deepEqual(emitted.map((payload) => payload.delta), ["first", "second"]);
});

test("event source closure can flush all parallel buffers without closing the coalescer", () => {
  const { emitted, coalescer } = setup();
  coalescer.push(delta({ delta: "first" }));
  coalescer.push(delta({ sessionId: "session-2", delta: "second" }));

  assert.equal(coalescer.flushAll("event-source-close"), 2);
  assert.deepEqual(emitted.map((payload) => payload.delta), ["first", "second"]);

  coalescer.push(delta({ delta: "after-reconnect" }));
  assert.equal(coalescer.flushAll(), 1);
  assert.equal(emitted.at(-1).delta, "after-reconnect");
});

test("service closure flushes all buffers once and rejects new deltas", () => {
  const { clock, emitted, coalescer } = setup();
  coalescer.push(delta({ delta: "first" }));
  coalescer.push(delta({ sessionId: "session-2", delta: "second" }));

  assert.equal(coalescer.close("service-close"), 2);
  assert.equal(coalescer.closed, true);
  assert.deepEqual(emitted.map((payload) => payload.delta), ["first", "second"]);
  assert.equal(coalescer.close(), 0);
  assert.throws(() => coalescer.push(delta()), /closed/);

  clock.advanceBy(100);
  assert.equal(emitted.length, 2);
});

test("aggregates batch and flush diagnostics without per-delta logging", () => {
  const { clock, coalescer } = setup();
  coalescer.push(delta({ delta: "a" }));
  clock.advanceBy(10);
  coalescer.push(delta({ delta: "b" }));
  clock.advanceBy(22);
  coalescer.push(delta({ sessionId: "session-2", delta: "c" }));
  clock.advanceBy(8);
  coalescer.flush(delta({ sessionId: "session-2" }), "waiting");

  assert.deepEqual(coalescer.diagnostics(), {
    rawDeltaCount: 3,
    emittedEventCount: 2,
    totalBatchSize: 3,
    maxBatchSize: 2,
    flushReasons: { window: 1, waiting: 1 },
    totalFirstBatchWaitMs: 40,
    maxFirstBatchWaitMs: 32,
  });
});
