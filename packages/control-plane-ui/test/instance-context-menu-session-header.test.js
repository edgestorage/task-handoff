import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

test("session header instance metadata opens the shared instance action menu", () => {
  const stickyContext = read("components/ai-session/AiSessionStickyContext.vue");
  const panel = read("apps/control-plane/instance-detail/AiSessionPanel.vue");
  const sessionPanel = read("apps/control-plane/shared/InstanceSessionPanel.vue");
  const sessionPane = read("apps/control-plane/instance-detail/SessionPaneContent.vue");
  const story = read("apps/control-plane/story/StoryView.vue");
  const menuContent = read("apps/control-plane/shared/InstanceActionMenuContent.vue");
  const detail = read("apps/control-plane/instance-detail/InstanceDetail.vue");
  const workbench = read("apps/control-plane/ControlPlaneWorkbench.vue");

  assert.match(stickyContext, /<AiSessionPathContextMenu[\s\S]*?@copy="emit\('copyFolderPath'\)"[\s\S]*?@open="emit\('openFolder'\)"[\s\S]*?<ContextMenu v-if="instanceContextMenuEnabled">[\s\S]*?<button type="button" class="ai-session-sticky-context-item ai-session-sticky-context-instance">[\s\S]*?<slot name="instance-context-menu" \/>/);
  assert.match(stickyContext, /\.ai-session-sticky-context:hover \.ai-session-sticky-context-surface,[\s\S]*?\.ai-session-sticky-context:focus-within \.ai-session-sticky-context-surface/);
  assert.match(stickyContext, /\.ai-session-sticky-context-instance:focus-visible \{[\s\S]*?outline: 2px solid var\(--focus-ring\);/);
  const stickyArticle = panel.match(/<article\s+v-if="stickyContextVisible"[^>]*>/)?.[0];
  assert.ok(stickyArticle);
  assert.doesNotMatch(stickyArticle, /aria-hidden/);
  assert.match(panel, /class="session-ai-timeline-sticky-message" aria-hidden="true"/);
  assert.equal(panel.match(/:instance-context-menu-enabled="Boolean\(instanceActionMenu\)"/g)?.length, 1);
  assert.equal(panel.match(/<InstanceActionMenuContent\b/g)?.length, 2);
  assert.match(panel, /<div class="session-ai-detail-context">[\s\S]*?<ContextMenuTrigger as-child :disabled="!instanceActionMenu">[\s\S]*?selectedSessionInstanceName[\s\S]*?<InstanceActionMenuContent v-if="instanceActionMenu" v-bind="instanceActionMenu"/);
  assert.match(panel, /<AiSessionStickyContext[\s\S]*?:can-open-folder="canOpenSelectedSessionFolder"[\s\S]*?@open-folder="openSelectedSessionFolder"/);
  assert.match(sessionPanel, /:active-action-label="instanceActionMenu\.activeActionLabel"[\s\S]*?:can-export-config="instanceActionMenu\.canExportConfig"[\s\S]*?:is-closing-all-sessions="instanceActionMenu\.isClosingAllSessions"[\s\S]*?:is-instance-action-busy="instanceActionMenu\.isInstanceActionBusy"[\s\S]*?emit\("instanceContextMenuCommand", \{ command, instance: props\.instance \}\)/);
  assert.match(menuContent, /<InstanceActionMenuItems[\s\S]*?variant="context"[\s\S]*?@run-action="\(action\) => emit\('command', \{ type: 'run-action', action \}\)"/);
  assert.match(sessionPane, /<InstanceSessionPanel[\s\S]*?:instance-action-menu="instanceActionMenuBindings"/);
  assert.match(story, /<InstanceSessionPanel[\s\S]*?:instance-action-menu="storyInstanceActionMenu"[\s\S]*?@instance-context-menu-command="\$emit\('instanceContextMenuCommand', \$event\)"/);
  assert.match(detail, /@instance-context-menu-command="\$emit\('instanceContextMenuCommand', \$event\)"/);
  assert.match(workbench, /<StoryView[\s\S]*?:active-action-label="activeActionLabel"[\s\S]*?:can-export-config="canExportConfig"[\s\S]*?:is-closing-all-sessions="isClosingAllInstanceSessions"[\s\S]*?:is-instance-action-busy="isInstanceActionBusy"[\s\S]*?@instance-context-menu-command="handleInstanceContextMenuCommand"/);
  assert.match(workbench, /function handleInstanceContextMenuCommand[\s\S]*?runInstanceAction\(command\.action, instance\)[\s\S]*?openConfigSync\(command\.direction, instance\)[\s\S]*?openSaveEnvironmentTemplate\(instance\)[\s\S]*?confirmCloseAllInstanceSessions\(instance\)/);
});
