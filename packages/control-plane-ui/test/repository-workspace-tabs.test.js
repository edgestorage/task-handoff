import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspaceUrl = new URL("../src/apps/control-plane/instance-detail/RepositoryWorkspace.vue", import.meta.url);

test("repository file tabs hide the scrollbar while retaining direct wheel scrolling", async () => {
  const workspace = await readFile(workspaceUrl, "utf8");

  assert.match(workspace, /class="repository-workspace-tabs"[\s\S]*@wheel="scrollOpenTabs"/);
  assert.match(workspace, /function scrollOpenTabs\(event: WheelEvent\)/);
  assert.match(workspace, /tabList\.scrollLeft \+ event\.deltaY/);
  assert.match(workspace, /event\.preventDefault\(\);[\s\S]*tabList\.scrollLeft = nextScrollLeft/);
  assert.match(workspace, /\.repository-workspace-tabs \{[^}]*overflow-x: auto;[^}]*overflow-y: hidden;[^}]*scrollbar-width: none;/);
  assert.match(workspace, /\.repository-workspace-tabs::\-webkit-scrollbar \{ display: none; \}/);
});
