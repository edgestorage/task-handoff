const STATUS_LABELS = Object.freeze({
  zh: { idle: "未启动", starting: "启动中", running: "运行中", degraded: "异常", stopping: "正在退出", stopped: "已停止", failed: "异常" },
  en: { idle: "Not started", starting: "Starting", running: "Running", degraded: "Degraded", stopping: "Stopping", stopped: "Stopped", failed: "Failed" },
});

function createTrayImage(nativeImage, iconPath, platform) {
  const source = nativeImage.createFromPath(iconPath);
  if (source.isEmpty()) throw new Error(`Desktop tray icon is empty: ${iconPath}`);
  const image = source.resize({ width: platform === "darwin" ? 18 : 20, height: platform === "darwin" ? 18 : 20 });
  if (platform === "darwin") image.setTemplateImage(true);
  return image;
}

function createDesktopTray(options) {
  const language = String(options.locale || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
  const labels = STATUS_LABELS[language];
  const tray = new options.Tray(createTrayImage(options.nativeImage, options.iconPath, options.platform));
  tray.setToolTip("TaskHandoff");

  function update(state) {
    const status = labels[state.phase] || state.phase;
    const controlPlane = labels[state.controlPlane] || state.controlPlane;
    const nodeAgent = labels[state.nodeAgent] || state.nodeAgent;
    tray.setToolTip(`TaskHandoff · ${status}`);
    tray.setContextMenu(options.Menu.buildFromTemplate([
      { label: language === "zh" ? "打开 TaskHandoff" : "Open TaskHandoff", click: options.onOpen },
      { type: "separator" },
      { label: `${language === "zh" ? "服务" : "Service"}：${status}`, enabled: false },
      { label: `Control Plane：${controlPlane}`, enabled: false },
      { label: `Node Agent：${nodeAgent}`, enabled: false },
      ...(state.error ? [{ label: `${language === "zh" ? "错误" : "Error"}：${state.error}`, enabled: false }] : []),
      { type: "separator" },
      { label: language === "zh" ? "退出 TaskHandoff" : "Quit TaskHandoff", click: options.onQuit },
    ]));
  }

  tray.on("click", options.onOpen);
  const unsubscribe = options.supervisor.subscribe(update);
  return {
    destroy() {
      unsubscribe();
      tray.destroy();
    },
    tray,
    update,
  };
}

module.exports = { createDesktopTray, createTrayImage, STATUS_LABELS };
