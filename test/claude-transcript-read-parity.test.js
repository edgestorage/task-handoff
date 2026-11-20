const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { withAttachmentApp } = require("./fixtures/attachment-route-parity.js");

const fixtures = require("../controlled-instance-rs/crates/instance/tests/fixtures/claude-transcript-read-parity.json");

test("Claude transcript reads match the shared Node/Rust HTTP fixtures", async () => {
  let session;
  await withAttachmentApp(async (app, root) => {
    const transcriptPath = path.join(root, "claude.jsonl");
    for (const fixture of fixtures) {
      fs.writeFileSync(transcriptPath, fixture.content ?? Buffer.from(fixture.bytes));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await app.inject({ url: `/api/ai-sessions/${session.id}/transcript?tail=${fixture.tail}` });
        assert.equal(response.statusCode, 200, fixture.name);
        assert.deepEqual(response.json(), { data: { path: transcriptPath, ...fixture.expected } }, fixture.name);
      }
    }
  }, (root) => {
    const { createAiSessionRegistry } = require("../packages/ai-session-runtime/src/ai-session-registry.ts");
    const registry = createAiSessionRegistry({ dir: path.join(root, "ai-sessions") });
    session = registry.applyAdapterSnapshot({
      source: "control", agent: "claude", providerSessionId: "claude-transcript-fixture",
      transcriptPath: path.join(root, "claude.jsonl"), status: "idle",
    });
    return { aiSessionRegistry: registry };
  });
});
