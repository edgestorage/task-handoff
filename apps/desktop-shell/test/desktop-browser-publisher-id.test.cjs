const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { resolveDesktopBrowserPublisherId } = require("../src/desktop-browser-publisher-id.cjs");

test("desktop browser publisher id is stable per user data directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-browser-publisher-"));
  try {
    const first = resolveDesktopBrowserPublisherId({ userDataDir: root });
    const second = resolveDesktopBrowserPublisherId({ userDataDir: root });
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f-]{36}$/i);
    assert.equal(fs.readFileSync(path.join(root, "embedded-browser-publisher-id"), "utf8").trim(), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("different desktops produce different browser publisher ids", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-browser-publisher-"));
  try {
    const desktopA = path.join(root, "desktop-a");
    const desktopB = path.join(root, "desktop-b");
    assert.notEqual(
      resolveDesktopBrowserPublisherId({ userDataDir: desktopA }),
      resolveDesktopBrowserPublisherId({ userDataDir: desktopB }),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
