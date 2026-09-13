import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = async (path) => fs.readFile(new URL(`../src/${path}`, import.meta.url), "utf8");

test("topbar navigation uses fill states without nested control borders", async () => {
  const [workbench, styles, appStyles] = await Promise.all([
    source("apps/control-plane/ControlPlaneWorkbench.vue"),
    source("apps/control-plane/ControlPlaneWorkbench.css"),
    source("styles/app.css"),
  ]);

  assert.match(workbench, /variant="ghost" size="sm" class="control-plane-settings-trigger"/);
  assert.match(workbench, /variant="ghost" size="sm" class="control-plane-user-trigger" :class="\{ active: settingsMode \}"/);
  assert.match(workbench, /class="workbench-view-switcher" :class="\{ inactive: settingsMode \}"/);
  assert.match(workbench, /:class="\{ active: !settingsMode && workbenchView === option\.value \}"/);
  assert.match(workbench, /:aria-pressed="!settingsMode && workbenchView === option\.value"/);
  assert.match(appStyles, /:root:not\(\.dark\):not\(\[data-theme="dark"\]\),[\s\S]*?--workbench-view-switcher-bg: #f2f2f7;[\s\S]*?--workbench-view-selection-bg: #ffffff;[\s\S]*?--workbench-view-selection-fg: #1c1c1e;/);
  assert.match(appStyles, /:root\.dark,[\s\S]*?:root\[data-theme="dark"\] \{[\s\S]*?--workbench-view-switcher-bg: var\(--control-plane-pill-bg\);[\s\S]*?--workbench-view-selection-bg: var\(--board-control-active-bg\);[\s\S]*?--workbench-view-selection-fg: var\(--control-plane-heading\);/);
  assert.match(styles, /\.workbench-view-switcher \{[^}]*height: 32px;[^}]*width: 288px;[^}]*border: 0;[^}]*background: var\(--workbench-view-switcher-bg, var\(--surface-active\)\);[^}]*box-shadow: none;/);
  assert.match(styles, /\.workbench-view-switcher::before \{[^}]*background: var\(--workbench-view-selection-bg, hsl\(var\(--accent\)\)\);[^}]*box-shadow: none;/);
  assert.match(styles, /\.workbench-view-switcher\.inactive::before \{\s*opacity: 0;/);
  assert.match(styles, /\.workbench-view-option \{[^}]*padding: 0 8px;/);
  assert.match(styles, /\.workbench-view-option\.active \{[^}]*background: transparent;[^}]*color: var\(--workbench-view-selection-fg, hsl\(var\(--accent-foreground\)\)\);/);
  assert.match(styles, /\.control-plane-settings-trigger\.inline-flex,\s*\.control-plane-user-trigger\.inline-flex \{[^}]*height: 32px;[^}]*margin-left: 12px;[^}]*border: 0;[^}]*background: transparent;[^}]*box-shadow: none;[^}]*padding-inline: 9px;/);
  assert.match(styles, /\.control-plane-settings-trigger\.inline-flex::before,\s*\.control-plane-user-trigger\.inline-flex::before \{[^}]*left: -8px;[^}]*width: 1px;[^}]*height: 16px;/);
  assert.match(styles, /\.control-plane-shell\[data-header-density="compact"\] \.workbench-view-switcher,[\s\S]*?\.control-plane-shell\[data-header-density="compact"\] \.control-plane-settings-trigger\.inline-flex,[\s\S]*?\.control-plane-shell\[data-header-density="compact"\] \.control-plane-user-trigger\.inline-flex \{\s*height: 30px;/);
});
