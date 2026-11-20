const assert = require("node:assert/strict");
const test = require("node:test");
const { observeUploadOwnership } = require("./fixtures/attachment-upload-ownership.js");
const fixture = require("../controlled-instance-rs/crates/ai-session/tests/fixtures/attachment-upload-ownership.json");
for (const scenario of fixture.cases) {
  test(`U11.1 ${scenario.name}: failure cleanup preserves the surviving upload`, { timeout: 5000 }, async () => {
    assert.deepEqual(await observeUploadOwnership(scenario), scenario.expected);
  });
}
