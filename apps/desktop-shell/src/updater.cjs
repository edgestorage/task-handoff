const fs = require("node:fs");
const path = require("node:path");

const UPDATE_STATE_EVENT = "task-handoff:desktop-update-state";
const UPDATE_CHANNELS = new Set(["stable", "beta", "alpha"]);
const DEFAULT_RELEASE_URL = "https://github.com/edgestorage/task-handoff/releases";

function sanitizeChannel(value) {
  return UPDATE_CHANNELS.has(value) ? value : "stable";
}

function readUpdateChannel(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return sanitizeChannel(value?.channel);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.name !== "SyntaxError") {
      throw error;
    }
    return "stable";
  }
}

function writeUpdateChannel(file, channel) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ channel }, undefined, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function updateCapabilities({ packaged, platform, env = process.env }) {
  if (!packaged) {
    return { check: false, download: false, install: false, reason: "Desktop updates are unavailable in development builds." };
  }
  if (platform === "darwin") {
    return { check: true, download: true, install: true };
  }
  if (platform === "win32") {
    return {
      check: true,
      download: false,
      install: false,
      reason: "Windows in-app installation will be enabled after the installer is code signed.",
    };
  }
  if (platform === "linux" && env.APPIMAGE) {
    return { check: true, download: true, install: true };
  }
  if (platform === "linux") {
    return {
      check: false,
      download: false,
      install: false,
      reason: "In-app updates require the AppImage build. Download package updates from GitHub Releases.",
    };
  }
  return { check: false, download: false, install: false, reason: `Desktop updates are unsupported on ${platform}.` };
}

function releaseUrl(version) {
  return version
    ? `${DEFAULT_RELEASE_URL}/tag/v${encodeURIComponent(version)}`
    : DEFAULT_RELEASE_URL;
}

function errorPayload(error, fallbackCode) {
  return {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

function createDesktopUpdater({
  app,
  autoUpdater,
  BrowserWindow,
  platform = process.platform,
  env = process.env,
  logInfo = () => {},
  logError = () => {},
  install,
}) {
  const configFile = path.join(app.getPath("userData"), "desktop-update.json");
  const capabilities = updateCapabilities({ packaged: app.isPackaged, platform, env });
  let channel = readUpdateChannel(configFile);
  let started = false;
  let checkTimer;
  let intervalTimer;
  let state = {
    phase: capabilities.check ? "idle" : "unsupported",
    currentVersion: app.getVersion(),
    channel,
    capabilities,
    releaseUrl: releaseUrl(),
  };

  function snapshot() {
    return JSON.parse(JSON.stringify(state));
  }

  function publish(patch) {
    state = { ...state, ...patch, channel, capabilities };
    const next = snapshot();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(UPDATE_STATE_EVENT, next);
      }
    }
    return next;
  }

  function configureChannel() {
    autoUpdater.channel = channel === "stable" ? "latest" : channel;
    // electron-updater enables downgrades as a side effect of assigning a
    // channel. Desktop channels may widen the candidate set, never replace a
    // newer installed application with an older release.
    autoUpdater.allowDowngrade = false;
    autoUpdater.allowPrerelease = channel !== "stable";
  }

  async function check() {
    if (!capabilities.check) {
      return snapshot();
    }
    if (["checking", "downloading", "downloaded", "installing"].includes(state.phase)) {
      return snapshot();
    }
    publish({ phase: "checking", error: undefined });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      logError(`[desktop-updater] check failed ${error instanceof Error ? error.stack || error.message : String(error)}`);
      publish({ phase: "error", error: errorPayload(error, "DESKTOP_UPDATE_CHECK_FAILED") });
    }
    return snapshot();
  }

  async function download() {
    if (!capabilities.download || state.phase !== "available") {
      return snapshot();
    }
    publish({ phase: "downloading", progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }, error: undefined });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      logError(`[desktop-updater] download failed ${error instanceof Error ? error.stack || error.message : String(error)}`);
      publish({ phase: "error", error: errorPayload(error, "DESKTOP_UPDATE_DOWNLOAD_FAILED") });
    }
    return snapshot();
  }

  async function installDownloaded() {
    if (!capabilities.install || state.phase !== "downloaded") {
      return snapshot();
    }
    publish({ phase: "installing", error: undefined });
    try {
      await install();
      autoUpdater.quitAndInstall(false, true);
    } catch (error) {
      logError(`[desktop-updater] install failed ${error instanceof Error ? error.stack || error.message : String(error)}`);
      publish({ phase: "error", error: errorPayload(error, "DESKTOP_UPDATE_INSTALL_FAILED") });
    }
    return snapshot();
  }

  async function setChannel(value) {
    const nextChannel = sanitizeChannel(value);
    if (nextChannel !== value) {
      const error = new Error(`Unsupported desktop update channel: ${value}`);
      error.code = "DESKTOP_UPDATE_CHANNEL_INVALID";
      throw error;
    }
    channel = nextChannel;
    writeUpdateChannel(configFile, channel);
    configureChannel();
    return publish({
      phase: capabilities.check ? "idle" : "unsupported",
      availableVersion: undefined,
      releaseName: undefined,
      releaseNotes: undefined,
      progress: undefined,
      error: undefined,
      releaseUrl: releaseUrl(),
    });
  }

  function start() {
    if (started) return;
    started = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    configureChannel();

    autoUpdater.on("checking-for-update", () => publish({ phase: "checking", error: undefined }));
    autoUpdater.on("update-available", (info) => publish({
      phase: "available",
      availableVersion: info.version,
      releaseName: info.releaseName,
      releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
      releaseUrl: releaseUrl(info.version),
      error: undefined,
    }));
    autoUpdater.on("update-not-available", () => publish({
      phase: "up-to-date",
      availableVersion: undefined,
      releaseName: undefined,
      releaseNotes: undefined,
      progress: undefined,
      error: undefined,
      releaseUrl: releaseUrl(),
    }));
    autoUpdater.on("download-progress", (progress) => publish({
      phase: "downloading",
      progress: {
        percent: Number(progress.percent || 0),
        transferred: Number(progress.transferred || 0),
        total: Number(progress.total || 0),
        bytesPerSecond: Number(progress.bytesPerSecond || 0),
      },
    }));
    autoUpdater.on("update-downloaded", (info) => publish({
      phase: "downloaded",
      availableVersion: info.version,
      releaseName: info.releaseName,
      progress: undefined,
      releaseUrl: releaseUrl(info.version),
      error: undefined,
    }));
    autoUpdater.on("error", (error) => publish({ phase: "error", error: errorPayload(error, "DESKTOP_UPDATE_FAILED") }));

    if (capabilities.check) {
      checkTimer = setTimeout(() => void check(), 15_000);
      intervalTimer = setInterval(() => void check(), 6 * 60 * 60 * 1000);
      checkTimer.unref?.();
      intervalTimer.unref?.();
    }
    logInfo(`[desktop-updater] initialized version=${state.currentVersion} channel=${channel} check=${capabilities.check}`);
  }

  function stop() {
    clearTimeout(checkTimer);
    clearInterval(intervalTimer);
  }

  return { check, download, getState: snapshot, install: installDownloaded, setChannel, start, stop };
}

module.exports = {
  UPDATE_STATE_EVENT,
  createDesktopUpdater,
  readUpdateChannel,
  sanitizeChannel,
  updateCapabilities,
  writeUpdateChannel,
};
