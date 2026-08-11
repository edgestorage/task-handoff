import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../src/", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("AI session queue edit and reorder actions stay revisioned through both control-plane surfaces", () => {
  const result = read("components/ai-session/AiSessionResult.vue");
  const board = read("apps/control-plane/ai-board/AiSessionBoardView.vue");
  const dock = read("apps/control-plane/ai-board/AiSessionFloatingDock.vue");
  const panel = read("apps/control-plane/instance-detail/AiSessionPanel.vue");
  const queries = read("api/queries.ts");

  assert.match(result, /session\.queue\.revision/);
  assert.match(result, /emit\("reorderQueuedMessages", \{ expectedRevision:/);
  assert.match(result, /\$emit\('editQueuedMessage', \{ queueId: item\.id, message: item\.message \}\)/);
  assert.doesNotMatch(result, /queue-editor|editingQueueId/);
  assert.match(result, /@dragstart="startQueueDrag/);
  assert.match(result, /@dragenter\.prevent="previewQueueDrag/);
  assert.match(result, /@drop\.prevent="commitQueueDrag/);
  assert.match(result, /@dragend="cancelQueueDrag/);
  assert.match(result, /sessions\.activity\.reorder/);
  assert.doesNotMatch(result, /ChevronUp|ChevronDown/);
  assert.match(result, /sessions\.activity\.edit/);
  assert.match(result, /\.ai-session-detail-queue-item p\s*\{[^}]*-webkit-line-clamp: 2;[^}]*line-clamp: 2;/s);
  assert.match(dock, /@edit-queued-message="\$emit\('editQueuedMessage', \$event\)"/);
  assert.match(dock, /:editing-label="editingLabel"/);
  assert.match(board, /messageDraft\.value = payload\.message/);
  assert.match(board, /card\.session\.queue\.revision, message/);
  assert.match(board, /cancelQueueComposerEdit/);
  assert.match(dock, /@reorder-queued-messages="\$emit\('reorderQueuedMessages', \$event\)"/);
  assert.match(board, /editAiSessionQueuedMessage/);
  assert.match(board, /reorderAiSessionQueuedMessages/);
  assert.match(panel, /editAiSessionQueuedMessage/);
  assert.match(panel, /messageDraft\.value = payload\.message/);
  assert.match(panel, /session\.queue\.revision, message/);
  assert.match(panel, /reorderAiSessionQueuedMessages/);
  assert.match(queries, /sharedAiSessionsApi\.editQueue/);
  assert.match(queries, /sharedAiSessionsApi\.reorderQueue/);
});
