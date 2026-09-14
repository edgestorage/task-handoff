<template>
  <section class="ai-session-detail-queue" :data-tone="tone" :data-placement="placement">
    <span class="ai-session-detail-queue-label">{{ t("sessions.activity.queue", { count: queue.pendingCount }) }}</span>
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
</template>

<script setup lang="ts">
import { CornerDownRight, GripVertical, Pencil, RotateCcw, Trash2 } from "@lucide/vue";
import type { AiSessionQueue } from "@task-handoff/protocol/ai-sessions";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ScrollArea } from "../ui/scroll-area";

const props = withDefaults(defineProps<{
  busy?: boolean;
  canInterrupt?: boolean;
  placement?: "detail" | "composer";
  queue: AiSessionQueue;
  tone?: "detail" | "board";
}>(), {
  busy: false,
  canInterrupt: false,
  placement: "detail",
  tone: "detail",
});

const emit = defineEmits<{
  editQueuedMessage: [payload: { queueId: string; message: string }];
  removeQueuedMessage: [queueId: string];
  reorderQueuedMessages: [payload: { expectedRevision: number; queueIds: string[] }];
  retryQueuedMessage: [queueId: string];
  steerQueuedMessage: [queueId: string];
}>();

const { t } = useI18n();
const draggingQueueId = ref("");
const queueOrderPreview = ref<string[]>([]);
const queuedItems = computed(() => props.queue.items.filter((item) => item.status === "queued"));
const displayedQueueItems = computed(() => queueItemsWithQueuedOrder(props.queue.items, queueOrderPreview.value));

function moveQueuedMessage(queueId: string, offset: -1 | 1) {
  const queueIds = queuedItems.value.map((item) => item.id);
  const index = queueIds.indexOf(queueId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= queueIds.length) return;
  [queueIds[index], queueIds[target]] = [queueIds[target], queueIds[index]];
  emit("reorderQueuedMessages", { expectedRevision: props.queue.revision, queueIds });
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
  if (!queuedItems.value.some((item) => item.id === targetQueueId)) return;
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
  if (!unchanged) emit("reorderQueuedMessages", { expectedRevision: props.queue.revision, queueIds });
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

watch(() => props.queue.revision, cancelQueueDrag);
</script>

<style scoped>
.ai-session-detail-queue {
  --queue-border: var(--line-subtle);
  --queue-surface: var(--surface-raised);
  --queue-hover: var(--surface-subtle);
  --queue-text: var(--text);
  --queue-strong: var(--text-strong);
  --queue-muted: var(--text-muted);
  --queue-danger: var(--status-danger);
  min-width: 0;
}

.ai-session-detail-queue[data-tone="board"] {
  --queue-border: var(--ai-board-column-border);
  --queue-surface: var(--ai-board-floating-bg);
  --queue-hover: var(--ai-board-card-bg);
  --queue-text: var(--ai-board-title);
  --queue-strong: var(--ai-board-title);
  --queue-muted: var(--ai-board-muted);
  --queue-danger: var(--ai-board-card-failed-border);
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
  border: 1px solid var(--queue-border);
  border-radius: 10px;
  background: var(--queue-surface);
}

.ai-session-detail-queue[data-placement="composer"] .ai-session-detail-queue-list {
  border-radius: 18px 18px 0 0;
}

.ai-session-detail-queue-list :deep([data-reka-scroll-area-viewport]) {
  max-height: 220px;
}

.ai-session-detail-queue[data-placement="composer"] .ai-session-detail-queue-list :deep([data-reka-scroll-area-viewport]) {
  max-height: 150px;
}

.ai-session-detail-queue-item {
  display: grid;
  grid-template-columns: 17px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-width: 0;
  min-height: 38px;
  padding: 4px 9px;
}

.ai-session-detail-queue-item + .ai-session-detail-queue-item { border-top: 1px solid var(--queue-border); }
.ai-session-detail-queue-icon { color: var(--queue-muted); }

.ai-session-detail-queue-drag-handle {
  display: grid;
  width: 26px;
  height: 30px;
  margin-inline: -5px;
  color: var(--queue-muted);
  cursor: grab;
  outline: none;
  place-items: center;
  touch-action: none;
}

.ai-session-detail-queue-drag-handle:active { cursor: grabbing; }
.ai-session-detail-queue-drag-handle:focus-visible { border-radius: 5px; box-shadow: 0 0 0 2px color-mix(in srgb, var(--queue-text) 35%, transparent); }
.ai-session-detail-queue-drag-handle[aria-disabled="true"] { cursor: default; opacity: 0.35; }
.ai-session-detail-queue-item-dragging { background: color-mix(in srgb, var(--queue-text) 6%, transparent); opacity: 0.72; }
.ai-session-detail-queue-item[data-state="failed"] .ai-session-detail-queue-icon { color: var(--queue-danger); }
.ai-session-detail-queue-copy { min-width: 0; }

.ai-session-detail-queue-item p {
  display: -webkit-box;
  overflow: hidden;
  margin: 0;
  color: var(--queue-text);
  font-size: 13px;
  line-height: 1.4;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
  line-clamp: 1;
}

.ai-session-detail-queue-item small { color: var(--queue-muted); font-size: 12px; overflow-wrap: anywhere; }
.ai-session-detail-queue-actions { display: flex; align-items: center; gap: 2px; }

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
  color: var(--queue-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 0 5px;
}

.ai-session-detail-queue-actions button:hover { background: var(--queue-hover); color: var(--queue-strong); }
.ai-session-detail-queue-actions button:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--focus-ring, var(--queue-strong)); }
.ai-session-detail-queue-actions button:disabled { cursor: not-allowed; opacity: 0.55; }
.ai-session-detail-queue-actions .ai-session-detail-queue-remove:hover { background: color-mix(in srgb, var(--queue-danger) 12%, transparent); color: var(--queue-danger); }
</style>
