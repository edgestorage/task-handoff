const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");
const { applyDesktopDockIcon, desktopIconPath, desktopTrayIconPath } = require("../src/icon.cjs");

const root = path.resolve(__dirname, "../../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const icon = fs.readFileSync(path.join(root, "build/icon.png"));
const trayIcon = fs.readFileSync(path.join(root, "build/tray-icon.png"));

function decodePngRgba(png, width, height) {
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
  const pixels = Buffer.alloc(width * height * 4);
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
    scanline.copy(pixels, y * stride);
    previous = scanline;
  }
  return pixels;
}

function pngAlphaBounds(png, width, height) {
  const pixels = decodePngRgba(png, width, height);
  const bounds = { minX: width, minY: height, maxX: -1, maxY: -1 };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pixels[(y * width + x) * 4 + 3] > 0) {
        bounds.minX = Math.min(bounds.minX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.maxY = Math.max(bounds.maxY, y);
      }
    }
  }
  return bounds;
}

test("Electron uses the TaskHandoff icon for packaging and runtime windows", () => {
  assert.equal(packageJson.build.icon, "build/icon.png");
  assert.deepEqual(packageJson.build.extraResources, [
    { from: "build/icon.png", to: "icon.png" },
    { from: "build/tray-icon.png", to: "tray-icon.png" },
  ]);
  assert.equal(desktopIconPath({ packaged: false, root, resourcesPath: "/unused" }), path.join(root, "build", "icon.png"));
  assert.equal(desktopTrayIconPath({ packaged: false, root, resourcesPath: "/unused" }), path.join(root, "build", "tray-icon.png"));
  assert.equal(desktopTrayIconPath({ packaged: true, root: "/unused", resourcesPath: "/Resources" }), undefined);
  assert.equal(desktopTrayIconPath({ packaged: true, root: "/unused", resourcesPath: "/Resources", existsSync: () => true }), "/Resources/tray-icon.png");
  const applied = [];
  assert.equal(applyDesktopDockIcon({
    platform: "darwin",
    packaged: false,
    dock: { setIcon: (value) => applied.push(value) },
    nativeImage: { createFromPath: (value) => ({ value, isEmpty: () => false }) },
    iconPath: path.join(root, "build", "icon.png"),
  }), true);
  assert.equal(applied[0].value, path.join(root, "build", "icon.png"));
});

test("packaged macOS apps keep the bundle-managed rounded Dock icon", () => {
  let created = false;
  assert.equal(applyDesktopDockIcon({
    platform: "darwin",
    packaged: true,
    dock: { setIcon: () => assert.fail("packaged macOS must keep its bundle icon") },
    nativeImage: { createFromPath: () => { created = true; } },
    iconPath: "/Resources/icon.png",
  }), false);
  assert.equal(created, false);
});

test("Electron unpacks the server runtime needed by its bundled Node process", () => {
  assert.deepEqual(packageJson.build.asarUnpack, [
    "bin/**/*",
    "docker/entrypoint.sh",
    "docker/instance-launcher.sh",
    "docker/runtime-installer.mjs",
    "dist/**/*",
    "packages/control-plane-ui/dist/**/*",
    "release/runtime-artifacts/**/*",
    "node_modules/**/*",
  ]);
  for (const launcherAsset of [
    "docker/entrypoint.sh",
    "docker/instance-launcher.sh",
    "docker/runtime-installer.mjs",
  ]) {
    assert.ok(packageJson.build.files.includes(launcherAsset), `${launcherAsset} must be packaged`);
    assert.ok(packageJson.build.asarUnpack.includes(launcherAsset), `${launcherAsset} must be available as a real file`);
  }
  assert.ok(packageJson.build.files.includes("release/runtime-artifacts/**/*"));
  assert.ok(packageJson.files.includes("shared"), "npm releases must contain shared desktop runtime sources");
  assert.ok(packageJson.build.files.includes("shared/process-start-identity.cjs"), "Desktop packages must contain the shared process identity helper");
  assert.equal(packageJson.build.extraResources.some((entry) => entry.from === "dist"), false);
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

test("macOS tray icon keeps the dark tile and makes the light mark transparent", () => {
  assert.deepEqual(trayIcon.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = trayIcon.readUInt32BE(16);
  const height = trayIcon.readUInt32BE(20);
  assert.equal(width, 64);
  assert.equal(height, 64);
  assert.equal(trayIcon.readUInt8(24), 8);
  assert.equal(trayIcon.readUInt8(25), 6, "expected an RGBA PNG with an alpha channel");
  const bounds = pngAlphaBounds(trayIcon, width, height);
  assert.ok(bounds.minX > 0 && bounds.minY > 0, "tray mask must keep transparent outer padding");
  assert.ok(bounds.maxX < width - 1 && bounds.maxY < height - 1, "tray mask must not fill the image bounds");
  const pixels = decodePngRgba(trayIcon, width, height);
  const alphaAt = (x, y) => pixels[(y * width + x) * 4 + 3];
  assert.equal(alphaAt(12, 12), 255, "the original dark tile must remain opaque");
  assert.equal(alphaAt(24, 16), 0, "the original light mark must become transparent");
  assert.equal(alphaAt(0, 0), 0, "the original transparent canvas corner must remain transparent");
});
