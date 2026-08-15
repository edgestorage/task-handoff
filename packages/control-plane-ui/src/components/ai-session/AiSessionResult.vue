<template>
  <div
    class="ai-session-result"
    :class="[
      `ai-session-result-${tone}`,
      { 'has-response': displayContent },
    ]"
  >
    <AiSessionTurnHistory :nodes="activityHistory" />

    <section
      v-show="displayContent"
      class="ai-session-detail-response"
      :class="{ 'ai-session-detail-response-active': active }"
    >
      <AiSessionStreamingMarkdown
        :code-tools="markdownCodeTools"
        :content="responseContent"
        :file-links="fileLinks"
        :instance-id="instanceId"
        :is-latest="isLatest"
        :session-id="session.id"
        @open-file="$emit('openFile', $event)"
      />
    </section>

    <AiSessionToolActivity
      v-if="isLatest && active"
      :current-tool="session.currentTool"
      :phase="session.phase"
      :status="session.status"
      :summary="session.summary"
      :tool-calls-since-last-message="session.toolCallsSinceLastMessage"
      :tone="tone"
      :activities="activities"
      :error="activityError"
      :interactive="activityInteractive"
      :loading="activityLoading"
    />

    <AiSessionSubAgents
      v-if="isLatest && session.subAgents?.length"
      :sub-agents="session.subAgents"
    />

    <section v-if="isLatest && session.queue?.items.length" class="ai-session-detail-queue">
      <span class="ai-session-detail-queue-label">{{ t("sessions.activity.queue", { count: session.queue.pendingCount }) }}</span>
      <ScrollArea type="auto" class="ai-session-detail-queue-list" :horizontal="false">
        <article
          v-for="item in displayedQueueItems"
          :key="item.id"
          class="ai-session-detail-queue-item"
          :class="{ 'ai-session-detail-queue-item-dragging': draggingQueueId === item.id }"
          :data-state="item.status"
          @dragenter.prevent="previewQueueDrag(item.id)"
          @dragover.prevent
          @drop.prevent="commitQueueDrag"
        >
          <div
            v-if="item.status === 'queued'"
            class="ai-session-detail-queue-drag-handle"
            :aria-disabled="busy"
            :aria-label="t('sessions.activity.reorder')"
            :draggable="!busy"
            role="button"
            tabindex="0"
            :title="t('sessions.activity.reorder')"
            @dragend="cancelQueueDrag"
            @dragstart="startQueueDrag($event, item.id)"
            @keydown="handleQueueHandleKeydown($event, item.id)"
          >
            <GripVertical :size="17" :stroke-width="1.8" />
          </div>
          <GripVertical v-else class="ai-session-detail-queue-icon" :size="17" :stroke-width="1.8" />
          <div class="ai-session-detail-queue-copy">
            <p>{{ item.message }}</p>
            <small v-if="item.error">{{ item.error }}</small>
          </div>
          <div class="ai-session-detail-queue-actions">
            <button v-if="item.status === 'queued'" type="button" :disabled="busy" :aria-label="t('sessions.activity.edit')" :title="t('sessions.activity.edit')" @click="$emit('editQueuedMessage', { queueId: item.id, message: item.message })">
              <Pencil :size="15" />
            </button>
            <button type="button" :disabled="busy || !canInterrupt" :title="t('sessions.activity.steer')" @click="$emit('steerQueuedMessage', item.id)">
              <CornerDownRight :size="15" />
              <span>{{ t("sessions.activity.steer") }}</span>
            </button>
            <button v-if="item.status === 'failed'" type="button" :disabled="busy" :aria-label="t('sessions.activity.retry')" :title="t('sessions.activity.retry')" @click="$emit('retryQueuedMessage', item.id)">
              <RotateCcw :size="15" />
            </button>
            <button type="button" class="ai-session-detail-queue-remove" :disabled="busy" :aria-label="t('sessions.activity.remove')" :title="t('sessions.activity.remove')" @click="$emit('removeQueuedMessage', item.id)">
              <Trash2 :size="15" />
            </button>
          </div>
        </article>
      </ScrollArea>
    </section>

    <div v-if="isLatest && canResolveApproval" class="ai-session-detail-approval">
      <button type="button" :disabled="busy" @click="$emit('resolveApproval', 'allow')">
        <Check :size="14" />
        <span>{{ t("sessions.actions.allow") }}</span>
      </button>
      <button type="button" :disabled="busy" @click="$emit('resolveApproval', 'skip')">
        <Ban :size="14" />
        <span>{{ t("sessions.actions.skip") }}</span>
      </button>
      <button type="button" :disabled="busy" @click="$emit('resolveApproval', 'deny')">
        <X :size="14" />
        <span>{{ t("sessions.actions.deny") }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Ban, Check, CornerDownRight, GripVertical, Pencil, RotateCcw, Trash2, X } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AiSessionSummary } from "../../api/types";
import type { AiSessionTimelineActivity } from "@task-handoff/protocol/ai-sessions";
import type { TimelineTurnNode } from "./timelineActivities";
import { useStreamingMessagesStore } from "../../apps/control-plane/useStreamingMessagesStore";
import { ScrollArea } from "../ui/scroll-area";
import AiSessionStreamingMarkdown from "./AiSessionStreamingMarkdown.vue";
import AiSessionTurnHistory from "./AiSessionTurnHistory.vue";
import AiSessionSubAgents from "./AiSessionSubAgents.vue";
import AiSessionToolActivity from "./AiSessionToolActivity.vue";

const { t } = useI18n();
const markdownCodeTools = computed(() => ({
  copiedLabel: t("sessions.markdown.copied"),
  copyLabel: t("sessions.markdown.copy"),
  plainTextLabel: t("sessions.markdown.plainText"),
}));

const props = withDefaults(defineProps<{
  busy?: boolean;
  canInterrupt?: boolean;
  canResolveApproval?: boolean;
  fileLinks?: boolean;
  instanceId: string;
  isLatest?: boolean;
  responseContent?: string;
  session: AiSessionSummary;
  tone?: "detail" | "board";
  activities?: AiSessionTimelineActivity[];
  activityHistory?: TimelineTurnNode[];
  activityError?: string;
  activityInteractive?: boolean;
  activityLoading?: boolean;
}>(), {
  busy: false,
  canInterrupt: false,
  canResolveApproval: false,
  fileLinks: false,
  isLatest: false,
  responseContent: "",
  tone: "detail",
  activities: () => [],
  activityHistory: () => [],
  activityError: "",
  activityInteractive: false,
  activityLoading: false,
});

const emit = defineEmits<{
  editQueuedMessage: [payload: { queueId: string; message: string }];
  openFile: [href: string];
  removeQueuedMessage: [queueId: string];
  reorderQueuedMessages: [payload: { expectedRevision: number; queueIds: string[] }];
  resolveApproval: [decision: "allow" | "deny" | "skip"];
  retryQueuedMessage: [queueId: string];
  steerQueuedMessage: [queueId: string];
}>();

const draggingQueueId = ref("");
const queueOrderPreview = ref<string[]>([]);
const queuedItems = computed(() => props.session.queue.items.filter((item) => item.status === "queued"));
const displayedQueueItems = computed(() => queueItemsWithQueuedOrder(props.session.queue.items, queueOrderPreview.value));
const active = computed(() => props.isLatest && (props.session.status === "running" || props.session.status === "waiting"));

function moveQueuedMessage(queueId: string, offset: -1 | 1) {
  const queueIds = queuedItems.value.map((item) => item.id);
  const index = queueIds.indexOf(queueId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= queueIds.length) return;
  [queueIds[index], queueIds[target]] = [queueIds[target], queueIds[index]];
  emit("reorderQueuedMessages", { expectedRevision: props.session.queue.revision, queueIds });
}

function startQueueDrag(event: DragEvent, queueId: string) {
  if (props.busy) {
    event.preventDefault();
    return;
  }
  draggingQueueId.value = queueId;
  queueOrderPreview.value = queuedItems.value.map((item) => item.id);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", queueId);
    const row = (event.currentTarget as HTMLElement | null)?.closest<HTMLElement>(".ai-session-detail-queue-item");
    if (row) event.dataTransfer.setDragImage(row, 8, row.offsetHeight / 2);
  }
}

function previewQueueDrag(targetQueueId: string) {
  if (!draggingQueueId.value || targetQueueId === draggingQueueId.value) return;
  const target = queuedItems.value.find((item) => item.id === targetQueueId);
  if (!target) return;
  const order = queueOrderPreview.value;
  const sourceIndex = order.indexOf(draggingQueueId.value);
  const targetIndex = order.indexOf(targetQueueId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  queueOrderPreview.value = moveQueueId(order, sourceIndex, targetIndex);
}

function commitQueueDrag() {
  if (!draggingQueueId.value) return;
  const queueIds = [...queueOrderPreview.value];
  const unchanged = arraysEqual(queueIds, queuedItems.value.map((item) => item.id));
  cancelQueueDrag();
  if (!unchanged) emit("reorderQueuedMessages", { expectedRevision: props.session.queue.revision, queueIds });
}

function cancelQueueDrag() {
  draggingQueueId.value = "";
  queueOrderPreview.value = [];
}

function handleQueueHandleKeydown(event: KeyboardEvent, queueId: string) {
  if (props.busy || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  moveQueuedMessage(queueId, event.key === "ArrowUp" ? -1 : 1);
}

function moveQueueId(queueIds: readonly string[], source: number, target: number) {
  if (source < 0 || target < 0 || source >= queueIds.length || target >= queueIds.length || source === target) return [...queueIds];
  const reordered = [...queueIds];
  const [item] = reordered.splice(source, 1);
  reordered.splice(target, 0, item);
  return reordered;
}

function queueItemsWithQueuedOrder<T extends { id: string; status: string }>(items: readonly T[], queueIds: readonly string[]) {
  if (!queueIds.length) return [...items];
  const queuedById = new Map(items.filter((item) => item.status === "queued").map((item) => [item.id, item]));
  const ordered = queueIds.map((id) => queuedById.get(id)).filter((item): item is T => Boolean(item));
  let queuedIndex = 0;
  return items.map((item) => item.status === "queued" ? ordered[queuedIndex++] || item : item);
}

function arraysEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

watch(() => props.session.queue.revision, () => {
  draggingQueueId.value = "";
  queueOrderPreview.value = [];
});

const streamingMessages = useStreamingMessagesStore();
const streamingContent = computed(() => props.isLatest
  ? streamingMessages.activeMessage(props.instanceId, props.session.id).value?.value.receivedText || ""
  : "");
const displayContent = computed(() => streamingContent.value || props.responseContent);
</script>

<style scoped>
.ai-session-result {
  --detail-activity-gap: 24px;
  --detail-response-line-height: 1.55;
  --detail-activity-border: var(--line-subtle);
  --detail-activity-surface: var(--surface-subtle);
  --detail-activity-text: var(--text);
  --detail-activity-strong: var(--text-strong);
  --detail-activity-muted: var(--text-muted);
  --detail-activity-danger: var(--status-danger);
  --detail-action-bg: var(--surface-raised);
  display: grid;
  align-content: start;
  gap: var(--detail-activity-gap);
  min-width: 0;
}

.ai-session-result-detail {
  gap: 0;
}

.ai-session-result-detail > * {
  margin-top: 0;
}

.ai-session-result-detail > * + * {
  margin-top: var(--detail-activity-gap);
}

.ai-session-result-board {
  --detail-activity-gap: 8px;
  --detail-response-line-height: 1.5;
  --detail-activity-border: var(--ai-board-column-border);
  --detail-activity-surface: var(--ai-board-card-bg);
  --detail-activity-text: var(--ai-board-title);
  --detail-activity-strong: var(--ai-board-title);
  --detail-activity-muted: var(--ai-board-muted);
  --detail-activity-danger: var(--ai-board-card-failed-border);
  --detail-action-bg: var(--ai-board-floating-bg);
  padding-top: 4px;
}

.ai-session-detail-response {
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--detail-activity-strong);
  padding-bottom: 12px;
}

.ai-session-result-detail .ai-session-detail-response {
  margin-inline: -10px;
  padding-inline: 10px;
  padding-bottom: 0;
}

.ai-session-result-board .ai-session-detail-response {
  margin-inline: -14px;
  padding-inline: 14px;
}

.ai-session-detail-response-active {
  padding-bottom: 4px;
}

.ai-session-result-detail .ai-session-detail-response-active {
  padding-bottom: 0;
}

.ai-session-detail-response :deep(> div) {
  color: var(--detail-activity-strong);
  font-size: 14px;
  font-weight: 400;
  line-height: var(--detail-response-line-height);
  overflow-wrap: anywhere;
  white-space: normal;
}

.ai-session-result-board :deep(.ai-session-tool-activity) {
  margin-top: 0;
}

.ai-session-result-board.has-response .ai-session-detail-response + :deep(.ai-session-tool-activity) {
  margin-top: calc(-1 * var(--detail-activity-gap));
}

.ai-session-detail-queue {
  min-width: 0;
}

.ai-session-detail-queue-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  clip-path: inset(50%);
}

.ai-session-detail-queue-list {
  border: 1px solid var(--detail-activity-border);
  border-radius: 10px;
  background: var(--detail-action-bg);
}

.ai-session-detail-queue-list :deep([data-reka-scroll-area-viewport]) {
  max-height: 220px;
}

.ai-session-detail-queue-item {
  display: grid;
  grid-template-columns: 17px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-width: 0;
  min-height: 42px;
  padding: 7px 9px;
}

.ai-session-detail-queue-item + .ai-session-detail-queue-item {
  border-top: 1px solid var(--detail-activity-border);
}

.ai-session-detail-queue-icon {
  color: var(--detail-activity-muted);
}

.ai-session-detail-queue-drag-handle {
  display: grid;
  width: 26px;
  height: 34px;
  margin-inline: -5px;
  color: var(--detail-activity-muted);
  cursor: grab;
  outline: none;
  place-items: center;
  touch-action: none;
}

.ai-session-detail-queue-drag-handle:active {
  cursor: grabbing;
}

.ai-session-detail-queue-drag-handle:focus-visible {
  border-radius: 5px;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--detail-activity-text) 35%, transparent);
}

.ai-session-detail-queue-drag-handle[aria-disabled="true"] {
  cursor: default;
  opacity: 0.35;
}

.ai-session-detail-queue-item-dragging {
  background: color-mix(in srgb, var(--detail-activity-text) 6%, transparent);
  opacity: 0.72;
}

.ai-session-detail-queue-item[data-state="failed"] .ai-session-detail-queue-icon {
  color: var(--detail-activity-danger);
}

.ai-session-detail-queue-copy {
  min-width: 0;
}

.ai-session-detail-queue-item p {
  display: -webkit-box;
  overflow: hidden;
  margin: 0;
  color: var(--detail-activity-text);
  font-size: 13px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}

.ai-session-detail-queue-item small {
  color: var(--detail-activity-muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.ai-session-detail-queue-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.ai-session-detail-queue-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 28px;
  min-height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--detail-activity-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 0 5px;
}

.ai-session-detail-queue-actions button:hover {
  background: var(--detail-activity-surface);
  color: var(--detail-activity-strong);
}

.ai-session-detail-queue-actions button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--focus-ring, var(--detail-activity-strong));
}

.ai-session-detail-queue-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ai-session-detail-queue-actions .ai-session-detail-queue-remove:hover {
  background: color-mix(in srgb, var(--detail-activity-danger) 12%, transparent);
  color: var(--detail-activity-danger);
}

.ai-session-detail-approval {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.ai-session-detail-approval button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 30px;
  border: 1px solid var(--detail-activity-border);
  border-radius: 7px;
  background: var(--detail-action-bg);
  color: var(--detail-activity-text);
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
  padding: 0 10px;
}

.ai-session-detail-approval button:hover,
.ai-session-detail-approval button:focus-visible {
  border-color: var(--focus-ring, var(--detail-activity-strong));
  color: var(--detail-activity-strong);
  outline: none;
}

.ai-session-detail-approval button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
