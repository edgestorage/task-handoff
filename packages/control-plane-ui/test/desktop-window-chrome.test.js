import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const workbench = fs.readFileSync(path.join(root, "src/apps/control-plane/ControlPlaneWorkbench.vue"), "utf8");
const styles = fs.readFileSync(path.join(root, "src/apps/control-plane/ControlPlaneWorkbench.css"), "utf8");
const appStyles = fs.readFileSync(path.join(root, "src/styles/app.css"), "utf8");
const theme = fs.readFileSync(path.join(root, "src/utils/theme.ts"), "utf8");

test("desktop chrome follows the authoritative preload capability", () => {
  assert.doesNotMatch(workbench, /navigator\.platform/);
  assert.match(workbench, /windowChromeMode === "custom"/);
  assert.match(workbench, /windowChromeMode === "macos-overlay"/);
  assert.match(workbench, /windowChromeMode === "windows-overlay"/);
});

test("desktop tray settings command opens settings only in the main window", () => {
  assert.match(workbench, /desktopBridge\?\.onOpenSettings\?\.\(\(\) => \{\s*if \(!standaloneMode\.value\) openSettings\(\);/);
  assert.match(workbench, /stopDesktopOpenSettings\?\.\(\);/);
});

test("macOS positions its traffic lights explicitly and reserves the system safe area", () => {
  assert.match(workbench, /class="desktop-window-controls native-window-control-space macos-native-window-control-space"/);
  assert.match(appStyles, /--native-titlebar-controls-left-width:[\s\S]*?calc\(env\(titlebar-area-x, 16px\) - 16px\)/);
  assert.match(styles, /--macos-native-window-control-width: var\(--native-titlebar-controls-left-width\);/);
  assert.match(styles, /flex: 0 0 var\(--macos-native-window-control-width\);/);
  assert.match(styles, /\.topbar-left \{[\s\S]*?gap: 0;/);
  assert.match(styles, /\.topbar-left > \.desktop-window-controls:not\(\.macos-native-window-control-space\) \{\s*margin-right: 12px;/);
});

test("Windows overlay mirrors the macOS flex spacer inside the titlebar", () => {
  assert.match(workbench, /class="desktop-window-controls native-window-control-space windows-native-window-control-space"/);
  assert.match(appStyles, /--native-titlebar-controls-right-width:[\s\S]*?calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\)\)/);
  assert.match(styles, /--windows-native-window-control-width: var\(--native-titlebar-controls-right-width\);/);
  assert.match(styles, /width: var\(--windows-native-window-control-width\);\s*flex: 0 0 var\(--windows-native-window-control-width\);/);
  assert.doesNotMatch(styles, /native-windows-titlebar/);
  assert.doesNotMatch(styles, /\.control-plane-actions\s*\{[^}]*position:\s*absolute/s);
  assert.match(theme, /setWindowChromeTheme\?\.\(theme\)/);
});

test("open desktop windows follow theme changes made in another window", () => {
  assert.match(theme, /let themeStorageSyncInitialized = false/);
  assert.match(theme, /window\.addEventListener\("storage", \(event\) => \{/);
  assert.match(theme, /event\.key !== THEME_STORAGE_KEY \|\| !isThemePreference\(event\.newValue\)/);
  assert.match(theme, /applyThemePreference\(event\.newValue\)/);
});

test("an open menu temporarily makes the titlebar clickable for outside dismissal", () => {
  assert.match(styles, /\.control-plane-topbar \{[\s\S]*?-webkit-app-region: drag;/);
  assert.match(
    styles,
    /:global\(body:has\(\[role="menu"\]\[data-state="open"\]\) \.control-plane-topbar\),\s*:global\(body:has\(\[role="menu"\]\[data-state="open"\]\) \.instance-detail-titlebar-tabs\),\s*:global\(body:has\(\[role="menu"\]\[data-state="open"\]\) \.session-preview-toolbar\.in-titlebar\),\s*:global\(body:has\(\[role="menu"\]\[data-state="open"\]\) \[role="menu"\]\[data-state="open"\]\) \{\s*-webkit-app-region: no-drag;/,
  );
});
