const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { atomicWriteFileSync, withWindowsTransientFileRetry } = require("../packages/core/src/storage/atomic-write.ts");

function fileError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

test("Windows atomic writes retry transient sharing violations", () => {
  const waits = [];
  let attempts = 0;
  const result = withWindowsTransientFileRetry(() => {
    attempts += 1;
    if (attempts < 3) throw fileError(attempts === 1 ? "EPERM" : "EBUSY");
    return "written";
  }, { platform: "win32", wait: (delay) => waits.push(delay) });

  assert.equal(result, "written");
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);
});

test("Windows atomic writes expose exhausted retries instead of swallowing them", () => {
  let attempts = 0;
  assert.throws(
    () => withWindowsTransientFileRetry(() => {
      attempts += 1;
      throw fileError("EACCES", "target is locked");
    }, { platform: "win32", wait: () => {} }),
    (error) => error.code === "EACCES" && error.message === "target is locked",
  );
  assert.equal(attempts, 8);
});

test("atomic write retries only apply to Windows and transient file codes", () => {
  let nonWindowsAttempts = 0;
  assert.throws(
    () => withWindowsTransientFileRetry(() => {
      nonWindowsAttempts += 1;
      throw fileError("EPERM");
    }, { platform: "darwin", wait: () => {} }),
    (error) => error.code === "EPERM",
  );
  assert.equal(nonWindowsAttempts, 1);

  let permanentAttempts = 0;
  assert.throws(
    () => withWindowsTransientFileRetry(() => {
      permanentAttempts += 1;
      throw fileError("ENOSPC");
    }, { platform: "win32", wait: () => {} }),
    (error) => error.code === "ENOSPC",
  );
  assert.equal(permanentAttempts, 1);
});

test("atomic writes still replace a complete file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-atomic-write-"));
  const file = path.join(root, "state.json");
  try {
    atomicWriteFileSync(file, '{"revision":1}\n');
    atomicWriteFileSync(file, '{"revision":2}\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { revision: 2 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
