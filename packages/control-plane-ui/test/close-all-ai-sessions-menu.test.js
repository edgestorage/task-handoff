import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../src/apps/control-plane/${path}`, import.meta.url), "utf8");

test("instance dropdown and context menus share the close-all action", () => {
  const list = read("instance-list/InstanceList.vue");
  const items = read("instance-list/InstanceActionMenuItems.vue");
  const workbench = read("ControlPlaneWorkbench.vue");
  assert.match(items, /emit\('closeAllSessions'\)/);
  assert.equal((list.match(/@close-all-sessions="\$emit\('closeAllSessions', instance\)"/g) || []).length, 2);
  assert.match(workbench, /@close-all-sessions="confirmCloseAllInstanceSessions"/);
  assert.match(workbench, /controlPlaneAiSessions\.data\.value\?\.instances/);
  assert.match(workbench, /closeAiSessionBatch\(sessions\.map/);
});

test("Story menus close the complete snapshot selection instead of the expanded tree", () => {
  const view = read("story/StoryView.vue");
  const contextMenu = read("story/StoryTreeContextMenu.vue");
  assert.match(contextMenu, /\$emit\('close-all-sessions'\)/);
  assert.match(view, /@close-all-sessions="confirmCloseAllStorySessions\(story\)"/);
  assert.match(view, /const allSessionsForStory[\s\S]*storySessionRecords\.value[\s\S]*session\.storyId === story\.id/);
  assert.doesNotMatch(view, /const allSessionsForStory[^;]*sessionsFor\(/);
});
