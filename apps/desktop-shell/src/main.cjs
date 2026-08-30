const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { app, BrowserView, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net: electronNet, Notification, session, shell, Tray } = require("electron");
const WebSocket = require("ws");
const { autoUpdater } = require("electron-updater");
const {
  buildControlPlaneArgs,
  buildDesktopChildProcessEnv,
  buildNodeAgentArgs,
  nodeAgentUrl,
  repoRoot,
  resolveControlPlaneHost,
  resolveControlPlanePort,
  resolveControlPlaneWindowUrl: validateControlPlaneWindowUrl,
  resolveDataDir,
  resolveDesktopProcessCwd,
  resolveDesktopRuntimeRoot,
  resolveNodeAgentControlEndpoint,
  resolveNodeAgentDataDir,
  resolveNodeAgentHost,
  resolveNodeAgentPort,
  resolveNodeCommand,
  validateDesktopInputs,
} = require("./config.cjs");
const { createDesktopUpdater } = require("./updater.cjs");
const { stopSupervisedDesktopChild, superviseDesktopChild } = require("./child-process.cjs");
const { createDesktopServiceLifecycle } = require("./desktop-service-lifecycle.cjs");
const { createDesktopServiceSupervisor } = require("./desktop-service-supervisor.cjs");
const { createDesktopWindowManager } = require("./desktop-window-manager.cjs");
const { activateExistingDesktopWindow } = require("./desktop-window-activation.cjs");
const { createDesktopTray } = require("./desktop-tray.cjs");
const { createDesktopDockMenu } = require("./desktop-dock-menu.cjs");
const { createDesktopWindowPreferences } = require("./desktop-window-preferences.cjs");
const { loadDesktopInstanceDirectory } = require("./desktop-instance-directory.cjs");
const { createDesktopQuitCoordinator } = require("./desktop-quit-coordinator.cjs");
const { claimBackgroundNotice } = require("./background-notice.cjs");
const { createControlPlaneWindowRegistry } = require("./control-plane-window-registry.cjs");
const {
  DESKTOP_NODE_AGENT_FORCE_TIMEOUT_MS,
  DESKTOP_NODE_AGENT_GRACEFUL_TIMEOUT_MS,
  ensureDesktopNodeAgent,
  inspectExistingDesktopControlPlane,
  inspectStartedDesktopControlPlane,
  stopExistingDesktopNodeAgent,
} = require("./node-agent-handoff.cjs");
const { applyDesktopDockIcon, desktopIconPath: resolveDesktopIconPath, desktopTrayIconPath: resolveDesktopTrayIconPath } = require("./icon.cjs");
const { applyWindowsTitleBarTheme, desktopTitleBarOptions, desktopWindowBackgroundColor, desktopWindowChromeMode } = require("./window-chrome.cjs");
const { appendRotatingLog } = require("./rotating-log.cjs");
const { DesktopBrowserContextManager } = require("./desktop-browser-contexts.cjs");

let mainWindow;
let controlPlaneProcess;
let nodeAgentProcess;
let ownsControlPlaneProcess = false;
let desktopFileLoggingOverride;
let desktopUpdater;
let desktopTray;
let desktopDockMenu;
let desktopWindowPreferences;
let desktopWindows;
let desktopQuitCoordinator;
let desktopBrowserContexts;
const desktopBrowserGuests = new Map();
const desktopServiceSupervisor = createDesktopServiceSupervisor();
const controlPlaneWindows = createControlPlaneWindowRegistry();
const windowsTitleBarOverlayHeights = new WeakMap();
const windowDragStates = new WeakMap();
const childProcessSpawnErrors = new WeakMap();
const NODE_AGENT_IPC_ENDPOINT_PREFIX = "ipc://";

function desktopIconPath() {
  return resolveDesktopIconPath({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    root: repoRoot(),
  });
}

function desktopTrayIconPath() {
  return resolveDesktopTrayIconPath({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    root: repoRoot(),
  });
}

function setDesktopDockIcon() {
  return applyDesktopDockIcon({
    platform: process.platform,
    packaged: app.isPackaged,
    dock: app.dock,
    nativeImage,
    iconPath: desktopIconPath(),
  });
}

function nativeTitleBarWindowOptions() {
  return desktopTitleBarOptions({
    height: 56,
    trafficLightPosition: { x: 16, y: 21 },
  });
}

function compactTitleBarWindowOptions() {
  return desktopTitleBarOptions({
    height: 42,
    trafficLightPosition: { x: 16, y: 15 },
  });
}

function envFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function desktopFileLoggingEnabled() {
  return desktopFileLoggingOverride ?? envFlag(process.env.TASK_HANDOFF_DIAGNOSTIC_LOGS);
}

function resolveDesktopLogFile() {
  return path.resolve(resolveDataDir(), "log", "desktop.log");
}

function isBrokenLogPipe(error) {
  return Boolean(error && typeof error === "object" && (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED"));
}

function reportLogWriteError(error) {
  if (isBrokenLogPipe(error)) {
    return;
  }
  throw error;
}

function writeLog(stream, message) {
  if (!stream || stream.destroyed || !stream.writable) {
    return;
  }
  try {
    stream.write(`${message}\n`, (error) => {
      if (error) {
        reportLogWriteError(error);
      }
    });
  } catch (error) {
    reportLogWriteError(error);
  }
}

function writeDesktopFileLog(message) {
  if (!desktopFileLoggingEnabled()) return;
  try {
    appendRotatingLog(resolveDesktopLogFile(), `${message}\n`);
  } catch (error) {
    reportLogWriteError(error);
  }
}

function closeDesktopFileLog() {
  // File writes are opened per append so disabling logging has no stream to close.
}

process.stdout?.on?.("error", reportLogWriteError);
process.stderr?.on?.("error", reportLogWriteError);

function logInfo(message) {
  writeLog(process.stdout, message);
  writeDesktopFileLog(message);
}

function logError(message) {
  writeLog(process.stderr, message);
  writeDesktopFileLog(message);
}

function renderFailurePage(title, detail) {
  const escapedTitle = escapeHtml(title);
  const escapedDetail = escapeHtml(detail);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapedTitle}</title>
    <style>
      body {
        margin: 0;
        background: #eef3f4;
        color: #17232a;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        display: grid;
        min-height: 100vh;
        place-content: center;
        padding: 28px;
        text-align: center;
      }
      section {
        max-width: 680px;
        border: 1px solid #cbd6da;
        border-radius: 8px;
        background: #ffffff;
        padding: 22px;
        box-shadow: 0 16px 45px rgb(16 32 39 / 12%);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 22px;
      }
      pre {
        overflow: auto;
        border-radius: 7px;
        background: #102027;
        color: #dce8eb;
        padding: 12px;
        text-align: left;
        white-space: pre-wrap;
      }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>${escapedTitle}</h1>
        <pre>${escapedDetail}</pre>
      </section>
    </main>
  </body>
</html>`;
}

function renderAppWindowPage(targetUrl) {
  const escapedTitle = escapeHtml(new URL(targetUrl).hostname || "TaskHandoff App");
  const windowChromeMode = desktopWindowChromeMode();
  const hasHostTitleBar = windowChromeMode !== "macos-overlay";
  const hasCustomWindowControls = windowChromeMode === "custom";
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapedTitle}</title>
    <style>
      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: #071013;
        color: #e6f0f2;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        display: grid;
        grid-template-rows: ${hasHostTitleBar ? "42px minmax(0, 1fr)" : "1fr"};
      }
      header {
        -webkit-app-region: drag;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        border-bottom: 1px solid #1d2d35;
        background: rgb(11 20 24 / 94%);
        padding: 0 12px;
      }
      .windows-native-window-control-space {
        --windows-native-window-control-width: max(
          0px,
          calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))
        );
        width: var(--windows-native-window-control-width);
        flex: 0 0 var(--windows-native-window-control-width);
      }
      .window-controls {
        -webkit-app-region: no-drag;
        display: flex;
        align-items: center;
        gap: 7px;
      }
      .window-control {
        display: grid;
        width: 14px;
        height: 14px;
        place-items: center;
        border: 0;
        border-radius: 50%;
        color: transparent;
        cursor: pointer;
        padding: 0;
      }
      .window-controls:hover .window-control,
      .window-control:focus-visible {
        color: rgb(11 20 24 / 72%);
      }
      .window-control.close {
        background: #ff5f57;
      }
      .window-control.minimize {
        background: #ffbd2e;
      }
      .window-control.maximize {
        background: #28c840;
      }
      .title {
        min-width: 0;
        overflow: hidden;
        color: #f3fbfc;
        font-size: 13px;
        font-weight: 750;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .spacer {
        width: 48px;
      }
    </style>
  </head>
  <body>
    ${hasHostTitleBar ? `<header>
      ${hasCustomWindowControls ? `<div class="window-controls" aria-label="Window controls">
        <button type="button" class="window-control close" aria-label="Close" title="Close" data-action="close">×</button>
        <button type="button" class="window-control minimize" aria-label="Minimize" title="Minimize" data-action="minimize">−</button>
        <button type="button" class="window-control maximize" aria-label="Maximize" title="Maximize" data-action="toggle-maximize">+</button>
      </div>` : ""}
      <div class="title">${escapedTitle}</div>
      ${hasCustomWindowControls
        ? `<div class="spacer" aria-hidden="true"></div>`
        : windowChromeMode === "windows-overlay"
          ? `<div class="windows-native-window-control-space" aria-hidden="true"></div>`
          : ""}
    </header>` : ""}
    <script>
      document.querySelectorAll("[data-action]").forEach((button) => {
        button.addEventListener("click", () => {
          window.taskHandoffDesktop?.windowAction?.(button.dataset.action);
        });
      });
    </script>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlDataUrl(html) {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`;
}

function isHtmlDataUrl(value) {
  return typeof value === "string" && value.startsWith("data:text/html");
}

function desktopWindowWebPreferences(webviewTag = false) {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    preload: path.join(__dirname, "preload.cjs"),
    sandbox: true,
    webviewTag,
  };
}

function openExternalWindowsOnly(webContents) {
  webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    void shell.openExternal(targetUrl);
    return { action: "deny" };
  });
}

function createDesktopBrowserWindow(options, windowsOverlayHeight, browserTabs = false) {
  const window = new BrowserWindow({ ...options, webPreferences: desktopWindowWebPreferences(browserTabs) });
  if (process.platform === "win32") windowsTitleBarOverlayHeights.set(window, windowsOverlayHeight);
  openExternalWindowsOnly(window.webContents);
  if (browserTabs) configureBrowserTabGuests(window.webContents);
  return window;
}

function configureBrowserTabGuests(host) {
  host.once("destroyed", () => {
    for (const [guestId, entry] of desktopBrowserGuests) {
      if (entry.host === host) desktopBrowserGuests.delete(guestId);
    }
    void desktopBrowserContexts?.releaseSender(host.id);
  });
  host.on("did-start-navigation", (_event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    logInfo(`[desktop-shell] browser context sender navigation host=${host.id} url=${browserDiagnosticUrl(url)}; releasing renderer-owned contexts`);
    void desktopBrowserContexts?.releaseSender(host.id);
  });
  host.on("will-attach-webview", (event, webPreferences, params) => {
    const hasContext = Boolean(desktopBrowserContexts?.allows(host.id, params.partition));
    const allowed = hasContext && browserTabUrlAllowed(params.src);
    logInfo(`[desktop-shell] browser webview will-attach host=${host.id} partition=${String(params.partition || "")} src=${browserDiagnosticUrl(params.src)} hasContext=${hasContext} allowed=${allowed}`);
    if (!allowed) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.sandbox = true;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
  });
  host.on("did-attach-webview", (_event, guest) => {
    desktopBrowserGuests.set(guest.id, { guest, host });
    guest.once("destroyed", () => {
      if (desktopBrowserGuests.get(guest.id)?.guest === guest) desktopBrowserGuests.delete(guest.id);
    });
    logInfo(`[desktop-shell] browser webview did-attach host=${host.id} guest=${guest.id} url=${browserDiagnosticUrl(guest.getURL())}`);
    const allowNavigation = (event, targetUrl) => {
      const allowed = browserTabUrlAllowed(targetUrl);
      logInfo(`[desktop-shell] browser webview will-navigate guest=${guest.id} url=${browserDiagnosticUrl(targetUrl)} allowed=${allowed}`);
      if (allowed) return;
      event.preventDefault();
    };
    guest.on("did-start-navigation", (_event, url, _isInPlace, isMainFrame) => {
      logInfo(`[desktop-shell] browser webview did-start-navigation guest=${guest.id} url=${browserDiagnosticUrl(url)} mainFrame=${Boolean(isMainFrame)}`);
    });
    guest.on("did-finish-load", () => {
      logInfo(`[desktop-shell] browser webview did-finish-load guest=${guest.id} url=${browserDiagnosticUrl(guest.getURL())} title=${String(guest.getTitle() || "").slice(0, 160)}`);
    });
    guest.on("page-title-updated", (_event, title) => {
      logInfo(`[desktop-shell] browser webview page-title-updated guest=${guest.id} title=${String(title || "").slice(0, 160)} url=${browserDiagnosticUrl(guest.getURL())}`);
    });
    guest.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      logError(`[desktop-shell] browser webview did-fail-load guest=${guest.id} code=${errorCode} description=${String(errorDescription || "").slice(0, 160)} url=${browserDiagnosticUrl(validatedURL)} mainFrame=${Boolean(isMainFrame)}`);
    });
    guest.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.key?.toLowerCase() !== "l" || (!input.meta && !input.control) || input.alt || input.shift) return;
      event.preventDefault();
      if (!host.isDestroyed()) host.send("task-handoff:browser-focus-address", { webContentsId: guest.id });
    });
    guest.on("will-navigate", allowNavigation);
    guest.on("will-frame-navigate", allowNavigation);
    guest.setWindowOpenHandler(({ url }) => {
      const allowed = browserTabUrlAllowed(url);
      const partition = guest.session?.getPartition?.() || "";
      const instanceId = desktopBrowserContexts?.instanceIdForPartition(host.id, partition);
      logInfo(`[desktop-shell] browser webview popup guest=${guest.id} instance=${instanceId || "unknown"} url=${browserDiagnosticUrl(url)} allowed=${allowed}`);
      if (allowed) {
        try {
          host.send("task-handoff:browser-new-tab", { url: String(url), ...(instanceId ? { instanceId } : {}) });
          logInfo(`[desktop-shell] browser webview popup dispatched host=${host.id} guest=${guest.id}`);
        } catch (error) {
          logError(`[desktop-shell] browser webview popup dispatch failed host=${host.id} guest=${guest.id} error=${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { action: "deny" };
    });
  });
}

function browserTabUrlAllowed(value) {
  try {
    const url = new URL(String(value));
    return url.href === "about:blank" || url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function browserDiagnosticUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 240);
  } catch {
    return String(value || "").slice(0, 240);
  }
}

function trustedControlPlaneSenderUrl(sender) {
  const senderWindow = BrowserWindow.fromWebContents(sender);
  const registeredWindow = senderWindow === mainWindow || Boolean(senderWindow && controlPlaneWindows.metadata(senderWindow));
  if (!registeredWindow) throw new Error("Browser context requests require a trusted Control Plane window.");
  const senderUrl = new URL(sender.getURL());
  const controlPlaneUrl = new URL(currentControlPlaneBaseUrl());
  if (!["http:", "https:"].includes(senderUrl.protocol) || senderUrl.origin !== controlPlaneUrl.origin) {
    throw new Error("Browser context requests require the active Control Plane origin.");
  }
  return senderUrl.toString();
}

function createWindow(url) {
  let failurePageShown = isHtmlDataUrl(url);
  mainWindow = createDesktopBrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    ...nativeTitleBarWindowOptions(),
    show: false,
    title: "TaskHandoff Control Plane",
    icon: desktopIconPath(),
    backgroundColor: desktopWindowBackgroundColor("dark"),
  }, 56, true);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("close", (event) => {
    if (desktopQuitCoordinator?.phase() === "stopping" || ["stopping", "stopped"].includes(desktopServiceSupervisor.snapshot().phase)) return;
    event.preventDefault();
    desktopWindows?.background();
    if (process.platform !== "darwin" && Notification.isSupported()) {
      try {
        if (claimBackgroundNotice(resolveDataDir())) {
          new Notification({
            title: "TaskHandoff",
            body: app.getLocale().toLowerCase().startsWith("zh")
              ? "TaskHandoff 仍在后台运行，可从系统托盘重新打开或退出。"
              : "TaskHandoff is still running. Use the system tray to reopen or quit.",
          }).show();
        }
      } catch (error) {
        logError(`[desktop-shell] failed to persist background notice ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    const detail = `${validatedUrl || url}\n${errorCode}: ${errorDescription}`;
    logError(`[desktop-shell] failed to load ${detail}`);
    if (isMainFrame === false) {
      return;
    }
    showMainFailurePage("TaskHandoff failed to load", detail);
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    const detail = JSON.stringify(details, null, 2);
    logError(`[desktop-shell] render process gone ${detail}`);
    showMainFailurePage("TaskHandoff renderer stopped", detail);
  });

  void mainWindow.loadURL(url).catch((error) => {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    logError(`[desktop-shell] loadURL failed ${detail}`);
    showMainFailurePage("TaskHandoff failed to load", detail);
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  function showMainFailurePage(title, detail) {
    if (failurePageShown) {
      logError(`[desktop-shell] suppressing recursive failure page ${title}: ${detail}`);
      return;
    }
    failurePageShown = true;
    void mainWindow?.loadURL(htmlDataUrl(renderFailurePage(title, detail))).catch((error) => {
      const loadError = error instanceof Error ? error.stack || error.message : String(error);
      logError(`[desktop-shell] failure page load failed ${loadError}`);
    });
  }
  return mainWindow;
}

function resolveControlPlaneWindowUrl(url) {
  const baseUrl = currentControlPlaneBaseUrl();
  return validateControlPlaneWindowUrl(url, { baseUrl });
}

function currentControlPlaneBaseUrl() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL().startsWith("http")) {
    return mainWindow.webContents.getURL();
  }
  const endpoint = desktopServiceSupervisor.endpoint();
  if (!endpoint) throw new Error("The Desktop Control Plane endpoint is not available.");
  return endpoint;
}

function createControlPlaneWindow(url) {
  const parsedUrl = resolveControlPlaneWindowUrl(url);
  const instanceRoute = parsedUrl.pathname.match(/^\/instance-detail\/([^/]+)$/);
  const instanceId = instanceRoute ? decodeURIComponent(instanceRoute[1]) : undefined;
  if (instanceId) {
    const existing = controlPlaneWindows.focusInstance(instanceId);
    if (existing) {
      logInfo(`[desktop-shell] focused existing instance detail window instanceId=${instanceId}`);
      return existing;
    }
  }
  logInfo(`[desktop-shell] creating control plane child window url=${parsedUrl.toString()} instanceId=${instanceId || ""}`);
  const initialSize = instanceId
    ? desktopWindowPreferences?.instanceDetailSize() || { width: 1280, height: 820 }
    : { width: 1280, height: 820 };
  const controlPlaneWindow = createDesktopBrowserWindow({
    ...initialSize,
    minWidth: instanceId ? 400 : 760,
    minHeight: 520,
    ...compactTitleBarWindowOptions(),
    show: false,
    title: "TaskHandoff",
    icon: desktopIconPath(),
    backgroundColor: "#071013",
  }, 42, true);
  if (instanceId) {
    let persistSizeTimer;
    const persistSize = () => {
      if (controlPlaneWindow.isDestroyed() || controlPlaneWindow.isMaximized() || controlPlaneWindow.isFullScreen()) return;
      desktopWindowPreferences?.rememberInstanceDetailSize(controlPlaneWindow.getBounds());
    };
    controlPlaneWindow.on("resize", () => {
      if (persistSizeTimer) clearTimeout(persistSizeTimer);
      persistSizeTimer = setTimeout(persistSize, 180);
    });
    controlPlaneWindow.on("close", persistSize);
    controlPlaneWindow.once("closed", () => {
      if (persistSizeTimer) clearTimeout(persistSizeTimer);
    });
  }
  const registered = controlPlaneWindows.register(controlPlaneWindow, instanceId
    ? { kind: "instance-detail", instanceId }
    : { kind: "repository" });
  if (registered.action !== "registered") {
    controlPlaneWindow.destroy();
    return registered;
  }
  controlPlaneWindow.once("ready-to-show", () => {
    logInfo(`[desktop-shell] control plane child window ready instanceId=${instanceId || ""}`);
    controlPlaneWindow.show();
  });
  controlPlaneWindow.webContents.on("did-fail-load", (_event, code, description, validatedUrl) => {
    logError(`[desktop-shell] control plane child window did-fail-load code=${code} description=${description} url=${validatedUrl}`);
  });
  controlPlaneWindow.webContents.on("render-process-gone", (_event, details) => {
    logError(`[desktop-shell] control plane child renderer gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
  void controlPlaneWindow.loadURL(parsedUrl.toString()).catch((error) => {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    logError(`[desktop-shell] control plane window loadURL failed ${detail}`);
    if (!controlPlaneWindow.isDestroyed()) controlPlaneWindow.close();
  });
  return { action: "opened", instanceId, window: controlPlaneWindow };
}

function createAppWindow(url) {
  const parsedUrl = resolveAppWindowUrl(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Only HTTP(S) app windows are supported.");
  }
  const appWindow = createDesktopBrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    ...compactTitleBarWindowOptions(),
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    show: false,
    title: "TaskHandoff App",
    icon: desktopIconPath(),
    backgroundColor: "#071013",
  }, 42);
  const appView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const resizeAppView = () => {
    if (appWindow.isDestroyed()) {
      return;
    }
    const [width, height] = appWindow.getContentSize();
    const headerHeight = desktopWindowChromeMode() === "macos-overlay" ? 0 : 42;
    appView.setBounds({ x: 0, y: headerHeight, width, height: Math.max(0, height - headerHeight) });
  };
  appWindow.setBrowserView(appView);
  resizeAppView();
  appWindow.on("resize", resizeAppView);
  appWindow.on("closed", () => {
    appWindow.removeListener("resize", resizeAppView);
  });
  openExternalWindowsOnly(appView.webContents);
  appWindow.once("ready-to-show", () => {
    appWindow.show();
  });
  void appView.webContents.loadURL(parsedUrl.toString()).catch((error) => {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    logError(`[desktop-shell] app view loadURL failed ${detail}`);
  });
  void appWindow.loadURL(htmlDataUrl(renderAppWindowPage(parsedUrl.toString()))).catch((error) => {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    logError(`[desktop-shell] app window loadURL failed ${detail}`);
    void appWindow.loadURL(htmlDataUrl(renderFailurePage("TaskHandoff app failed to load", detail))).catch((failureError) => {
      const failureDetail = failureError instanceof Error ? failureError.stack || failureError.message : String(failureError);
      logError(`[desktop-shell] app failure page load failed ${failureDetail}`);
    });
  });
  return appWindow;
}

function resolveAppWindowUrl(url) {
  const value = String(url || "");
  if (/^[a-z][a-z\d+\-.]*:/i.test(value)) {
    return new URL(value);
  }
  const base = currentControlPlaneBaseUrl();
  return new URL(value, base);
}

function localHttpUrl(host, port) {
  return `http://${host}:${port}`;
}

function parseNodeAgentIpcEndpoint(endpoint) {
  return endpoint.startsWith(NODE_AGENT_IPC_ENDPOINT_PREFIX)
    ? decodeURIComponent(endpoint.slice(NODE_AGENT_IPC_ENDPOINT_PREFIX.length))
    : undefined;
}

function fetchNodeAgentIpcHealth(socketPath) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      method: "GET",
      path: "/api/node-agent/health",
      headers: {
        host: "task-handoff-node-agent.local",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let payload = {};
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          payload = {};
        }
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode || 500,
          payload,
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function fetchNodeAgentHealth(endpoint) {
  const ipcPath = parseNodeAgentIpcEndpoint(endpoint);
  if (ipcPath) {
    return fetchNodeAgentIpcHealth(ipcPath);
  }
  const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/node-agent/health`);
  return {
    ok: response.ok,
    status: response.status,
    payload: await response.json().catch(() => ({})),
  };
}

async function canBindPort(host, port) {
  const occupied = await new Promise((resolve) => {
    const socket = net.createConnection({ host: host === "0.0.0.0" ? "127.0.0.1" : host, port });
    const finish = (connected) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
  if (occupied) return false;
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function findAvailablePort(host, preferredPort, attempts = 20, label = "Desktop service") {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferredPort + offset;
    if (await canBindPort(host, port)) {
      return port;
    }
  }
  throw new Error(`No available ${label} port found starting at ${preferredPort}.`);
}

function startControlPlane(options = {}) {
  const root = resolveDesktopRuntimeRoot({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, root: repoRoot() });
  const validation = validateDesktopInputs({ root });
  if (!validation.cliReady) {
    throw new Error(`TaskHandoff CLI entry was not found at ${validation.cliEntry}. Run the repository build first.`);
  }
  if (!validation.staticReady) {
    throw new Error(`Control Plane UI was not found at ${validation.staticDir}. Run pnpm run control-plane-ui:build first.`);
  }

  const nodeCommand = resolveNodeCommand(process.env, { packaged: app.isPackaged, execPath: process.execPath });
  const host = options.host || resolveControlPlaneHost();
  const port = options.port || resolveControlPlanePort();
  const args = buildControlPlaneArgs({ root, host, port });
  const processCwd = resolveDesktopProcessCwd(process.env, { packaged: app.isPackaged, root });
  fs.mkdirSync(processCwd, { recursive: true });
  controlPlaneProcess = spawn(nodeCommand, args, {
    cwd: processCwd,
    env: {
      ...buildDesktopChildProcessEnv(process.env, {
        packaged: app.isPackaged,
        version: app.getVersion(),
        overrides: {
          TASK_HANDOFF_CONTROL_PLANE_HOST: host,
          TASK_HANDOFF_CONTROL_PLANE_PORT: String(port),
          TASK_HANDOFF_NODE_AGENT_CONTROL_ENDPOINT: options.nodeAgentControlEndpoint || resolveNodeAgentControlEndpoint(),
          TASK_HANDOFF_NODE_AGENT_ENDPOINT: options.nodeAgentEndpoint || nodeAgentUrl(),
        },
      }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  ownsControlPlaneProcess = true;
  const child = controlPlaneProcess;

  superviseDesktopChild(child, {
    label: "control-plane",
    command: nodeCommand,
    cwd: processCwd,
    logInfo,
    logError,
    onError: (error) => childProcessSpawnErrors.set(child, error),
    onExit: () => {
      controlPlaneProcess = undefined;
      ownsControlPlaneProcess = false;
      desktopServiceSupervisor.markComponentStopped("control-plane");
    },
  });

  return child;
}

function startNodeAgent(options = {}) {
  const root = resolveDesktopRuntimeRoot({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, root: repoRoot() });
  const validation = validateDesktopInputs({ root });
  if (!validation.cliReady) {
    throw new Error(`TaskHandoff CLI entry was not found at ${validation.cliEntry}. Run the repository build first.`);
  }

  const nodeCommand = resolveNodeCommand(process.env, { packaged: app.isPackaged, execPath: process.execPath });
  const host = options.host || resolveNodeAgentHost();
  const port = options.port || resolveNodeAgentPort();
  const args = buildNodeAgentArgs({ root, host, port });
  const processCwd = resolveDesktopProcessCwd(process.env, { packaged: app.isPackaged, root });
  fs.mkdirSync(processCwd, { recursive: true });
  const logDir = path.join(resolveNodeAgentDataDir(), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const stdout = fs.openSync(path.join(logDir, "node-agent.out.log"), "a", 0o600);
  const stderr = fs.openSync(path.join(logDir, "node-agent.err.log"), "a", 0o600);
  try {
    nodeAgentProcess = spawn(nodeCommand, args, {
      cwd: processCwd,
      detached: true,
      env: {
        ...buildDesktopChildProcessEnv(process.env, {
          packaged: app.isPackaged,
          version: app.getVersion(),
          overrides: {
            TASK_HANDOFF_NODE_AGENT_HOST: host,
            TASK_HANDOFF_NODE_AGENT_PORT: String(port),
            TASK_HANDOFF_BUNDLED_RUNTIME_DIR: process.env.TASK_HANDOFF_BUNDLED_RUNTIME_DIR || path.join(root, "release", "runtime-artifacts"),
            TASK_HANDOFF_LOCAL_CONTROLLED_COMMAND_ARGV: JSON.stringify([nodeCommand, validation.cliEntry, "web"]),
            TASK_HANDOFF_LOCAL_INSTANCE_PORT_CONFLICT: "allocate",
            TASK_HANDOFF_NODE_AGENT_PORT_CONFLICT: "allocate",
          },
        }),
      },
      stdio: ["ignore", stdout, stderr],
      windowsHide: true,
    });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  const child = nodeAgentProcess;

  superviseDesktopChild(child, {
    label: "node-agent",
    command: nodeCommand,
    cwd: processCwd,
    logInfo,
    logError,
    onError: (error) => childProcessSpawnErrors.set(child, error),
    onExit: () => {
      nodeAgentProcess = undefined;
      desktopServiceSupervisor.markComponentStopped("node-agent");
    },
  });

  return child;
}

async function waitForControlPlane(url, child, options = {}) {
  const attempts = options.attempts ?? 80;
  const expectedDataDir = options.dataDir || resolveDataDir();
  const expectedHost = options.host || resolveControlPlaneHost();
  const expectedPort = options.port || resolveControlPlanePort();
  for (let index = 0; index < attempts; index += 1) {
    const spawnError = childProcessSpawnErrors.get(child);
    if (spawnError) {
      throw new Error(`Control Plane failed to spawn: ${spawnError.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Control Plane exited before becoming ready code=${child.exitCode ?? ""} signal=${child.signalCode ?? ""}.`);
    }
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) {
        const payload = await response.json();
        const health = payload?.data;
        const owner = inspectStartedDesktopControlPlane({
          pid: child.pid,
          dataDir: expectedDataDir,
          host: expectedHost,
          port: expectedPort,
        });
        if (
          health?.ok === true
          && health?.role === "control-plane"
          && health?.build?.component === "control-plane"
          && owner.status === "running"
        ) {
          return;
        }
      }
    } catch {
      // The server is still starting.
    }
    await delay(250);
  }
  throw new Error(`Control Plane did not become ready at ${url}.`);
}

async function waitForNodeAgent(endpoint, child, attempts = 80) {
  for (let index = 0; index < attempts; index += 1) {
    const spawnError = childProcessSpawnErrors.get(child);
    if (spawnError) {
      throw new Error(`Node agent failed to spawn: ${spawnError.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Node agent exited before becoming ready code=${child.exitCode ?? ""} signal=${child.signalCode ?? ""}.`);
    }
    try {
      const response = await fetchNodeAgentHealth(endpoint);
      if (response.ok && response.payload?.data?.role === "node-agent") {
        return response.payload.data;
      }
    } catch {
      // The agent is still starting.
    }
    await delay(250);
  }
  throw new Error(`Node agent did not become ready at ${endpoint}.`);
}

function stopControlPlane() {
  if (!controlPlaneProcess || !ownsControlPlaneProcess) {
    return Promise.resolve();
  }
  const child = controlPlaneProcess;
  controlPlaneProcess = undefined;
  ownsControlPlaneProcess = false;
  return stopSupervisedDesktopChild(child, {
    label: "Control Plane",
    onForce: () => logError("[desktop-shell] forcing control plane to stop"),
  });
}

async function stopNodeAgent() {
  const child = nodeAgentProcess;
  nodeAgentProcess = undefined;
  const result = await stopExistingDesktopNodeAgent({
    dataDir: resolveNodeAgentDataDir(),
    logInfo,
    logError,
  });
  if (["absent", "stale"].includes(result.status) && child) {
    await stopSupervisedDesktopChild(child, {
      label: "Node agent",
      gracefulTimeoutMs: DESKTOP_NODE_AGENT_GRACEFUL_TIMEOUT_MS,
      forceTimeoutMs: DESKTOP_NODE_AGENT_FORCE_TIMEOUT_MS,
      onForce: () => logError("[desktop-shell] forcing node agent to stop after graceful shutdown timeout"),
    });
  }
  if (result.status === "foreign") {
    throw new Error(`Refusing to stop node agent pid=${result.owner.pid} owned by dataDir=${result.owner.dataDir}.`);
  }
  if (result.status === "unverified") {
    throw new Error(`Refusing to stop node agent pid=${result.owner.pid} because its process identity could not be verified.`);
  }
}

const desktopServiceLifecycle = createDesktopServiceLifecycle({ stopControlPlane, stopNodeAgent });
desktopQuitCoordinator = createDesktopQuitCoordinator({
  stop: (reason) => desktopServiceLifecycle.stop(reason),
  onStopping: () => {
    desktopServiceSupervisor.markStopping();
    controlPlaneWindows.closeAll();
  },
  onError: (error, reason) => logError(`[desktop-shell] failed to stop desktop services during ${reason} ${error instanceof Error ? error.stack || error.message : String(error)}`),
  onStopped: () => desktopServiceSupervisor.markStopped(),
});

async function boot() {
  desktopServiceSupervisor.markStarting();
  if (desktopFileLoggingEnabled()) {
    logInfo(`[desktop-shell] writing desktop logs to ${resolveDesktopLogFile()}`);
  }
  const existingControlPlane = inspectExistingDesktopControlPlane();
  if (existingControlPlane.status === "running") {
    throw new Error(`A Control Plane is already running pid=${existingControlPlane.owner.pid}. Close it before starting Desktop.`);
  }
  if (existingControlPlane.status === "unverified") {
    throw new Error(`The existing Control Plane pid=${existingControlPlane.owner.pid} could not be verified.`);
  }
  const nodeAgentDataDir = resolveNodeAgentDataDir();
  const nodeAgentControlEndpoint = resolveNodeAgentControlEndpoint();
  let bootNodeAgent;
  let nodeAgentReady = false;
  try {
    const controlPlaneHost = resolveControlPlaneHost();
    const controlPlanePort = await findAvailablePort(controlPlaneHost, resolveControlPlanePort(), 20, "control-plane");
    const url = localHttpUrl(controlPlaneHost, controlPlanePort);
    const nodeAgentHost = resolveNodeAgentHost();
    const nodeAgentPort = resolveNodeAgentPort();
    const ensuredNodeAgent = await ensureDesktopNodeAgent({
      dataDir: nodeAgentDataDir,
      start: () => startNodeAgent({ host: nodeAgentHost, port: nodeAgentPort }),
      waitUntilReady: (child) => waitForNodeAgent(nodeAgentControlEndpoint, child),
      logInfo,
      logError,
    });
    bootNodeAgent = ensuredNodeAgent.child;
    nodeAgentReady = true;
    desktopServiceSupervisor.markNodeAgentRunning();
    const nodeAgentHealth = ensuredNodeAgent.health;
    const actualNodeAgentPort = Number(nodeAgentHealth?.listener?.port) || nodeAgentPort;
    const nodeAgentEndpoint = localHttpUrl(nodeAgentHost, actualNodeAgentPort);
    const child = startControlPlane({ host: controlPlaneHost, port: controlPlanePort, nodeAgentEndpoint, nodeAgentControlEndpoint });
    await waitForControlPlane(url, child, { host: controlPlaneHost, port: controlPlanePort });
    desktopServiceLifecycle.markRunning();
    desktopServiceSupervisor.markRunning(url);
    desktopWindows.open();
    bootNodeAgent?.unref?.();
  } catch (error) {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    desktopServiceSupervisor.markDegraded(error);
    logError(`[desktop-shell] desktop services failed to start ${detail}`);
    await desktopServiceLifecycle.stop("boot-failure", { nodeAgentReady }).catch((cleanupError) => {
      logError(`[desktop-shell] failed to roll back desktop services ${cleanupError instanceof Error ? cleanupError.stack || cleanupError.message : String(cleanupError)}`);
    });
    if (nodeAgentReady) {
      bootNodeAgent?.unref?.();
    }
    desktopWindows.attach(createWindow(htmlDataUrl(renderFailurePage("TaskHandoff desktop services failed", detail))));
  }
}

async function prepareDesktopUpdateInstall() {
  await desktopQuitCoordinator.request("update");
}

ipcMain.handle("task-handoff:choose-project-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose project folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? undefined : { path: result.filePaths[0] };
});

ipcMain.handle("task-handoff:open-local-path", async (_event, localPath) => {
  const normalized = typeof localPath === "string" ? localPath.trim() : "";
  if (!normalized || !path.isAbsolute(normalized)) return { ok: false, code: "invalid-local-path" };
  try {
    if (!fs.statSync(normalized).isDirectory()) return { ok: false, code: "local-path-not-directory" };
  } catch {
    return { ok: false, code: "local-path-unavailable" };
  }
  const error = await shell.openPath(normalized);
  return error ? { ok: false, code: "open-local-path-failed", error } : { ok: true };
});

ipcMain.handle("task-handoff:reveal-local-path", async (_event, localPath) => {
  const normalized = typeof localPath === "string" ? localPath.trim() : "";
  if (!normalized || !path.isAbsolute(normalized)) return { ok: false, code: "invalid-local-path" };
  try { if (!fs.statSync(normalized).isFile() && !fs.statSync(normalized).isDirectory()) return { ok: false, code: "local-path-unavailable" }; }
  catch { return { ok: false, code: "local-path-unavailable" }; }
  shell.showItemInFolder(normalized);
  return { ok: true };
});

ipcMain.handle("task-handoff:open-external-url", async (_event, value) => {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return { ok: false, code: "invalid-url" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, code: "unsupported-url" };
  const error = await shell.openExternal(url.toString()).then(() => undefined).catch((cause) => cause instanceof Error ? cause.message : String(cause));
  return error ? { ok: false, code: "open-external-url-failed", error } : { ok: true };
});

ipcMain.handle("task-handoff:open-app-window", (_event, url) => {
  createAppWindow(url);
  return { ok: true };
});

ipcMain.handle("task-handoff:browser-context-prepare", async (event, instanceId) => {
  const normalized = String(instanceId || "").trim();
  if (!normalized || normalized.length > 160 || !desktopBrowserContexts) {
    return { ok: false, code: "browser-context-invalid" };
  }
  try {
    const senderUrl = trustedControlPlaneSenderUrl(event.sender);
    const context = await desktopBrowserContexts.prepare({
      controlPlaneUrl: senderUrl,
      instanceId: normalized,
      senderId: event.sender.id,
    });
    return { ok: true, ...context };
  } catch (error) {
    logError(`[desktop-shell] browser context prepare failed instanceId=${normalized} error=${error instanceof Error ? error.message : String(error)}`);
    const code = error?.code || "browser-context-unavailable";
    return { ok: false, code, message: browserContextDiagnosticMessage(code, error) };
  }
});

ipcMain.handle("task-handoff:browser-context-release", async (event, contextId) => ({
  ok: Boolean(desktopBrowserContexts && await desktopBrowserContexts.release(String(contextId || ""), event.sender.id)),
}));

ipcMain.handle("task-handoff:browser-context-touch", (event, contextId) => ({
  ok: Boolean(desktopBrowserContexts?.touch(String(contextId || ""), event.sender.id)),
}));
ipcMain.handle("task-handoff:browser-tab-throttled", (event, webContentsId, throttled) => {
  const id = Number(webContentsId);
  const entry = Number.isInteger(id) ? desktopBrowserGuests.get(id) : undefined;
  if (!entry || entry.host !== event.sender || typeof entry.guest.setBackgroundThrottling !== "function") return { ok: false };
  entry.guest.setBackgroundThrottling(Boolean(throttled));
  return { ok: true };
});

ipcMain.on("task-handoff:browser-diagnostic", (event, input) => {
  const message = input && typeof input === "object" && typeof input.message === "string"
    ? input.message.trim().slice(0, 240)
    : "";
  if (!message) return;
  const instanceId = input && typeof input === "object" && typeof input.instanceId === "string"
    ? input.instanceId.trim().slice(0, 160)
    : "";
  logInfo(`[desktop-shell] browser renderer diagnostic sender=${event.sender.id}${instanceId ? ` instanceId=${instanceId}` : ""} message=${message}`);
});

ipcMain.handle("task-handoff:open-control-plane-window", (_event, url) => {
  const result = createControlPlaneWindow(url);
  return { ok: true, action: result.action };
});

ipcMain.handle("task-handoff:open-instance-detail-window", (_event, instanceId) => {
  const normalized = String(instanceId || "").trim();
  if (!normalized) return { ok: false, code: "invalid-instance-id" };
  try {
    logInfo(`[desktop-shell] open instance detail window requested instanceId=${normalized}`);
    const result = createControlPlaneWindow(`/instance-detail/${encodeURIComponent(normalized)}`);
    return { ok: true, action: result.action, instanceId: normalized };
  } catch (error) {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    logError(`[desktop-shell] open instance detail window failed instanceId=${normalized} error=${detail}`);
    return { ok: false, action: "error", code: "window-open-failed", instanceId: normalized };
  }
});

ipcMain.handle("task-handoff:switch-instance-detail-window", (event, instanceId) => {
  const normalized = String(instanceId || "").trim();
  if (!normalized) return { ok: false, action: "error", code: "invalid-instance-id" };
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  if (!targetWindow || targetWindow.isDestroyed()) return { ok: false, action: "error", code: "invalid-window" };
  const result = controlPlaneWindows.switchInstance(targetWindow, normalized);
  return { ok: result.action !== "error", ...result };
});

function senderInstanceDetailWindow(event) {
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  return targetWindow
    && !targetWindow.isDestroyed()
    && controlPlaneWindows.metadata(targetWindow)?.kind === "instance-detail"
    ? targetWindow
    : undefined;
}

ipcMain.handle("task-handoff:get-window-always-on-top", (event) => {
  const targetWindow = senderInstanceDetailWindow(event);
  return targetWindow
    ? { ok: true, alwaysOnTop: targetWindow.isAlwaysOnTop() }
    : { ok: false, code: "not-instance-window", alwaysOnTop: false };
});

ipcMain.handle("task-handoff:set-window-always-on-top", (event, enabled) => {
  const targetWindow = senderInstanceDetailWindow(event);
  if (!targetWindow || typeof enabled !== "boolean") {
    return { ok: false, code: targetWindow ? "invalid-enabled" : "not-instance-window", alwaysOnTop: false };
  }
  targetWindow.setAlwaysOnTop(enabled);
  return { ok: true, alwaysOnTop: targetWindow.isAlwaysOnTop() };
});

ipcMain.handle("task-handoff:window-action", (_event, action) => {
  const targetWindow = BrowserWindow.fromWebContents(_event.sender) || mainWindow;
  if (!targetWindow || targetWindow.isDestroyed()) {
    return { ok: false };
  }
  if (action === "minimize") {
    targetWindow.minimize();
  } else if (action === "toggle-maximize") {
    if (targetWindow.isMaximized()) {
      targetWindow.unmaximize();
    } else {
      targetWindow.maximize();
    }
  } else if (action === "close") {
    targetWindow.close();
  }
  return { ok: true, maximized: !targetWindow.isDestroyed() ? targetWindow.isMaximized() : false };
});

ipcMain.on("task-handoff:window-drag", (event, payload) => {
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  const phase = payload?.phase;
  const screenX = Number(payload?.screenX);
  const screenY = Number(payload?.screenY);
  if (!targetWindow || targetWindow.isDestroyed() || !["start", "move", "end"].includes(phase)) return;
  if (phase === "end") {
    windowDragStates.delete(event.sender);
    return;
  }
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
  if (phase === "start") {
    if (targetWindow.isMaximized() || targetWindow.isFullScreen()) return;
    const [windowX, windowY] = targetWindow.getPosition();
    windowDragStates.set(event.sender, { targetWindow, screenX, screenY, windowX, windowY });
    return;
  }
  const drag = windowDragStates.get(event.sender);
  if (!drag || drag.targetWindow !== targetWindow || targetWindow.isMaximized() || targetWindow.isFullScreen()) return;
  targetWindow.setPosition(
    Math.round(drag.windowX + screenX - drag.screenX),
    Math.round(drag.windowY + screenY - drag.screenY),
  );
});

ipcMain.handle("task-handoff:set-window-chrome-theme", (_event, theme) => {
  const targetWindow = BrowserWindow.fromWebContents(_event.sender);
  if (!targetWindow || targetWindow.isDestroyed() || !["light", "dark"].includes(theme)) {
    return { ok: false };
  }
  targetWindow.setBackgroundColor(desktopWindowBackgroundColor(theme));
  const height = windowsTitleBarOverlayHeights.get(targetWindow);
  if (process.platform === "win32" && height) {
    applyWindowsTitleBarTheme(targetWindow, nativeTheme, { height, theme });
  }
  return { ok: true };
});

ipcMain.handle("task-handoff:desktop-update-get-state", () => desktopUpdater?.getState());
ipcMain.handle("task-handoff:desktop-update-check", () => desktopUpdater?.check());
ipcMain.handle("task-handoff:desktop-update-download", () => desktopUpdater?.download());
ipcMain.handle("task-handoff:desktop-update-install", () => desktopUpdater?.install());
ipcMain.handle("task-handoff:desktop-update-set-channel", (_event, channel) => desktopUpdater?.setChannel(channel));
ipcMain.handle("task-handoff:desktop-update-open-release", () => {
  const url = desktopUpdater?.getState().releaseUrl || "https://github.com/edgestorage/task-handoff/releases";
  return shell.openExternal(url);
});

ipcMain.handle("task-handoff:set-diagnostic-logs-enabled", (_event, enabled) => {
  desktopFileLoggingOverride = enabled === true;
  if (desktopFileLoggingOverride) {
    logInfo(`[desktop-shell] diagnostic file logging enabled; writing to ${resolveDesktopLogFile()}`);
  } else {
    closeDesktopFileLog();
  }
  return { enabled: desktopFileLoggingOverride };
});

desktopWindows = createDesktopWindowManager({
  endpoint: () => desktopServiceSupervisor.endpoint(),
  create: (url) => createWindow(url),
});

function openDesktopSettings() {
  const window = desktopWindows.open();
  if (!window || window.isDestroyed()) return;
  const send = () => {
    if (!window.isDestroyed()) window.webContents.send("task-handoff:open-settings");
  };
  if (window.webContents.isLoadingMainFrame()) window.webContents.once("did-finish-load", send);
  else send();
}

function openDesktopInstance(instanceId, source) {
  try {
    createControlPlaneWindow(`/instance-detail/${encodeURIComponent(instanceId)}`);
  } catch (error) {
    logError(`[desktop-shell] ${source} failed to open instance window instanceId=${instanceId} error=${error instanceof Error ? error.stack || error.message : String(error)}`);
  }
}

function activateExistingDesktopWindows() {
  return activateExistingDesktopWindow({
    windows: BrowserWindow.getAllWindows(),
    focusedWindow: BrowserWindow.getFocusedWindow(),
    onEmpty: () => desktopWindows.open(),
  });
}

const ownsDesktopInstanceLock = app.requestSingleInstanceLock();

if (!ownsDesktopInstanceLock) {
  logInfo("[desktop-shell] another Desktop process already owns the application lock; exiting");
  app.quit();
} else {
  app.on("second-instance", () => {
    desktopWindows.open();
  });

  app.whenReady().then(() => {
    desktopBrowserContexts = new DesktopBrowserContextManager({
      fetch: (url, init) => fetchControlPlaneWithSessionCookies(url, init),
      WebSocket,
      session,
      logInfo,
      logError,
      chooseDownloadPath: (filename) => dialog.showSaveDialogSync({ defaultPath: path.join(app.getPath("downloads"), filename) }),
    });
    setDesktopDockIcon();
    desktopWindowPreferences = createDesktopWindowPreferences({
      file: path.join(app.getPath("userData"), "desktop-window-preferences.json"),
    });
    desktopDockMenu = createDesktopDockMenu({
      dock: process.platform === "darwin" ? app.dock : undefined,
      Menu,
      locale: app.getLocale(),
      onOpen: () => desktopWindows.open(),
      onOpenInstance: (instanceId) => openDesktopInstance(instanceId, "dock menu"),
    });
    desktopTray = createDesktopTray({
      Tray,
      Menu,
      nativeImage,
      iconPath: desktopTrayIconPath(),
      platform: process.platform,
      locale: app.getLocale(),
      supervisor: desktopServiceSupervisor,
      onOpen: () => desktopWindows.open(),
      onActivateExisting: activateExistingDesktopWindows,
      onSettings: openDesktopSettings,
      loadInstances: () => loadDesktopInstanceDirectory({
        endpoint: desktopServiceSupervisor.endpoint(),
        fetch: (url, init) => electronNet.fetch(url, { ...init, useSessionCookies: true }),
      }),
      onOpenInstance: (instanceId) => openDesktopInstance(instanceId, "tray"),
      onInstanceDirectoryChange: (snapshot) => desktopDockMenu?.update(snapshot),
      onDirectoryError: (error) => logError(`[desktop-shell] tray failed to refresh instance directory ${error instanceof Error ? error.stack || error.message : String(error)}`),
      onQuit: () => app.quit(),
    });
    desktopUpdater = createDesktopUpdater({
      app,
      autoUpdater,
      BrowserWindow,
      logInfo,
      logError,
      install: prepareDesktopUpdateInstall,
    });
    desktopUpdater.start();
    void boot().catch((error) => {
      dialog.showErrorBox("TaskHandoff failed to start", error instanceof Error ? error.message : String(error));
      app.quit();
    });
  });

  app.on("activate", () => {
    activateExistingDesktopWindows();
  });

  app.on("before-quit", (event) => {
    desktopUpdater?.stop();
    if (desktopQuitCoordinator.isReadyToExit()) {
      void desktopBrowserContexts?.close();
      desktopServiceSupervisor.markStopped();
      desktopTray?.destroy();
      desktopDockMenu?.destroy();
      desktopTray = undefined;
      closeDesktopFileLog();
      return;
    }
    event.preventDefault();
    void desktopQuitCoordinator.request("quit").finally(() => {
      desktopTray?.destroy();
      desktopDockMenu?.destroy();
      desktopTray = undefined;
      desktopDockMenu = undefined;
      closeDesktopFileLog();
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    // Closing UI windows enters background service mode. Only an explicit quit stops services.
  });
}

async function fetchControlPlaneWithSessionCookies(url, init = {}) {
  const target = new URL(String(url));
  const cookieOrigins = [target.origin];
  if (target.hostname === "localhost") cookieOrigins.push(`${target.protocol}//127.0.0.1${target.port ? `:${target.port}` : ""}`);
  if (target.hostname === "127.0.0.1") cookieOrigins.push(`${target.protocol}//localhost${target.port ? `:${target.port}` : ""}`);
  const cookies = (await Promise.all(cookieOrigins.map((origin) => session.defaultSession.cookies.get({ url: origin }))) )
    .flat()
    .filter((cookie, index, all) => all.findIndex((candidate) => candidate.name === cookie.name && candidate.value === cookie.value) === index);
  logInfo(`[desktop-shell] browser auth cookie lookup host=${target.hostname} candidates=${cookieOrigins.length} found=${cookies.length}`);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const headers = new Headers(init.headers || {});
  if (cookieHeader && !headers.has("cookie")) headers.set("cookie", cookieHeader);
  return electronNet.fetch(target.toString(), {
    ...init,
    headers,
    credentials: "include",
    useSessionCookies: true,
  });
}

function browserContextDiagnosticMessage(code, error) {
  const messages = {
    BROWSER_ACCESS_USER_REQUIRED: "Control Plane did not receive a signed-in user session. Restart the desktop app after signing in again.",
    BROWSER_TUNNEL_UNSUPPORTED: "This controlled instance does not support Browser Tunnel.",
    BROWSER_TUNNEL_HANDSHAKE_TIMEOUT: "Browser tunnel handshake timed out. Check that the node agent and controlled instance are running.",
    BROWSER_ACCESS_TOKEN_INVALID: "The browser access authorization expired. Close this tab and open a new one.",
    "browser-context-invalid": "This browser context request is not trusted.",
    "browser-context-unavailable": "Browser tunnel could not be established.",
  };
  if (messages[code]) return messages[code];
  if (error instanceof Error && error.message && !(/[\\n\\r]/.test(error.message))) return error.message.slice(0, 240);
  return code ? `Browser access failed (${code}).` : "Browser access could not be prepared.";
}
