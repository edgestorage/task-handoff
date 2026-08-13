const STATUS_LABELS = Object.freeze({
  zh: { idle: "未启动", starting: "启动中", running: "运行中", degraded: "异常", stopping: "正在退出", stopped: "已停止", failed: "异常" },
  en: { idle: "Not started", starting: "Starting", running: "Running", degraded: "Degraded", stopping: "Stopping", stopped: "Stopped", failed: "Failed" },
});
const EXPANDED_INSTANCE_LIMIT = 10;

function instanceMenuItem(instance, onOpenInstance) {
  return {
    label: instance.name,
    click: () => onOpenInstance?.(instance.id),
  };
}

function buildInstanceMenuItems(groups, onOpenInstance) {
  return groups.flatMap((group, index) => {
    const separator = index > 0 ? [{ type: "separator" }] : [];
    if (group.instances.length > EXPANDED_INSTANCE_LIMIT) {
      return [
        ...separator,
        {
          label: group.nodeName,
          submenu: group.instances.map((instance) => instanceMenuItem(instance, onOpenInstance)),
        },
      ];
    }
    return [
      ...separator,
      { label: group.nodeName, enabled: false },
      ...group.instances.map((instance) => instanceMenuItem(instance, onOpenInstance)),
    ];
  });
}

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
  let serviceState = options.supervisor.snapshot();
  let instanceGroups = [];
  let directoryState = options.loadInstances ? "loading" : "unavailable";
  let destroyed = false;
  let refreshPromise;
  tray.setToolTip("TaskHandoff");

  function render() {
    const status = labels[serviceState.phase] || serviceState.phase;
    const controlPlane = labels[serviceState.controlPlane] || serviceState.controlPlane;
    const nodeAgent = labels[serviceState.nodeAgent] || serviceState.nodeAgent;
    const instanceItems = instanceGroups.length > 0
      ? buildInstanceMenuItems(instanceGroups, options.onOpenInstance)
      : [{
          label: directoryState === "loading"
            ? (language === "zh" ? "正在加载实例…" : "Loading instances…")
            : directoryState === "error"
              ? (language === "zh" ? "实例加载失败" : "Failed to load instances")
              : (language === "zh" ? "暂无实例" : "No instances"),
          enabled: false,
        }];
    tray.setToolTip(`TaskHandoff · ${status}`);
    tray.setContextMenu(options.Menu.buildFromTemplate([
      { label: language === "zh" ? "打开主窗口" : "Open Main Window", click: options.onOpen },
      { type: "separator" },
      { label: `${language === "zh" ? "服务" : "Service"}：${status}`, enabled: false },
      { label: `Control Plane：${controlPlane}`, enabled: false },
      { label: `Node Agent：${nodeAgent}`, enabled: false },
      ...(serviceState.error ? [{ label: `${language === "zh" ? "错误" : "Error"}：${serviceState.error}`, enabled: false }] : []),
      { type: "separator" },
      ...instanceItems,
      { type: "separator" },
      { label: language === "zh" ? "设置" : "Settings", click: options.onSettings },
      { type: "separator" },
      { label: language === "zh" ? "退出 TaskHandoff" : "Quit TaskHandoff", click: options.onQuit },
    ]));
    options.onInstanceDirectoryChange?.({ groups: instanceGroups, state: directoryState });
  }

  async function refreshInstances() {
    if (!options.loadInstances || refreshPromise || serviceState.controlPlane !== "running") return refreshPromise;
    if (instanceGroups.length === 0) directoryState = "loading";
    render();
    refreshPromise = Promise.resolve(options.loadInstances()).then((groups) => {
      if (destroyed) return;
      instanceGroups = groups;
      directoryState = "ready";
    }).catch((error) => {
      if (destroyed) return;
      instanceGroups = [];
      directoryState = "error";
      options.onDirectoryError?.(error);
    }).finally(() => {
      refreshPromise = undefined;
      if (!destroyed) render();
    });
    return refreshPromise;
  }

  function update(state) {
    serviceState = state;
    if (state.controlPlane !== "running") {
      instanceGroups = [];
      directoryState = options.loadInstances ? "loading" : "unavailable";
    }
    render();
    if (state.controlPlane === "running") void refreshInstances();
  }

  if (options.onActivateExisting) tray.on("click", options.onActivateExisting);
  tray.on("right-click", () => { void refreshInstances(); });
  const unsubscribe = options.supervisor.subscribe(update);
  const refreshTimer = options.loadInstances && setInterval(() => { void refreshInstances(); }, options.refreshIntervalMs || 15_000);
  refreshTimer?.unref?.();
  return {
    destroy() {
      destroyed = true;
      if (refreshTimer) clearInterval(refreshTimer);
      unsubscribe();
      tray.destroy();
    },
    tray,
    update,
    refreshInstances,
  };
}

module.exports = { buildInstanceMenuItems, createDesktopTray, createTrayImage, EXPANDED_INSTANCE_LIMIT, STATUS_LABELS };
