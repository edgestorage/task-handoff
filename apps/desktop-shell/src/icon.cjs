const fs = require("node:fs");
const path = require("node:path");

function desktopIconPath({ packaged, resourcesPath, root, existsSync = fs.existsSync }) {
  const iconPath = packaged
    ? path.join(resourcesPath, "icon.png")
    : path.join(root, "build", "icon.png");
  return existsSync(iconPath) ? iconPath : undefined;
}

function desktopTrayIconPath({ packaged, resourcesPath, root, existsSync = fs.existsSync }) {
  const iconPath = packaged
    ? path.join(resourcesPath, "tray-icon.png")
    : path.join(root, "build", "tray-icon.png");
  return existsSync(iconPath) ? iconPath : undefined;
}

function applyDesktopDockIcon({ platform, packaged, dock, nativeImage, iconPath }) {
  if (platform === "darwin" && packaged) return false;
  if (!iconPath || !dock) return false;
  const icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) return false;
  dock.setIcon(icon);
  return true;
}

module.exports = { applyDesktopDockIcon, desktopIconPath, desktopTrayIconPath };
