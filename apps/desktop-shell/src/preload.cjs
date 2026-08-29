const { contextBridge, ipcRenderer, webUtils } = require("electron");

const windowChromeMode = process.platform === "darwin"
  ? "macos-overlay"
  : process.platform === "win32"
    ? "windows-overlay"
    : "custom";

contextBridge.exposeInMainWorld("taskHandoffDesktop", {
  windowChrome: {
    mode: windowChromeMode,
  },
  setWindowChromeTheme: (theme) => ipcRenderer.invoke("task-handoff:set-window-chrome-theme", theme),
  chooseProjectFolder: () => ipcRenderer.invoke("task-handoff:choose-project-folder"),
  openLocalPath: (localPath) => ipcRenderer.invoke("task-handoff:open-local-path", localPath),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openAppWindow: (url) => ipcRenderer.invoke("task-handoff:open-app-window", url),
  prepareBrowserContext: (instanceId) => ipcRenderer.invoke("task-handoff:browser-context-prepare", instanceId),
  releaseBrowserContext: (contextId) => ipcRenderer.invoke("task-handoff:browser-context-release", contextId),
  onBrowserNewTab: (listener) => {
    const handler = (_event, input) => listener(input);
    ipcRenderer.on("task-handoff:browser-new-tab", handler);
    return () => ipcRenderer.removeListener("task-handoff:browser-new-tab", handler);
  },
  logBrowserDiagnostic: (input) => ipcRenderer.send("task-handoff:browser-diagnostic", input),
  openControlPlaneWindow: (url) => ipcRenderer.invoke("task-handoff:open-control-plane-window", url),
  openInstanceDetailWindow: (instanceId) => ipcRenderer.invoke("task-handoff:open-instance-detail-window", instanceId),
  switchInstanceDetailWindow: (instanceId) => ipcRenderer.invoke("task-handoff:switch-instance-detail-window", instanceId),
  getWindowAlwaysOnTop: () => ipcRenderer.invoke("task-handoff:get-window-always-on-top"),
  setWindowAlwaysOnTop: (enabled) => ipcRenderer.invoke("task-handoff:set-window-always-on-top", enabled),
  windowDrag: (phase, screenX, screenY) => ipcRenderer.send("task-handoff:window-drag", { phase, screenX, screenY }),
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
