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
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openAppWindow: (url) => ipcRenderer.invoke("task-handoff:open-app-window", url),
  openControlPlaneWindow: (url) => ipcRenderer.invoke("task-handoff:open-control-plane-window", url),
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
