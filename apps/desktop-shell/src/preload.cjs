const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("taskHandoffDesktop", {
  chooseProjectFolder: () => ipcRenderer.invoke("task-handoff:choose-project-folder"),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openAppWindow: (url) => ipcRenderer.invoke("task-handoff:open-app-window", url),
  openControlPlaneWindow: (url) => ipcRenderer.invoke("task-handoff:open-control-plane-window", url),
  windowAction: (action) => ipcRenderer.invoke("task-handoff:window-action", action),
});
