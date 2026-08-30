import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { canExportInstanceConfig } from "../src/apps/control-plane/instanceConfigSync.ts";
import { useNodeFolderBrowser } from "../src/apps/control-plane/useNodeFolderBrowser.ts";
import { ConfigSyncBatchResultSchema } from "@task-handoff/protocol/config-sync";

const read = (path) => fs.readFileSync(new URL(`../src/apps/control-plane/${path}`, import.meta.url), "utf8");
const instanceList = read("instance-list/InstanceList.vue");
const instanceActions = read("instance-list/InstanceActionMenuItems.vue");
const dialog = read("instance-list/ConfigSyncDialog.vue");
const workbench = read("ControlPlaneWorkbench.vue");
const apiQueries = fs.readFileSync(new URL("../src/api/queries.ts", import.meta.url), "utf8");

test("config export uses the instance source without requiring a hydrated project", () => {
  assert.equal(canExportInstanceConfig({ source: { type: "local-folder", path: "/workspace/project" } }), true);
});

test("config export remains unavailable for non-folder sources", () => {
  assert.equal(canExportInstanceConfig({ source: { type: "git-repository", url: "https://example.com/repository.git" } }), false);
});

test("instance config actions open one dialog without nested program menus", () => {
  assert.match(instanceList, /@open-config-sync="\(direction\) => \$emit\('openConfigSync', direction, instance\)"/);
  assert.match(instanceActions, /emit\('openConfigSync', 'import'\)/);
  assert.match(instanceActions, /emit\('openConfigSync', 'export'\)/);
  assert.doesNotMatch(instanceActions, /DropdownMenuSub|ContextMenuSub/);
  assert.match(workbench, /<ConfigSyncDialog[\s\S]*v-model:open="configSyncDialogOpen"/);
  assert.doesNotMatch(apiQueries, /useConfigSyncPresetsQuery|syncControlledInstanceConfig\(/);
});

test("config sync dialog selects programs and a workspace folder before batch submission", () => {
  assert.match(dialog, /v-for="program in programs"/);
  assert.match(dialog, /<NodeFolderTree/);
  assert.match(dialog, /programIds: selectedProgramIds\.value/);
  assert.match(dialog, /workspaceFolder: browser\.selectedPath\.value/);
  assert.match(dialog, /state\.preferences\[props\.direction\]/);
});

test("config sync dialog does not reinitialize when a board refresh replaces the instance object", () => {
  assert.match(dialog, /watch\(\s*\[\(\) => props\.open, \(\) => props\.instance\?\.id, \(\) => props\.direction\]/);
  assert.doesNotMatch(dialog, /\(\) => \[props\.open, props\.instance\?\.id, props\.direction\]/);
});

test("config sync completion closes the form and reports the aggregate result in a toast", () => {
  assert.match(dialog, /showControlPlaneToast\(summary\.message, summary\.failed \? "error" : "success"\)/);
  assert.match(dialog, /emit\("update:open", false\)/);
  assert.doesNotMatch(dialog, /class="config-sync-results"/);
});

test("config sync typography follows the compact control-plane scale", () => {
  assert.match(dialog, /\.config-sync-title\)[\s\S]*font-size: 16px/);
  assert.match(dialog, /\.config-sync-description\)[\s\S]*font-size: 12px/);
  assert.match(dialog, /\.config-sync-program strong[\s\S]*font-size: 14px/);
});

test("selecting another config folder invalidates the previous transfer result", async () => {
  let resultPrograms = [{ id: "codex" }];
  const browser = useNodeFolderBrowser({
    load: async (_instanceId, input) => [{
      name: input.path || "workspace",
      path: input.path || ".",
      children: [],
    }],
    onSelect: () => {
      resultPrograms = [];
    },
  });
  await browser.loadRoots("instance-1");
  await browser.selectFolder(browser.rows.value[0]);
  assert.deepEqual(resultPrograms, []);
});

test("config sync rejects malformed controlled instance results at runtime", () => {
  assert.equal(ConfigSyncBatchResultSchema.safeParse({ accepted: true }).success, false);
});
