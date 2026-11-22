const assert = require("node:assert/strict");
const test = require("node:test");

const { MAX_CLIPBOARD_TEXT_BYTES, createDesktopClipboardBridge } = require("../src/desktop-clipboard.cjs");

function clipboardHarness(initial = "") {
  let text = initial;
  const writes = [];
  const changes = [];
  const clipboard = {
    readText: () => text,
    writeText: (value) => {
      text = value;
      writes.push(value);
    },
  };
  const bridge = createDesktopClipboardBridge({
    clipboard,
    broadcast: (input) => changes.push(input.text),
  });
  return { bridge, changes, writes, read: () => text, set: (value) => { text = value; } };
}

test("desktop clipboard seeds its baseline and notifies only later changes", () => {
  const harness = clipboardHarness("before the session");
  harness.bridge.start();
  harness.bridge.pollNow();
  assert.deepEqual(harness.changes, []);

  harness.set("outside change");
  harness.bridge.pollNow();
  assert.deepEqual(harness.changes, ["outside change"]);
  harness.bridge.stop();
});

test("desktop clipboard writes update the watcher baseline to suppress echoes", () => {
  const harness = clipboardHarness("before");
  harness.bridge.start();
  assert.deepEqual(harness.bridge.writeText("from the remote desktop"), { ok: true });
  assert.equal(harness.read(), "from the remote desktop");

  harness.bridge.pollNow();
  assert.deepEqual(harness.changes, []);
  assert.deepEqual(harness.writes, ["from the remote desktop"]);
  harness.bridge.stop();
});

test("desktop clipboard rejects invalid text without touching the OS clipboard", () => {
  const harness = clipboardHarness("unchanged");
  assert.deepEqual(harness.bridge.writeText(null), { ok: false, code: "REMOTE_DESKTOP_CLIPBOARD_INVALID" });
  assert.deepEqual(harness.bridge.writeText("a\0b"), { ok: false, code: "REMOTE_DESKTOP_CLIPBOARD_INVALID" });
  assert.deepEqual(harness.bridge.writeText("x".repeat(MAX_CLIPBOARD_TEXT_BYTES + 1)), { ok: false, code: "REMOTE_DESKTOP_CLIPBOARD_INVALID" });
  assert.equal(harness.read(), "unchanged");
  assert.deepEqual(harness.writes, []);
});

test("desktop clipboard stops polling and notifications after stop", () => {
  const harness = clipboardHarness("before");
  harness.bridge.start();
  harness.bridge.stop();
  harness.bridge.pollNow();
  assert.deepEqual(harness.changes, []);
});
