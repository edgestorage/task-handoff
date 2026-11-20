const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { withAttachmentApp, attachmentRequest, normalizeAttachmentResponse } = require("./fixtures/attachment-route-parity.js");

test("attachment routes match shared Node/Rust request and streaming fixtures", async () => {
  const fixtures = ["attachment-route-parity.json", "attachment-source-parity.json"].flatMap(file =>
    JSON.parse(fs.readFileSync(path.join(__dirname, "../controlled-instance-rs/crates/instance/tests/fixtures", file), "utf8")));
  await withAttachmentApp(async (app, root) => {
    for (const fixture of fixtures) {
      const response = await app.inject(attachmentRequest(fixture));
      assert.deepEqual(normalizeAttachmentResponse(response, fixture, root), fixture.expected, fixture.name);
    }
  });
});
