const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { observeNodeSessionHttp } = require("./fixtures/ai-session-http-parity.js");

const fixture = JSON.parse(fs.readFileSync(path.join(
  __dirname,
  "../controlled-instance-rs/crates/instance/tests/fixtures/session-http-parity.json",
), "utf8"));

test("U01.4-U01.6 session HTTP routes match the fixed Node wire contract", async () => {
  for (const scenario of fixture.scenarios) {
    assert.deepEqual(await observeNodeSessionHttp(scenario), scenario.expected, scenario.name);
  }
});
