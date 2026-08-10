const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const controlPlaneTerminal = read("packages/control-plane-ui/src/apps/control-plane/useTerminalPreview.ts");

test("control-plane terminal resize is visibility-aware, stable, and event-driven", () => {
  assert.match(controlPlaneTerminal, /!active\.value/);
  assert.match(controlPlaneTerminal, /stableFrames < 2 && attempts < 8/);
  assert.match(controlPlaneTerminal, /terminal\.onResize/);
  assert.match(controlPlaneTerminal, /lastSentDimensions/);
  assert.doesNotMatch(controlPlaneTerminal, /setTimeout/);
  assert.doesNotMatch(controlPlaneTerminal, /window\.addEventListener\("resize"/);
});
