const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { fixturePath, observe } = require("./fixtures/trigger-execution-parity.js");

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

for (const scenario of fixture.scenarios) {
  test(`trigger execution parity ${scenario.id}`, { timeout: 15_000 }, async () => {
    assert.deepEqual(await observe(scenario), scenario.expected);
  });
}
