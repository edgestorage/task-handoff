const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "../../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const mainSource = fs.readFileSync(path.join(root, "apps/desktop-shell/src/main.cjs"), "utf8");
const icon = fs.readFileSync(path.join(root, "build/icon.png"));

function pngAlphaBounds(png, width, height) {
  const idat = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  let cursor = 0;
  let previous = Buffer.alloc(stride);
  const bounds = { minX: width, minY: height, maxX: -1, maxY: -1 };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor++];
    const scanline = Buffer.alloc(stride);
    for (let index = 0; index < stride; index += 1) {
      const encoded = raw[cursor++];
      const left = index >= 4 ? scanline[index - 4] : 0;
      const up = previous[index];
      const upLeft = index >= 4 ? previous[index - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const leftDistance = Math.abs(estimate - left);
        const upDistance = Math.abs(estimate - up);
        const upLeftDistance = Math.abs(estimate - upLeft);
        predictor = leftDistance <= upDistance && leftDistance <= upLeftDistance ? left : upDistance <= upLeftDistance ? up : upLeft;
      }
      scanline[index] = (encoded + predictor) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      if (scanline[x * 4 + 3] > 0) {
        bounds.minX = Math.min(bounds.minX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
    }
    previous = scanline;
  }
  return bounds;
}

test("Electron uses the TaskHandoff icon for packaging and runtime windows", () => {
  assert.equal(packageJson.build.icon, "build/icon.png");
  assert.deepEqual(packageJson.build.extraResources, [{ from: "build/icon.png", to: "icon.png" }]);
  assert.match(mainSource, /icon: desktopIconPath\(\)/);
  assert.match(mainSource, /app\.dock\.setIcon\(icon\)/);
});

test("packaged macOS apps keep the bundle-managed rounded Dock icon", () => {
  assert.match(mainSource, /if \(isMacOS\(\) && app\.isPackaged\) \{\s+return;\s+\}/);
});

test("Electron unpacks the server runtime needed by its bundled Node process", () => {
  assert.deepEqual(packageJson.build.asarUnpack, [
    "bin/**/*",
    "dist/**/*",
    "packages/control-plane-ui/dist/**/*",
    "release/runtime-artifacts/**/*",
    "node_modules/**/*",
  ]);
  assert.ok(packageJson.build.files.includes("release/runtime-artifacts/**/*"));
});

test("Electron icon is a standard 1024px RGBA source for transparent macOS corners", () => {
  assert.deepEqual(icon.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = icon.readUInt32BE(16);
  const height = icon.readUInt32BE(20);
  const bitDepth = icon.readUInt8(24);
  const colorType = icon.readUInt8(25);
  assert.equal(width, 1024);
  assert.equal(height, 1024);
  assert.equal(bitDepth, 8);
  assert.equal(colorType, 6, "expected an RGBA PNG with an alpha channel");
  assert.deepEqual(pngAlphaBounds(icon, width, height), { minX: 100, minY: 100, maxX: 923, maxY: 923 });
});
