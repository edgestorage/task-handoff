const { contextBridge, ipcRenderer, webUtils } = require("electron");

const windowChromeMode = process.platform === "darwin"
  ? "macos-overlay"
  : process.platform === "win32"
    ? "windows-overlay"
    : "custom";

contextBridge.exposeInMainWorld("taskHandoffDesktop", {
  windowChrome: {
    mode: windowChromeMode,
    supportsDensity: true,
  },
  setWindowChromeTheme: (theme) => ipcRenderer.invoke("task-handoff:set-window-chrome-theme", theme),
  setWindowChromeDensity: (density) => ipcRenderer.invoke("task-handoff:set-window-chrome-density", density),
  chooseProjectFolder: () => ipcRenderer.invoke("task-handoff:choose-project-folder"),
  openLocalPath: (localPath) => ipcRenderer.invoke("task-handoff:open-local-path", localPath),
  revealLocalPath: (localPath) => ipcRenderer.invoke("task-handoff:reveal-local-path", localPath),
  openExternalUrl: (url) => ipcRenderer.invoke("task-handoff:open-external-url", url),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  clipboard: {
    readText: () => ipcRenderer.invoke("task-handoff:clipboard-read-text"),
    writeText: (text) => ipcRenderer.invoke("task-handoff:clipboard-write-text", text),
    onChanged: (listener) => {
      const handler = (_event, input) => listener(input);
      ipcRenderer.on("task-handoff:clipboard-changed", handler);
      return () => ipcRenderer.removeListener("task-handoff:clipboard-changed", handler);
    },
  },
  openAppWindow: (url) => ipcRenderer.invoke("task-handoff:open-app-window", url),
  prepareBrowserContext: (instanceId) => ipcRenderer.invoke("task-handoff:browser-context-prepare", instanceId),
  releaseBrowserContext: (contextId) => ipcRenderer.invoke("task-handoff:browser-context-release", contextId),
  touchBrowserContext: (contextId) => ipcRenderer.invoke("task-handoff:browser-context-touch", contextId),
  getBrowserControlInfo: (instanceId) => ipcRenderer.invoke("task-handoff:browser-control-info", instanceId ? { instanceId } : {}),
  registerBrowserTab: (input) => ipcRenderer.invoke("task-handoff:browser-tab-register", input),
  updateBrowserTab: (input) => ipcRenderer.invoke("task-handoff:browser-tab-update", input),
  unregisterBrowserTab: (webContentsId) => ipcRenderer.invoke("task-handoff:browser-tab-unregister", { webContentsId }),
  listBrowserTabs: (instanceId) => ipcRenderer.invoke("task-handoff:browser-tab-list", instanceId ? { instanceId } : {}),
  closeBrowserTab: (tabRef) => ipcRenderer.invoke("task-handoff:browser-tab-close", tabRef),
  attachBrowserTarget: (tabRef) => ipcRenderer.invoke("task-handoff:browser-target-attach", tabRef),
  detachBrowserTarget: (tabRef) => ipcRenderer.invoke("task-handoff:browser-target-detach", tabRef),
  sendBrowserCdpCommand: (input) => ipcRenderer.invoke("task-handoff:browser-cdp-send", input),
  setBrowserTabThrottled: (webContentsId, throttled) => ipcRenderer.invoke("task-handoff:browser-tab-throttled", webContentsId, throttled),
  onBrowserNewTab: (listener) => {
    const handler = (_event, input) => listener(input);
    ipcRenderer.on("task-handoff:browser-new-tab", handler);
    return () => ipcRenderer.removeListener("task-handoff:browser-new-tab", handler);
  },
  onBrowserFocusAddress: (listener) => {
    const handler = (_event, input) => listener(input);
    ipcRenderer.on("task-handoff:browser-focus-address", handler);
    return () => ipcRenderer.removeListener("task-handoff:browser-focus-address", handler);
  },
  onBrowserLoadFailure: (listener) => {
    const handler = (_event, input) => listener(input);
    ipcRenderer.on("task-handoff:browser-load-failure", handler);
    return () => ipcRenderer.removeListener("task-handoff:browser-load-failure", handler);
  },
  onBrowserTabClosed: (listener) => {
    const handler = (_event, input) => listener(input);
    ipcRenderer.on("task-handoff:browser-tab-closed", handler);
    return () => ipcRenderer.removeListener("task-handoff:browser-tab-closed", handler);
  },
  onBrowserTabsChanged: (listener) => {
    const handler = (_event, input) => listener(input);
    ipcRenderer.on("task-handoff:browser-tabs-changed", handler);
    return () => ipcRenderer.removeListener("task-handoff:browser-tabs-changed", handler);
  },
  onBrowserDeviceMetricsChanged: (listener) => {
    const handler = (_event, input) => listener(input);
    ipcRenderer.on("task-handoff:browser-device-metrics-changed", handler);
    return () => ipcRenderer.removeListener("task-handoff:browser-device-metrics-changed", handler);
  },
  logBrowserDiagnostic: (input) => ipcRenderer.send("task-handoff:browser-diagnostic", input),
  openControlPlaneWindow: (url) => ipcRenderer.invoke("task-handoff:open-control-plane-window", url),
  openInstanceDetailWindow: (instanceId) => ipcRenderer.invoke("task-handoff:open-instance-detail-window", instanceId),
  switchInstanceDetailWindow: (instanceId) => ipcRenderer.invoke("task-handoff:switch-instance-detail-window", instanceId),
  getWindowAlwaysOnTop: () => ipcRenderer.invoke("task-handoff:get-window-always-on-top"),
  setWindowAlwaysOnTop: (enabled) => ipcRenderer.invoke("task-handoff:set-window-always-on-top", enabled),
  onOpenSettings: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("task-handoff:open-settings", handler);
    return () => ipcRenderer.removeListener("task-handoff:open-settings", handler);
  },
  setDiagnosticLogsEnabled: (enabled) => ipcRenderer.invoke("task-handoff:set-diagnostic-logs-enabled", enabled),
  desktopUpdates: {
    getState: () => ipcRenderer.invoke("task-handoff:desktop-update-get-state"),
    check: () => ipcRenderer.invoke("task-handoff:desktop-update-check"),
    download: () => ipcRenderer.invoke("task-handoff:desktop-update-download"),
    install: () => ipcRenderer.invoke("task-handoff:desktop-update-install"),
    setChannel: (channel) => ipcRenderer.invoke("task-handoff:desktop-update-set-channel", channel),
    openReleasePage: () => ipcRenderer.invoke("task-handoff:desktop-update-open-release"),
    onStateChanged: (listener) => {
      const handler = (_event, state) => listener(state);
      ipcRenderer.on("task-handoff:desktop-update-state", handler);
      return () => ipcRenderer.removeListener("task-handoff:desktop-update-state", handler);
    },
  },
  windowAction: (action) => ipcRenderer.invoke("task-handoff:window-action", action),
});
