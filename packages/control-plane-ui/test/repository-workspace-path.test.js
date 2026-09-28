import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspaceUrl = new URL("../src/apps/control-plane/instance-detail/RepositoryWorkspace.vue", import.meta.url);

test("repository path bar hides the scrollbar while retaining direct wheel scrolling", async () => {
  const workspace = await readFile(workspaceUrl, "utf8");

  assert.match(workspace, /class="repository-workspace-path"[\s\S]*@wheel="scrollBreadcrumb"/);
  assert.match(workspace, /function scrollBreadcrumb\(event: WheelEvent\) \{[\s\S]*element\.scrollLeft \+= event\.deltaY;[\s\S]*event\.preventDefault\(\);/);
  assert.match(workspace, /if \(element\.scrollWidth <= element\.clientWidth \|\| Math\.abs\(event\.deltaY\) <= Math\.abs\(event\.deltaX\)\) return;/);
  assert.match(workspace, /\.repository-workspace-path \{[^}]*overflow-x: auto;[^}]*overflow-y: hidden;[^}]*scrollbar-width: none;/);
  assert.match(workspace, /\.repository-workspace-path::\-webkit-scrollbar \{ display: none; \}/);
});
