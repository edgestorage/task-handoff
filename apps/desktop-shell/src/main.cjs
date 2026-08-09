const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { app, BrowserView, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const {
  buildControlPlaneArgs,
  buildDesktopChildProcessEnv,
  buildNodeAgentArgs,
  controlPlaneUrl,
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
const {
  ensureDesktopNodeAgent,
  inspectExistingDesktopControlPlane,
  stopExistingDesktopNodeAgent,
} = require("./node-agent-handoff.cjs");
const { applyDesktopDockIcon, desktopIconPath: resolveDesktopIconPath } = require("./icon.cjs");
const { applyWindowsTitleBarTheme, desktopTitleBarOptions, desktopWindowChromeMode } = require("./window-chrome.cjs");
const { appendRotatingLog } = require("./rotating-log.cjs");

let mainWindow;
let controlPlaneProcess;
let nodeAgentProcess;
let ownsControlPlaneProcess = false;
let ownsNodeAgentProcess = false;
let desktopFileLoggingOverride;
let desktopUpdater;
let desktopQuitPromise;
let desktopQuitReady = false;
const controlPlaneWindows = new Set();
const windowsTitleBarOverlayHeights = new WeakMap();
const childProcessSpawnErrors = new WeakMap();
const NODE_AGENT_IPC_ENDPOINT_PREFIX = "ipc://";

function desktopIconPath() {
  return resolveDesktopIconPath({
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

function appWindowTitleBarWindowOptions() {
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

function createWindow(url) {
  let failurePageShown = isHtmlDataUrl(url);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    ...nativeTitleBarWindowOptions(),
    show: false,
    title: "TaskHandoff Control Plane",
    icon: desktopIconPath(),
    backgroundColor: "#eef3f4",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
    },
  });
  if (process.platform === "win32") windowsTitleBarOverlayHeights.set(mainWindow, 56);

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    void shell.openExternal(targetUrl);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
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
}

function resolveControlPlaneWindowUrl(url) {
  const baseUrl = mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.getURL().startsWith("http")
    ? mainWindow.webContents.getURL()
    : controlPlaneUrl();
  return validateControlPlaneWindowUrl(url, { baseUrl });
}

function createControlPlaneWindow(url) {
  const parsedUrl = resolveControlPlaneWindowUrl(url);
  const controlPlaneWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: "Repository · TaskHandoff",
    icon: desktopIconPath(),
    backgroundColor: "#071013",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
    },
  });
  controlPlaneWindows.add(controlPlaneWindow);
  controlPlaneWindow.once("closed", () => controlPlaneWindows.delete(controlPlaneWindow));
  controlPlaneWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    void shell.openExternal(targetUrl);
    return { action: "deny" };
  });
  controlPlaneWindow.once("ready-to-show", () => controlPlaneWindow.show());
  void controlPlaneWindow.loadURL(parsedUrl.toString()).catch((error) => {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    logError(`[desktop-shell] control plane window loadURL failed ${detail}`);
    if (!controlPlaneWindow.isDestroyed()) controlPlaneWindow.close();
  });
  return controlPlaneWindow;
}

function createAppWindow(url) {
  const parsedUrl = resolveAppWindowUrl(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Only HTTP(S) app windows are supported.");
  }
  const appWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    ...appWindowTitleBarWindowOptions(),
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    show: false,
    title: "TaskHandoff App",
    icon: desktopIconPath(),
    backgroundColor: "#071013",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
    },
  });
  if (process.platform === "win32") windowsTitleBarOverlayHeights.set(appWindow, 42);

  appWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    void shell.openExternal(targetUrl);
    return { action: "deny" };
  });
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
  appView.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    void shell.openExternal(targetUrl);
    return { action: "deny" };
  });
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
  const base = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : controlPlaneUrl();
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
  ownsNodeAgentProcess = true;
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
      ownsNodeAgentProcess = false;
    },
  });

  return child;
}

async function waitForControlPlane(url, child, attempts = 80) {
  const expectedDataDir = resolveDataDir();
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
        if (path.resolve(payload?.data?.dataDir || "") === expectedDataDir) {
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
  if (nodeAgentProcess && ownsNodeAgentProcess) {
    const child = nodeAgentProcess;
    nodeAgentProcess = undefined;
    ownsNodeAgentProcess = false;
    await stopSupervisedDesktopChild(child, {
      label: "Node agent",
      onForce: () => logError("[desktop-shell] forcing node agent to stop"),
    });
    return;
  }
  const result = await stopExistingDesktopNodeAgent({
    dataDir: resolveNodeAgentDataDir(),
    logInfo,
    logError,
  });
  if (result.status === "foreign") {
    throw new Error(`Refusing to stop node agent pid=${result.owner.pid} owned by dataDir=${result.owner.dataDir}.`);
  }
  if (result.status === "unverified") {
    throw new Error(`Refusing to stop node agent pid=${result.owner.pid} because its process identity could not be verified.`);
  }
}

const desktopServiceLifecycle = createDesktopServiceLifecycle({ stopControlPlane, stopNodeAgent });

async function boot() {
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
      expected: {
        packageVersion: app.getVersion(),
        buildId: process.env.TASK_HANDOFF_BUILD_ID,
        gitCommit: process.env.TASK_HANDOFF_GIT_COMMIT,
      },
      fetchHealth: () => fetchNodeAgentHealth(nodeAgentControlEndpoint),
      start: () => startNodeAgent({ host: nodeAgentHost, port: nodeAgentPort }),
      waitUntilReady: (child) => waitForNodeAgent(nodeAgentControlEndpoint, child),
      logInfo,
      logError,
    });
    bootNodeAgent = ensuredNodeAgent.child;
    nodeAgentReady = true;
    const nodeAgentHealth = ensuredNodeAgent.health;
    const actualNodeAgentPort = Number(nodeAgentHealth?.listener?.port) || nodeAgentPort;
    const nodeAgentEndpoint = localHttpUrl(nodeAgentHost, actualNodeAgentPort);
    const child = startControlPlane({ host: controlPlaneHost, port: controlPlanePort, nodeAgentEndpoint, nodeAgentControlEndpoint });
    await waitForControlPlane(url, child);
    desktopServiceLifecycle.markRunning();
    createWindow(url);
    bootNodeAgent?.unref?.();
  } catch (error) {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    logError(`[desktop-shell] desktop services failed to start ${detail}`);
    await desktopServiceLifecycle.stop("boot-failure", { nodeAgentReady }).catch((cleanupError) => {
      logError(`[desktop-shell] failed to roll back desktop services ${cleanupError instanceof Error ? cleanupError.stack || cleanupError.message : String(cleanupError)}`);
    });
    if (nodeAgentReady) {
      bootNodeAgent?.unref?.();
    }
    createWindow(htmlDataUrl(renderFailurePage("TaskHandoff desktop services failed", detail)));
  }
}

async function prepareDesktopUpdateInstall() {
  await desktopServiceLifecycle.stop("update");
  desktopQuitReady = true;
}

ipcMain.handle("task-handoff:choose-project-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose project folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? undefined : { path: result.filePaths[0] };
});

ipcMain.handle("task-handoff:open-app-window", (_event, url) => {
  createAppWindow(url);
  return { ok: true };
});

ipcMain.handle("task-handoff:open-control-plane-window", (_event, url) => {
  createControlPlaneWindow(url);
  return { ok: true };
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

ipcMain.handle("task-handoff:set-window-chrome-theme", (_event, theme) => {
  const targetWindow = BrowserWindow.fromWebContents(_event.sender);
  const height = targetWindow ? windowsTitleBarOverlayHeights.get(targetWindow) : undefined;
  if (process.platform !== "win32" || !targetWindow || targetWindow.isDestroyed() || !height || !["light", "dark"].includes(theme)) {
    return { ok: false };
  }
  applyWindowsTitleBarTheme(targetWindow, nativeTheme, { height, theme });
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

const ownsDesktopInstanceLock = app.requestSingleInstanceLock();

if (!ownsDesktopInstanceLock) {
  logInfo("[desktop-shell] another Desktop process already owns the application lock; exiting");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    setDesktopDockIcon();
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
    if (!mainWindow) {
      createWindow(controlPlaneUrl());
    }
  });

  app.on("before-quit", (event) => {
    desktopUpdater?.stop();
    if (desktopQuitReady) {
      closeDesktopFileLog();
      return;
    }
    event.preventDefault();
    if (!desktopQuitPromise) {
      desktopQuitPromise = desktopServiceLifecycle.stop("quit")
        .catch((error) => logError(`[desktop-shell] failed to stop control plane during quit ${error instanceof Error ? error.stack || error.message : String(error)}`))
        .finally(() => {
          desktopQuitReady = true;
          closeDesktopFileLog();
          app.quit();
        });
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
