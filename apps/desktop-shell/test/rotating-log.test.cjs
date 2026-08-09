const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { appendRotatingLog } = require("../src/rotating-log.cjs");

test("desktop diagnostic log rotates bounded generations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-desktop-log-"));
  const filePath = path.join(root, "desktop.log");

  for (let index = 0; index < 10; index += 1) {
    appendRotatingLog(filePath, `${index}:${"x".repeat(40)}\n`, { maxBytes: 96, backupCount: 2 });
  }

  for (const name of ["desktop.log", "desktop.1.log", "desktop.2.log"]) {
    const candidate = path.join(root, name);
    assert.equal(fs.existsSync(candidate), true);
    assert.ok(fs.statSync(candidate).size <= 96);
  }
});

test("desktop diagnostic log truncates an oversized preexisting generation during rotation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-desktop-log-existing-"));
  const filePath = path.join(root, "desktop.log");
  fs.writeFileSync(filePath, Buffer.alloc(512, "o"));

  appendRotatingLog(filePath, "recent\n", { maxBytes: 96, backupCount: 2 });

  assert.equal(fs.readFileSync(filePath, "utf8"), "recent\n");
  assert.equal(fs.statSync(path.join(root, "desktop.1.log")).size, 96);
});
