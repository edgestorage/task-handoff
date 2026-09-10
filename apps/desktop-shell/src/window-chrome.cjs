function desktopWindowChromeMode(platform = process.platform) {
  if (platform === "darwin") {
    return "macos-overlay";
  }
  if (platform === "win32") {
    return "windows-overlay";
  }
  return "custom";
}

function windowsTitleBarOverlayOptions({ height, theme = "dark" } = {}) {
  return {
    color: "#00000000",
    symbolColor: theme === "light" ? "#17232a" : "#e6f0f2",
    ...(height ? { height } : {}),
  };
}

function desktopWindowBackgroundColor(theme = "dark") {
  return theme === "light" ? "#eef3f4" : "#071013";
}

function mainWindowChromeMetrics(density = "normal") {
  return density === "compact"
    ? { height: 44, trafficLightPosition: { x: 16, y: 15 } }
    : { height: 56, trafficLightPosition: { x: 16, y: 21 } };
}

function desktopTitleBarOptions({
  platform = process.platform,
  height,
  trafficLightPosition,
} = {}) {
  const mode = desktopWindowChromeMode(platform);
  if (mode === "macos-overlay") {
    return {
      frame: false,
      titleBarStyle: "hiddenInset",
      titleBarOverlay: height ? { height } : true,
      ...(trafficLightPosition ? { trafficLightPosition } : {}),
    };
  }
  if (mode === "windows-overlay") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: windowsTitleBarOverlayOptions({ height }),
    };
  }
  return { frame: false };
}

function applyWindowsTitleBarTheme(targetWindow, nativeTheme, { height, theme }) {
  nativeTheme.themeSource = theme;
  targetWindow.setTitleBarOverlay(windowsTitleBarOverlayOptions({ height, theme }));
}

function applyMainWindowChromeDensity(targetWindow, {
  density,
  platform = process.platform,
  theme = "dark",
} = {}) {
  const metrics = mainWindowChromeMetrics(density);
  if (platform === "darwin") {
    targetWindow.setWindowButtonPosition(metrics.trafficLightPosition);
  } else if (platform === "win32") {
    targetWindow.setTitleBarOverlay(windowsTitleBarOverlayOptions({ height: metrics.height, theme }));
  }
  return metrics;
}

module.exports = {
  applyMainWindowChromeDensity,
  applyWindowsTitleBarTheme,
  desktopTitleBarOptions,
  desktopWindowBackgroundColor,
  desktopWindowChromeMode,
  mainWindowChromeMetrics,
  windowsTitleBarOverlayOptions,
};
