import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { createControlPlaneI18nForTest } from "../src/i18n/testing.ts";

const root = new URL("../src/", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("queued messages render attachment names even without text", async (context) => {
  const server = await createServer({
    appType: "custom",
    logLevel: "silent",
    root: fileURLToPath(new URL("../", import.meta.url)),
    server: { middlewareMode: true },
  });
  context.after(() => server.close());
  const { default: AiSessionQueue } = await server.ssrLoadModule("/src/components/ai-session/AiSessionQueue.vue");
  const items = [
    { id: "queue-image", message: "", names: ["screenshot.png", "notes.txt"] },
    { id: "queue-report", message: "", names: ["report.pdf"] },
    { id: "queue-mixed", message: "Review this", names: ["data.csv"] },
    { id: "queue-text", message: "Text only", names: [] },
  ].map(({ id, message, names }) => ({
    id,
    message,
    status: "queued",
    attachments: names.map((name) => ({ id: `${id}-${name}`, name })),
  }));
  const app = createSSRApp({
    render: () => h(AiSessionQueue, { queue: { revision: 1, pendingCount: items.length, items } }),
  });
  app.use(createControlPlaneI18nForTest());

  const html = await renderToString(app);
  const rows = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].map((match) => match[1]);
  assert.equal(rows.length, 4);
  assert.match(rows[0], />screenshot\.png<.*>notes\.txt</s);
  assert.match(rows[1], />report\.pdf</);
  assert.doesNotMatch(rows[0] + rows[1], /<p\b[^>]*>\s*<\/p>/);
  assert.match(rows[2], />Review this<.*>data\.csv</s);
  assert.match(rows[3], />Text only</);
  assert.doesNotMatch(rows[3], /<ul\b/);
});

test("AI session queue edit and reorder actions stay revisioned through both control-plane surfaces", () => {
  const queue = read("components/ai-session/AiSessionQueue.vue");
  const result = read("components/ai-session/AiSessionResult.vue");
  const board = read("apps/control-plane/ai-board/AiSessionBoardView.vue");
  const dock = read("apps/control-plane/ai-board/AiSessionFloatingDock.vue");
  const panel = read("apps/control-plane/instance-detail/AiSessionPanel.vue");
  const queries = read("api/queries.ts");
  const attachmentUpload = read("components/ai-session/attachmentUpload.ts");

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
  assert.match(board, /queuedMessageComposerAttachments\(card\.instance\.id, card\.session\.id, item\)/);
  assert.match(board, /prepareQueuedMessageEditAttachments\(messageAttachments\.value/);
  assert.match(board, /selectedCardConversationSession\.value\?\.queue\.revision \?\? card\.session\.queue\.revision/);
  assert.match(board, /cancelQueueComposerEdit/);
  assert.match(board, /item\.status !== "queued"/);
  assert.match(board, /selectedCardConversationSession\.value \|\| selectedCard\.value\?\.session/);
  assert.match(dock, /@reorder-queued-messages="\$emit\('reorderQueuedMessages', \$event\)"/);
  assert.match(board, /editAiSessionQueuedMessage/);
  assert.match(board, /reorderAiSessionQueuedMessages/);
  assert.match(panel, /editAiSessionQueuedMessage/);
  assert.match(panel, /messageDraft\.value = payload\.message/);
  assert.match(panel, /queuedMessageComposerAttachments\(props\.instance\.id, sessionId, item\)/);
  assert.match(panel, /prepareQueuedMessageEditAttachments\(messageAttachments\.value/);
  assert.match(panel, /selectedConversationSession\.value\?\.queue\.revision \?\? session\.queue\.revision/);
  assert.match(panel, /reorderAiSessionQueuedMessages/);
  assert.match(panel, /item\.status !== "queued"/);
  assert.match(panel, /selectedConversationSession\.value \|\| selectedSession\.value/);
  assert.match(queries, /sharedAiSessionsApi\.editQueue/);
  assert.match(queries, /sharedAiSessionsApi\.reorderQueue/);
  assert.match(attachmentUpload, /source: \{ type: "retained" \}/);
  assert.match(attachmentUpload, /messages\/\$\{encodeURIComponent\(item\.messageId\)\}\/attachments/);
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
  assert.match(appearance, /\.queue-placement-choice, \.remote-desktop-preview-choice \{[^}]*height: 32px;[^}]*border: 1px solid var\(--line\);[^}]*background: var\(--surface-active\);[^}]*padding: 2px;/s);
  assert.match(appearance, /\.queue-placement-choice :deep\(button\[data-state="on"\]\), \.remote-desktop-preview-choice :deep\(button\[data-state="on"\]\) \{[^}]*background: var\(--surface-raised\);[^}]*box-shadow:/s);
  assert.match(result, /<AiSessionQueue[\s\S]*v-if="showQueue && isLatest/);
  assert.match(result, /showQueue: false/);
  assert.match(conversation, /:show-queue="queuePlacement === 'detail'"/);
  assert.match(panel, /class="session-ai-compose-stack"[\s\S]*effectiveTimelineViewMode === 'full' \|\| queuePlacement === 'composer'[\s\S]*<AiSessionComposer/);
  assert.match(panel, /composerStackEl\.value \|\| composer/);
  assert.match(panelStyles, /\.session-ai-compose-stack[\s\S]*position: absolute;/);
  assert.match(dock, /class="ai-board-floating-compose-stack"[\s\S]*timelineMode === 'full' \|\| queuePlacement === 'composer'[\s\S]*<AiSessionComposer/);
});

test("the queue card exposes a capability-gated pause toggle across both control-plane surfaces", () => {
  const queue = read("components/ai-session/AiSessionQueue.vue");
  const result = read("components/ai-session/AiSessionResult.vue");
  const conversation = read("components/ai-session/AiSessionConversationContent.vue");
  const panel = read("apps/control-plane/instance-detail/AiSessionPanel.vue");
  const panelStyles = read("apps/control-plane/instance-detail/AiSessionPanel.css");
  const dock = read("apps/control-plane/ai-board/AiSessionFloatingDock.vue");
  const board = read("apps/control-plane/ai-board/AiSessionBoardView.vue");
  const queries = read("api/queries.ts");
  const zh = read("i18n/locales/zh-CN/sessions.ts");
  const en = read("i18n/locales/en-US/sessions.ts");

  assert.match(queue, /class="ai-session-detail-queue-head"/);
  assert.match(queue, /props\.queue\.paused === true/);
  assert.match(queue, /emit\("setQueuePaused", !paused\.value\)/);
  assert.match(queue, /t\('sessions\.activity\.pauseQueue'\)/);
  assert.match(queue, /t\('sessions\.activity\.resumeQueue'\)/);
  assert.match(queue, /v-if="canPause"/);
  assert.doesNotMatch(queue, /ai-session-detail-queue-label/);
  assert.match(queue, /\.ai-session-detail-queue-pause \{/);
  // 头部底边框作为与首条排队项的分割线：用 --line 与条目间更浅的 --queue-border 区分，和决策块头部一致。
  assert.match(queue, /\.ai-session-detail-queue-head \{[^}]*border-bottom: 1px solid var\(--line\);/s);
  assert.doesNotMatch(queue, /\.ai-session-detail-queue-head \{[^}]*border-bottom: 0;/s);
  assert.match(result, /:can-pause="canPauseQueue"/);
  assert.match(result, /@set-queue-paused="\$emit\('setQueuePaused', \$event\)"/);
  assert.match(conversation, /:can-pause-queue="canPauseQueue"/);
  assert.match(conversation, /@set-queue-paused="\$emit\('setQueuePaused', \$event\)"/);
  assert.match(panel, /:can-pause="canPauseAiSessionQueue"/);
  assert.match(panel, /supportsAiSessionQueuePause\(props\.instance\.capabilities\)/);
  assert.match(panel, /setAiSessionQueuePaused\(props\.instance\.id, sessionId, paused\)/);
  assert.match(dock, /:can-pause="canPauseQueue"/);
  assert.match(board, /supportsAiSessionQueuePause\(instance\.capabilities\)/);
  assert.match(board, /setAiSessionQueuePaused\(card\.instance\.id, card\.session\.id, paused\)/);
  assert.match(queries, /sharedAiSessionsApi\.pauseQueue/);
  assert.match(panelStyles, /\.session-ai-compose-decisions \+ \.session-ai-compose-queue :deep\(\.ai-session-detail-queue-head\)/);
  assert.match(zh, /pauseQueue: "暂停排队"/);
  assert.match(en, /resumeQueue: "Resume queue"/);
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
