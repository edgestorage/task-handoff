const APPLICATION_MENU_LABELS = Object.freeze({
  zh: Object.freeze({
    view: "视图",
    reload: "重新加载",
    forceReload: "强制重新加载",
    toggleDeveloperTools: "切换开发者工具",
    actualSize: "实际大小",
    zoomIn: "放大",
    zoomOut: "缩小",
    toggleFullScreen: "切换全屏",
  }),
  en: Object.freeze({
    view: "View",
    reload: "Reload",
    forceReload: "Force Reload",
    toggleDeveloperTools: "Toggle Developer Tools",
    actualSize: "Actual Size",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    toggleFullScreen: "Toggle Full Screen",
  }),
});

function desktopApplicationMenuLabels(locale) {
  const language = String(locale || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
  return APPLICATION_MENU_LABELS[language];
}

function buildDesktopApplicationMenuTemplate({ platform, locale, getWindow } = {}) {
  const labels = desktopApplicationMenuLabels(locale);
  const activeWindow = () => {
    const window = typeof getWindow === "function" ? getWindow() : undefined;
    return window && !window.isDestroyed?.() ? window : undefined;
  };
  const activeWebContents = () => {
    const contents = activeWindow()?.webContents;
    return contents && !contents.isDestroyed?.() ? contents : undefined;
  };
  const withWebContents = (action) => () => {
    const contents = activeWebContents();
    if (contents) action(contents);
  };
  const withWindow = (action) => () => {
    const window = activeWindow();
    if (window) action(window);
  };
  const isMac = platform === "darwin";

  return [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: labels.view,
      submenu: [
        { label: labels.reload, accelerator: "CmdOrCtrl+R", click: withWebContents((contents) => contents.reload()) },
        { label: labels.forceReload, accelerator: "CmdOrCtrl+Shift+R", click: withWebContents((contents) => contents.reloadIgnoringCache()) },
        {
          label: labels.toggleDeveloperTools,
          accelerator: isMac ? "Alt+Command+I" : "Ctrl+Shift+I",
          click: withWebContents((contents) => contents.toggleDevTools()),
        },
        { type: "separator" },
        { label: labels.actualSize, accelerator: "CmdOrCtrl+0", click: withWebContents((contents) => contents.setZoomLevel(0)) },
        {
          label: labels.zoomIn,
          accelerator: "CmdOrCtrl+Plus",
          click: withWebContents((contents) => contents.setZoomLevel(Math.min(9, contents.getZoomLevel() + 1))),
        },
        {
          label: labels.zoomOut,
          accelerator: "CmdOrCtrl+-",
          click: withWebContents((contents) => contents.setZoomLevel(Math.max(-8, contents.getZoomLevel() - 1))),
        },
        { type: "separator" },
        {
          label: labels.toggleFullScreen,
          accelerator: isMac ? "Ctrl+Command+F" : "F11",
          click: withWindow((window) => window.setFullScreen(!window.isFullScreen())),
        },
      ],
    },
    { role: "windowMenu" },
  ];
}

function installDesktopApplicationMenu(options) {
  options.Menu.setApplicationMenu(options.Menu.buildFromTemplate(buildDesktopApplicationMenuTemplate(options)));
}

module.exports = {
  buildDesktopApplicationMenuTemplate,
  desktopApplicationMenuLabels,
  installDesktopApplicationMenu,
};
