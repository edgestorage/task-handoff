const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("taskHandoffDesktop", {
  chooseProjectFolder: () => ipcRenderer.invoke("task-handoff:choose-project-folder"),
  openAppWindow: (url) => ipcRenderer.invoke("task-handoff:open-app-window", url),
  windowAction: (action) => ipcRenderer.invoke("task-handoff:window-action", action),
});
