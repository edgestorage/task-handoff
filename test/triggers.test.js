const assert = require("node:assert/strict");
const test = require("node:test");

const { eventTopic } = require("../packages/protocol/src/events.ts");
const { triggerConfigHash } = require("../packages/protocol/src/triggers.ts");

test("trigger config hash ignores display fields and object order", () => {
  const first = triggerConfigHash({
    source: { type: "schedule", intervalMs: 1000 },
    action: { promptTemplate: "Hello" },
    policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
  });
  const second = triggerConfigHash({
    policy: { whenBusy: "skip", maxConcurrentRuns: 1 },
    action: { promptTemplate: "Hello" },
    source: { intervalMs: 1000, type: "schedule" },
  });
  assert.equal(first, second);
});

test("trigger config hash changes when behavior changes", () => {
  const first = triggerConfigHash({
    source: { type: "schedule", intervalMs: 1000 },
    action: { promptTemplate: "Hello" },
    policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
  });
  const second = triggerConfigHash({
    source: { type: "schedule", intervalMs: 2000 },
    action: { promptTemplate: "Hello" },
    policy: { maxConcurrentRuns: 1, whenBusy: "skip" },
  });
  assert.notEqual(first, second);
});

test("trigger events use triggers topic", () => {
  assert.equal(eventTopic("trigger.run.completed"), "triggers");
});
