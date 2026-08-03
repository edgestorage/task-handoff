import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workbench = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.vue", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/apps/control-plane/ControlPlaneWorkbench.css", import.meta.url), "utf8");

test("instance title appends the authoritative node name as muted metadata", () => {
  assert.match(workbench, /const topbarNodeName = computed\(\(\) => activeInstance\.value\?\.node\?\.name \|\| ""\);/);
  assert.match(workbench, /<small v-if="topbarNodeName" class="control-plane-instance-node-name" :title="topbarNodeName">· \{\{ topbarNodeName \}\}<\/small>/);
  assert.match(styles, /\.control-plane-instance-node-name \{[\s\S]*?color: var\(--text-muted\);[\s\S]*?font-size: 12px;[\s\S]*?text-overflow: ellipsis;/);
  assert.match(styles, /@media \(max-width: 780px\) \{[\s\S]*?\.control-plane-instance-node-name \{\s*display: none;/);
});

test("instance switcher menu exposes each instance's node in a portal-safe layout", () => {
  assert.match(workbench, /<span class="control-plane-instance-menu-copy">[\s\S]*?<strong>\{\{ instanceDisplayName\(instance\) \}\}<\/strong>[\s\S]*?<small>\{\{ instance\.node\?\.name \|\| instance\.nodeId \}\}<\/small>/);
  assert.match(workbench, /--instance-menu-height': `\$\{Math\.max\(sortedInstances\.length, 1\) \* 52 - 2\}px`/);
  assert.match(workbench, /:class="\{ selected: instance\.id === activeInstance\?\.id \}"[\s\S]*?:aria-current="instance\.id === activeInstance\?\.id \? 'true' : undefined"/);
  assert.match(styles, /:global\(\.control-plane-instance-menu\.control-plane-instance-menu\) \{[\s\S]*?width: max\(var\(--reka-dropdown-menu-trigger-width\), 260px\);[\s\S]*?var\(--reka-dropdown-menu-content-available-width\)[\s\S]*?border-radius: 12px;/);
  assert.match(styles, /:global\(\.control-plane-instance-menu-copy small\) \{[\s\S]*?color: var\(--text-muted\);[\s\S]*?font-size: 12px;/);
  assert.match(styles, /:global\(\.control-plane-instance-menu-list\) \{[\s\S]*?padding-right: 0;/);
  assert.match(styles, /:global\(\.control-plane-instance-menu-scroll:has\(\[data-orientation="vertical"\]\[data-state="visible"\]\) \.control-plane-instance-menu-list\) \{[\s\S]*?padding-right: 8px;/);
  assert.match(styles, /:global\(\.control-plane-instance-menu \.control-plane-instance-menu-item\) \{[\s\S]*?align-items: start;[\s\S]*?padding: 8px;/);
  assert.match(styles, /:global\(\.control-plane-instance-menu-item\.selected\) \{[\s\S]*?background: var\(--surface-active\);/);
});
