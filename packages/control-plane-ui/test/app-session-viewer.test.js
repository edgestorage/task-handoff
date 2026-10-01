import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = (path) => fs.readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("app session viewer replaces the KasmVNC idle page with our own paused state", () => {
  const viewer = source("apps/control-plane/shared/AppSessionViewer.vue");
  assert.match(viewer, /<iframe\s+v-if="viewerState === 'live'"/);
  assert.match(viewer, /event\.source !== frame\.value\?\.contentWindow/);
  assert.match(viewer, /payload\.action !== "idle_session_timeout"/);
  assert.match(viewer, /viewerState\.value = "paused"/);
  assert.match(viewer, /window\.addEventListener\("message", handleWindowMessage\)/);
  assert.match(viewer, /window\.removeEventListener\("message", handleWindowMessage\)/);
  assert.match(viewer, /@click\.stop="reconnect"/);
  assert.match(viewer, /watch\(\(\) => props\.src[\s\S]*?viewerState\.value = "live"/);
  assert.doesNotMatch(viewer, /href="\/"/);
});

test("every app session surface renders through the shared viewer", () => {
  const pane = source("apps/control-plane/instance-detail/SessionPaneContent.vue");
  const access = source("apps/control-plane/app-access/AppAccessView.vue");
  const board = source("apps/control-plane/board/InstanceBoardView.vue");
  assert.match(pane, /<AppSessionViewer class="session-preview-frame" :src="activeFrameUrl"/);
  assert.match(access, /<AppSessionViewer\s+v-else-if="vncFrameUrl"[\s\S]*?class="app-access-frame"[\s\S]*?:src="vncFrameUrl"/);
  assert.match(board, /<AppSessionViewer\s+v-else-if="boardSessionFrameUrl\(instance\)"[\s\S]*?class="board-card-frame"[\s\S]*?compact[\s\S]*?:src="boardSessionFrameUrl\(instance\)"/);
  const bareFrames = [[pane, "session-preview-frame"], [access, "app-access-frame"], [board, "board-card-frame"]];
  for (const [file, frameClass] of bareFrames) {
    assert.doesNotMatch(file, new RegExp(`<iframe[^>]*class="${frameClass}"`));
  }
});

test("paused viewer copy exists in both locales", () => {
  const english = source("i18n/locales/en-US/sessions.ts");
  const chinese = source("i18n/locales/zh-CN/sessions.ts");
  for (const locale of [english, chinese]) {
    assert.match(locale, /viewer: \{ pausedTitle: ".+", pausedDetail: ".+", reconnect: ".+" \}/);
  }
  assert.match(english, /pausedTitle: "Live view paused"/);
  assert.match(chinese, /pausedTitle: "实时视图已暂停"/);
});
