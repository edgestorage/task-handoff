const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { observeNodeEventSlowConsumer } = require("./fixtures/event-slow-consumer-parity.js");

const fixture = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  "../controlled-instance-rs/crates/instance/tests/fixtures/event-slow-consumer-parity.json",
), "utf8"));

test("U02.2 event consumers match the shared backpressure boundary", () => {
  for (const scenario of fixture.scenarios) {
    assert.deepEqual(observeNodeEventSlowConsumer(scenario), scenario.expected, scenario.name);
  }
});
