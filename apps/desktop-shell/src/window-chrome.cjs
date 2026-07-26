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

module.exports = {
  desktopTitleBarOptions,
  desktopWindowChromeMode,
  windowsTitleBarOverlayOptions,
};
