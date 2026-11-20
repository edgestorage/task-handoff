const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { fixturePath, observe } = require("./fixtures/trigger-matcher-parity.js");

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

for (const testCase of fixture.cases) {
  test(`trigger matcher parity ${testCase.name}`, () => {
    assert.deepEqual(observe(testCase), testCase.expected);
  });
}
