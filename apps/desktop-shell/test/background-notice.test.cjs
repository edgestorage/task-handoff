const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { claimBackgroundNotice } = require("../src/background-notice.cjs");

test("background notice is claimed once per desktop data directory", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-background-notice-"));
  assert.equal(claimBackgroundNotice(dataDir), true);
  assert.equal(claimBackgroundNotice(dataDir), false);
});
