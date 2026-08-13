const assert = require("node:assert/strict");
const test = require("node:test");
const { activateExistingDesktopWindow } = require("../src/desktop-window-activation.cjs");

function fakeWindow({ destroyed = false, minimized = false, visible = true } = {}) {
  return {
    destroyed,
    focused: 0,
    minimized,
    restored: 0,
    visible,
    focus() { this.focused += 1; },
    isDestroyed() { return this.destroyed; },
    isMinimized() { return this.minimized; },
    isVisible() { return this.visible; },
    restore() { this.minimized = false; this.visible = true; this.restored += 1; },
  };
}

test("activation focuses an existing visible window without creating or showing another window", () => {
  const hiddenMain = fakeWindow({ visible: false });
  const instanceWindow = fakeWindow();
  const target = activateExistingDesktopWindow({ windows: [hiddenMain, instanceWindow] });
  assert.equal(target, instanceWindow);
  assert.equal(instanceWindow.focused, 1);
  assert.equal(hiddenMain.focused, 0);
  assert.equal(hiddenMain.visible, false);
});

test("activation restores a minimized existing window", () => {
  const minimized = fakeWindow({ minimized: true, visible: false });
  assert.equal(activateExistingDesktopWindow({ windows: [minimized] }), minimized);
  assert.equal(minimized.restored, 1);
  assert.equal(minimized.focused, 1);
});

test("activation opens the main window when only hidden or destroyed windows remain", () => {
  const hiddenMain = fakeWindow({ visible: false });
  const destroyed = fakeWindow({ destroyed: true });
  const openedMain = fakeWindow();
  let opens = 0;
  assert.equal(activateExistingDesktopWindow({
    windows: [hiddenMain, destroyed],
    onEmpty: () => { opens += 1; return openedMain; },
  }), openedMain);
  assert.equal(opens, 1);
  assert.equal(hiddenMain.focused, 0);
});

test("activation does not open the main window when an eligible window exists", () => {
  const instanceWindow = fakeWindow();
  let opens = 0;
  assert.equal(activateExistingDesktopWindow({
    windows: [instanceWindow],
    onEmpty: () => { opens += 1; },
  }), instanceWindow);
  assert.equal(opens, 0);
});

test("activation preserves the already focused eligible window", () => {
  const focused = fakeWindow();
  const newer = fakeWindow();
  assert.equal(activateExistingDesktopWindow({ windows: [focused, newer], focusedWindow: focused }), focused);
  assert.equal(focused.focused, 1);
  assert.equal(newer.focused, 0);
});
