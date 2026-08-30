const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  UPDATE_STATE_EVENT,
  createDesktopUpdater,
  readUpdateChannel,
  sanitizeChannel,
  updateCapabilities,
  writeUpdateChannel,
} = require("../src/updater.cjs");

class FakeAutoUpdater extends EventEmitter {
  checkForUpdatesCalls = 0;
  async checkForUpdates() {
    this.checkForUpdatesCalls += 1;
  }
  async downloadUpdate() {}
  quitAndInstall() {
    this.quitAndInstallCalled = true;
  }
}

function fixture(options = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-updater-"));
  const sent = [];
  const autoUpdater = new FakeAutoUpdater();
  const app = {
    isPackaged: options.packaged ?? true,
    getPath: () => userData,
    getVersion: () => "1.0.0",
  };
  const BrowserWindow = {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: { send: (event, state) => sent.push({ event, state }) },
    }],
  };
  let installed = false;
  const updater = createDesktopUpdater({
    app,
    autoUpdater,
    BrowserWindow,
    platform: options.platform || "darwin",
    env: options.env || {},
    install: async () => { installed = true; },
  });
  updater.start();
  return { autoUpdater, installed: () => installed, sent, updater, userData };
}

test("desktop update channel persistence sanitizes historical data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-handoff-update-channel-"));
  const file = path.join(directory, "desktop-update.json");
  assert.equal(readUpdateChannel(file), "stable");
  writeUpdateChannel(file, "beta");
  assert.equal(readUpdateChannel(file), "beta");
  fs.writeFileSync(file, JSON.stringify({ channel: "future", unknown: true }));
  assert.equal(readUpdateChannel(file), "stable");
  assert.equal(sanitizeChannel("alpha"), "alpha");
  assert.equal(sanitizeChannel("rc"), "stable");
});

test("desktop update capabilities preserve platform installation boundaries", () => {
  assert.deepEqual(updateCapabilities({ packaged: true, platform: "darwin" }), { check: true, download: true, install: true });
  assert.equal(updateCapabilities({ packaged: true, platform: "win32" }).reasonCode, "windows-signing-required");
  assert.equal(updateCapabilities({ packaged: true, platform: "linux", env: { APPIMAGE: "/tmp/app.AppImage" } }).install, true);
  assert.equal(updateCapabilities({ packaged: true, platform: "linux", env: {} }).reasonCode, "appimage-required");
  assert.equal(updateCapabilities({ packaged: false, platform: "darwin" }).reasonCode, "development-build");
  assert.equal(updateCapabilities({ packaged: true, platform: "freebsd" }).reasonCode, "unsupported-platform");
});

test("desktop updater publishes one normalized state machine", async (t) => {
  const item = fixture();
  t.after(() => item.updater.stop());

  assert.equal(item.updater.getState().phase, "idle");
  item.autoUpdater.emit("update-available", { version: "1.1.0", releaseName: "TaskHandoff 1.1.0" });
  assert.equal(item.updater.getState().phase, "available");
  assert.equal(item.updater.getState().availableVersion, "1.1.0");

  const downloading = item.updater.download();
  item.autoUpdater.emit("download-progress", { percent: 42.4, transferred: 42, total: 100, bytesPerSecond: 12 });
  await downloading;
  assert.equal(item.updater.getState().progress.percent, 42.4);

  item.autoUpdater.emit("update-downloaded", { version: "1.1.0" });
  await item.updater.install();
  assert.equal(item.installed(), true);
  assert.equal(item.autoUpdater.quitAndInstallCalled, true);
  assert.equal(item.sent.at(-1).event, UPDATE_STATE_EVENT);
  assert.equal(item.sent.at(-1).state.phase, "installing");
});

test("desktop updater persists and applies prerelease channels", async (t) => {
  const item = fixture();
  t.after(() => item.updater.stop());
  await item.updater.setChannel("beta");
  assert.equal(item.autoUpdater.channel, "beta");
  assert.equal(item.autoUpdater.allowPrerelease, true);
  assert.equal(item.autoUpdater.allowDowngrade, false);
  assert.equal(readUpdateChannel(path.join(item.userData, "desktop-update.json")), "beta");
  await assert.rejects(() => item.updater.setChannel("rc"), { code: "DESKTOP_UPDATE_CHANNEL_INVALID" });
});

test("desktop updater preserves a downloaded update across scheduled or manual checks", async (t) => {
  const item = fixture();
  t.after(() => item.updater.stop());

  item.autoUpdater.emit("update-downloaded", { version: "1.1.0" });
  const before = item.updater.getState();
  const after = await item.updater.check();

  assert.equal(item.autoUpdater.checkForUpdatesCalls, 0);
  assert.deepEqual(after, before);
  assert.equal(after.phase, "downloaded");
  assert.equal(after.availableVersion, "1.1.0");
});
