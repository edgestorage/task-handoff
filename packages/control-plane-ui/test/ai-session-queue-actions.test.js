import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../src/", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("AI session queue edit and reorder actions stay revisioned through both control-plane surfaces", () => {
  const queue = read("components/ai-session/AiSessionQueue.vue");
  const result = read("components/ai-session/AiSessionResult.vue");
  const board = read("apps/control-plane/ai-board/AiSessionBoardView.vue");
  const dock = read("apps/control-plane/ai-board/AiSessionFloatingDock.vue");
  const panel = read("apps/control-plane/instance-detail/AiSessionPanel.vue");
  const queries = read("api/queries.ts");

  assert.match(queue, /props\.queue\.revision/);
  assert.match(queue, /emit\("reorderQueuedMessages", \{ expectedRevision:/);
  assert.match(queue, /\$emit\('editQueuedMessage', \{ queueId: item\.id, message: item\.message \}\)/);
  assert.doesNotMatch(queue, /queue-editor|editingQueueId/);
  assert.match(queue, /@dragstart="startQueueDrag/);
  assert.match(queue, /@dragenter\.prevent="previewQueueDrag/);
  assert.match(queue, /@drop\.prevent="commitQueueDrag/);
  assert.match(queue, /@dragend="cancelQueueDrag/);
  assert.match(queue, /sessions\.activity\.reorder/);
  assert.doesNotMatch(queue, /ChevronUp|ChevronDown/);
  assert.match(queue, /sessions\.activity\.edit/);
  assert.match(result, /<AiSessionQueue[\s\S]*?<AiSessionTurnHistory/);
  assert.match(queue, /\.ai-session-detail-queue-item\s*\{[^}]*min-height: 38px;[^}]*padding: 4px 9px;/s);
  assert.match(queue, /\.ai-session-detail-queue-item p\s*\{[^}]*-webkit-line-clamp: 1;[^}]*line-clamp: 1;/s);
  assert.match(queue, /\[data-placement="composer"\] \.ai-session-detail-queue-list :deep\(\[data-reka-scroll-area-viewport\]\)\s*\{[^}]*max-height: 150px;/s);
  assert.match(dock, /@edit-queued-message="\$emit\('editQueuedMessage', \$event\)"/);
  assert.match(dock, /:editing-label="editingLabel"/);
  assert.match(board, /messageDraft\.value = payload\.message/);
  assert.match(board, /selectedCardConversationSession\.value\?\.queue\.revision \?\? card\.session\.queue\.revision/);
  assert.match(board, /cancelQueueComposerEdit/);
  assert.match(board, /item\.status !== "queued"/);
  assert.match(board, /selectedCardConversationSession\.value \|\| selectedCard\.value\?\.session/);
  assert.match(dock, /@reorder-queued-messages="\$emit\('reorderQueuedMessages', \$event\)"/);
  assert.match(board, /editAiSessionQueuedMessage/);
  assert.match(board, /reorderAiSessionQueuedMessages/);
  assert.match(panel, /editAiSessionQueuedMessage/);
  assert.match(panel, /messageDraft\.value = payload\.message/);
  assert.match(panel, /selectedConversationSession\.value\?\.queue\.revision \?\? session\.queue\.revision/);
  assert.match(panel, /reorderAiSessionQueuedMessages/);
  assert.match(panel, /item\.status !== "queued"/);
  assert.match(panel, /selectedConversationSession\.value \|\| selectedSession\.value/);
  assert.match(queries, /sharedAiSessionsApi\.editQueue/);
  assert.match(queries, /sharedAiSessionsApi\.reorderQueue/);
});

test("queued messages use one browser-local placement across detail and board composers", () => {
  const preference = read("apps/control-plane/useAiSessionQueuePlacement.ts");
  const appearance = read("apps/control-plane/settings/AppearanceSettingsSection.vue");
  const conversation = read("components/ai-session/AiSessionConversationContent.vue");
  const result = read("components/ai-session/AiSessionResult.vue");
  const panel = read("apps/control-plane/instance-detail/AiSessionPanel.vue");
  const panelStyles = read("apps/control-plane/instance-detail/AiSessionPanel.css");
  const dock = read("apps/control-plane/ai-board/AiSessionFloatingDock.vue");

  assert.match(preference, /type AiSessionQueuePlacement = "detail" \| "composer"/);
  assert.match(preference, /shallowRef<AiSessionQueuePlacement>\("composer"\)/);
  assert.match(preference, /localStorage\?\.getItem\(STORAGE_KEY\) === "detail" \? "detail" : "composer"/);
  assert.match(preference, /localStorage\?\.setItem\(STORAGE_KEY, value\)/);
  assert.match(appearance, /settings\.appearance\.queuePlacement/);
  assert.match(appearance, /<ToggleGroup[\s\S]*value="detail"[\s\S]*value="composer"/);
  assert.match(appearance, /\.queue-placement-choice \{[^}]*height: 32px;[^}]*border: 1px solid var\(--line\);[^}]*background: var\(--surface-active\);[^}]*padding: 2px;/s);
  assert.match(appearance, /\.queue-placement-choice :deep\(button\[data-state="on"\]\) \{[^}]*background: var\(--surface-raised\);[^}]*box-shadow:/s);
  assert.match(result, /<AiSessionQueue[\s\S]*v-if="showQueue && isLatest/);
  assert.match(result, /showQueue: false/);
  assert.match(conversation, /:show-queue="queuePlacement === 'detail'"/);
  assert.match(panel, /class="session-ai-compose-stack"[\s\S]*effectiveTimelineViewMode === 'full' \|\| queuePlacement === 'composer'[\s\S]*<AiSessionComposer/);
  assert.match(panel, /composerStackEl\.value \|\| composer/);
  assert.match(panelStyles, /\.session-ai-compose-stack[\s\S]*position: absolute;/);
  assert.match(dock, /class="ai-board-floating-compose-stack"[\s\S]*timelineMode === 'full' \|\| queuePlacement === 'composer'[\s\S]*<AiSessionComposer/);
});

test("successful AI session actions consume only acknowledgements and wait for authoritative events", () => {
  const board = read("apps/control-plane/ai-board/AiSessionBoardView.vue");
  const panel = read("apps/control-plane/instance-detail/AiSessionPanel.vue");
  for (const surface of [board, panel]) {
    assert.doesNotMatch(surface, /applySelected(?:Card|Session)Detail|applyActionResult/);
    assert.match(surface, /await (?:sendAiSessionMessage|editAiSessionQueuedMessage|interruptAiSession|resolveAiSessionApproval)/);
    assert.doesNotMatch(surface, /await (?:sendAiSessionMessage|interruptAiSession|resolveAiSessionApproval|editAiSessionQueuedMessage)[\s\S]{0,500}await refreshBoard\(\)/);
  }
});
