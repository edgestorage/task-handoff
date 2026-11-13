import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewer = readFileSync(new URL("../src/apps/control-plane/instance-detail/InstanceRemoteDesktopViewer.vue", import.meta.url), "utf8");

test("viewer count tooltip breaks the instance total down by capture source", () => {
  assert.match(viewer, /const viewerSourceRows = computed\(\(\) => \{/);
  assert.match(viewer, /snapshot\.value\?\.viewerSources \?\? \[\]/);
  assert.match(viewer, /item\.sourceRef === group\.sourceRef/);
  assert.match(viewer, /instances\.remoteDesktop\.viewerSourcesTitle/);
  assert.match(viewer, /instances\.remoteDesktop\.viewerSourceCurrent/);
  assert.doesNotMatch(viewer, /viewerCount = computed\(\(\) => snapshot\.value\?\.viewerSources/);
});
