const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const mainSource = fs.readFileSync(path.join(root, "apps/desktop-shell/src/main.cjs"), "utf8");
const icon = fs.readFileSync(path.join(root, "build/icon.png"));

test("Electron uses the TaskHandoff icon for packaging and runtime windows", () => {
  assert.equal(packageJson.build.icon, "build/icon.png");
  assert.deepEqual(packageJson.build.extraResources, [{ from: "build/icon.png", to: "icon.png" }]);
  assert.match(mainSource, /icon: desktopIconPath\(\)/);
  assert.match(mainSource, /app\.dock\.setIcon\(icon\)/);
});

test("Electron icon is a square PNG large enough for packaging", () => {
  assert.deepEqual(icon.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = icon.readUInt32BE(16);
  const height = icon.readUInt32BE(20);
  assert.equal(width, height);
  assert.ok(width >= 512, `expected at least 512px, got ${width}px`);
});
