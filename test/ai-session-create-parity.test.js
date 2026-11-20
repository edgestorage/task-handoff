const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { observeNodeCreate } = require("./fixtures/ai-session-create-parity.js");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../controlled-instance-rs/crates/ai-session/tests/fixtures/session-create-parity.json"), "utf8"));

for (const scenario of fixture.scenarios) {
  test(`Node create coordinator: ${scenario.name}`, async () => {
    assert.deepEqual(await observeNodeCreate(scenario), scenario.expected);
  });
}

const { observeNodeCreateLifecycle } = require("./fixtures/ai-session-create-parity.js");
const lifecycle = JSON.parse(fs.readFileSync(path.join(__dirname, "../controlled-instance-rs/crates/ai-session/tests/fixtures/session-create-lifecycle-parity.json"), "utf8"));
for (const scenario of lifecycle.scenarios) {
  test(`Node create lifecycle: ${scenario.name}`, async () => {
    assert.deepEqual(await observeNodeCreateLifecycle(scenario), scenario.expected);
  });
}

const { observeNodeSendLifecycle } = require("./fixtures/ai-session-create-parity.js");
const sends = JSON.parse(fs.readFileSync(path.join(__dirname, "../controlled-instance-rs/crates/ai-session/tests/fixtures/session-send-lifecycle-parity.json"), "utf8"));
for (const scenario of sends.scenarios) {
  test(`Node send lifecycle: ${scenario.name}`, async () => {
    assert.deepEqual(await observeNodeSendLifecycle(scenario), scenario.expected);
  });
}
