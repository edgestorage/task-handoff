import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const workbench = fs.readFileSync(path.join(root, "src/apps/control-plane/ControlPlaneWorkbench.vue"), "utf8");
const styles = fs.readFileSync(path.join(root, "src/apps/control-plane/ControlPlaneWorkbench.css"), "utf8");
const theme = fs.readFileSync(path.join(root, "src/utils/theme.ts"), "utf8");

test("desktop chrome follows the authoritative preload capability", () => {
  assert.doesNotMatch(workbench, /navigator\.platform/);
  assert.match(workbench, /windowChromeMode === "custom"/);
  assert.match(workbench, /windowChromeMode === "macos-overlay"/);
  assert.match(workbench, /windowChromeMode === "windows-overlay"/);
});

test("macOS positions its traffic lights explicitly and reserves the system safe area", () => {
  assert.match(workbench, /class="desktop-window-controls native-window-control-space macos-native-window-control-space"/);
  assert.match(styles, /calc\(env\(titlebar-area-x, 16px\) - 16px\)/);
  assert.match(styles, /flex: 0 0 var\(--macos-native-window-control-width\);/);
  assert.match(styles, /\.topbar-left \{[\s\S]*?gap: 0;/);
  assert.match(styles, /\.topbar-left > \.desktop-window-controls:not\(\.macos-native-window-control-space\) \{\s*margin-right: 12px;/);
});

test("Windows overlay mirrors the macOS flex spacer inside the titlebar", () => {
  assert.match(workbench, /class="desktop-window-controls native-window-control-space windows-native-window-control-space"/);
  assert.match(styles, /calc\(100vw - env\(titlebar-area-x, 0px\) - env\(titlebar-area-width, 100vw\)\)/);
  assert.match(styles, /width: var\(--windows-native-window-control-width\);\s*flex: 0 0 var\(--windows-native-window-control-width\);/);
  assert.doesNotMatch(styles, /native-windows-titlebar/);
  assert.doesNotMatch(styles, /\.control-plane-actions\s*\{[^}]*position:\s*absolute/s);
  assert.match(theme, /setWindowChromeTheme\?\.\(theme\)/);
});
