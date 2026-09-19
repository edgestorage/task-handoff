<template>
  <div class="model-entity-selection">
    <div v-if="selectedModels.length" class="model-entity-group">
      <div class="model-entity-group-heading">
        <strong>{{ t("instances.modelEntities.selected") }}</strong>
        <small>{{ t("instances.modelEntities.orderHint") }}</small>
      </div>
      <TransitionGroup
        name="model-entity-row"
        tag="div"
        class="model-entity-list"
        :class="{ 'model-entity-list-dragging': draggingModelId, 'model-entity-list-settling': dragSettling }"
        role="list"
        @dragover.prevent="previewDrag"
        @drop.prevent="commitDrag"
      >
        <article
          v-for="(model, index) in selectedModels"
          :key="model.id"
          class="model-entity-row"
          :class="{ 'model-entity-row-dragging': draggingModelId === model.id }"
          :style="dragStyle(index)"
          role="listitem"
        >
          <span class="model-entity-order" aria-hidden="true">{{ index + 1 }}</span>
          <span class="model-entity-copy">
            <strong>{{ model.name }}</strong>
            <small>{{ modelDescription(model) }}</small>
          </span>
          <span class="model-entity-actions">
            <DropdownMenu :open="openModelMenuId === model.id" @update:open="handleMenuOpenChange($event, model.id)">
              <DropdownMenuTrigger as-child>
                <button
                  type="button"
                  class="model-entity-drag-handle"
                  :disabled="disabled"
                  :draggable="!disabled"
                  :aria-label="t('instances.modelEntities.reorder', { name: model.name })"
                  :title="t('instances.modelEntities.reorder', { name: model.name })"
                  @click="toggleModelMenu($event, model.id)"
                  @dragend="cancelDrag"
                  @dragstart="startDrag($event, model.id)"
                  @keydown.capture="handleMenuKeydown($event, model.id)"
                  @pointerdown.capture="rememberMenuState(model.id)"
                >
                  <GripVertical :size="17" :stroke-width="1.8" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" :side-offset="6">
                <DropdownMenuItem :disabled="disabled || index === 0" @select="move(model.id, -1)">
                  <ChevronUp :size="14" />
                  <span>{{ t("instances.modelEntities.moveUpAction") }}</span>
                </DropdownMenuItem>
                <DropdownMenuItem :disabled="disabled || index === selectedModels.length - 1" @select="move(model.id, 1)">
                  <ChevronDown :size="14" />
                  <span>{{ t("instances.modelEntities.moveDownAction") }}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button type="button" variant="ghost" size="icon-sm" :disabled="disabled" :aria-label="t('instances.modelEntities.remove', { name: model.name })" @click="remove(model.id)">
              <X :size="15" />
            </Button>
          </span>
        </article>
      </TransitionGroup>
    </div>

    <div v-if="availableModels.length" class="model-entity-group model-entity-available">
      <div class="model-entity-group-heading">
        <strong>{{ t("instances.modelEntities.available") }}</strong>
        <small>{{ t("instances.modelEntities.availableHint") }}</small>
      </div>
      <div class="model-entity-list" role="list">
        <article v-for="model in availableModels" :key="model.id" class="model-entity-row" role="listitem">
          <span class="model-entity-copy">
            <strong>{{ model.name }}</strong>
            <small>{{ modelDescription(model) }}</small>
          </span>
          <Button type="button" variant="ghost" size="sm" :disabled="disabled" @click="add(model.id)">
            <Plus :size="15" />
            {{ t("instances.modelEntities.add") }}
          </Button>
        </article>
      </div>
    </div>

    <p v-if="!selectedModels.length && !availableModels.length" class="model-entity-empty">
      {{ t("instances.modelEntities.empty") }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronUp, GripVertical, Plus, X } from "@lucide/vue";
import type { ModelConfig } from "../../api/types";
import { Button } from "../ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";

const props = defineProps<{
  modelValue: string[];
  models: ModelConfig[];
  nodeId: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();
const { t } = useI18n();

const eligibleModels = computed(() => props.models
  .filter((model) => model.enabled && model.locations?.some((location) => location.enabled && (location.type === "control-plane" || location.nodeId === props.nodeId)))
  .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)));
const modelById = computed(() => new Map(props.models.map((model) => [model.id, model])));
const selectedModels = computed(() => props.modelValue.map((id) => modelById.value.get(id)).filter((model): model is ModelConfig => Boolean(model)));
const selectedIds = computed(() => new Set(props.modelValue));
const availableModels = computed(() => eligibleModels.value.filter((model) => !selectedIds.value.has(model.id)));
const draggingModelId = ref("");
const dragTargetModelId = ref("");
const dragStep = ref(0);
const dragSettling = ref(false);
const openModelMenuId = ref("");
const menuOpenOnPointerDownId = ref("");
let dragSlots: Array<{ id: string; centerY: number }> = [];

function add(id: string) {
  if (!selectedIds.value.has(id)) emit("update:modelValue", [...props.modelValue, id]);
}

function remove(id: string) {
  emit("update:modelValue", props.modelValue.filter((candidate) => candidate !== id));
}

function move(id: string, delta: -1 | 1) {
  const index = props.modelValue.indexOf(id);
  const adjacentModel = selectedModels.value[selectedModels.value.findIndex((model) => model.id === id) + delta];
  if (index < 0 || !adjacentModel) return;
  const target = props.modelValue.indexOf(adjacentModel.id);
  if (target < 0) return;
  const next = [...props.modelValue];
  [next[index], next[target]] = [next[target], next[index]];
  emit("update:modelValue", next);
}

function startDrag(event: DragEvent, id: string) {
  if (props.disabled) {
    event.preventDefault();
    return;
  }
  openModelMenuId.value = "";
  menuOpenOnPointerDownId.value = "";
  draggingModelId.value = id;
  dragTargetModelId.value = id;
  const row = (event.currentTarget as HTMLElement | null)?.closest<HTMLElement>(".model-entity-row");
  const rows = row?.parentElement?.querySelectorAll<HTMLElement>(".model-entity-row") || [];
  dragSlots = [...rows].map((candidate, index) => {
    const bounds = candidate.getBoundingClientRect();
    return { id: selectedModels.value[index]?.id || "", centerY: bounds.top + bounds.height / 2 };
  }).filter((slot) => slot.id);
  dragStep.value = row?.offsetHeight || 0;
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", id);
  if (row) {
    const bounds = row.getBoundingClientRect();
    const offsetX = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width);
    const offsetY = Math.min(Math.max(event.clientY - bounds.top, 0), bounds.height);
    event.dataTransfer.setDragImage(row, offsetX, offsetY);
  }
}

function rememberMenuState(id: string) {
  menuOpenOnPointerDownId.value = openModelMenuId.value === id ? id : "";
}

function toggleModelMenu(event: MouseEvent, id: string) {
  const wasOpen = event.detail === 0 ? openModelMenuId.value === id : menuOpenOnPointerDownId.value === id;
  openModelMenuId.value = wasOpen ? "" : id;
  menuOpenOnPointerDownId.value = "";
}

function handleMenuKeydown(event: KeyboardEvent, id: string) {
  if (!["Enter", " ", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openModelMenuId.value = openModelMenuId.value === id && event.key !== "ArrowDown" ? "" : id;
}

function handleMenuOpenChange(open: boolean, id: string) {
  if (!open && openModelMenuId.value === id) openModelMenuId.value = "";
}

function previewDrag(event: DragEvent) {
  if (!draggingModelId.value) return;
  const sourceIndex = dragSlots.findIndex((slot) => slot.id === draggingModelId.value);
  if (sourceIndex < 0) return;
  let targetIndex = sourceIndex;
  if (event.clientY >= dragSlots[sourceIndex].centerY) {
    for (let index = sourceIndex + 1; index < dragSlots.length && event.clientY >= dragSlots[index].centerY; index += 1) targetIndex = index;
  } else {
    for (let index = sourceIndex - 1; index >= 0 && event.clientY <= dragSlots[index].centerY; index -= 1) targetIndex = index;
  }
  dragTargetModelId.value = dragSlots[targetIndex].id;
}

function dragStyle(index: number) {
  const sourceIndex = selectedModels.value.findIndex((model) => model.id === draggingModelId.value);
  const targetIndex = selectedModels.value.findIndex((model) => model.id === dragTargetModelId.value);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return undefined;
  if (sourceIndex < targetIndex && index > sourceIndex && index <= targetIndex) return { transform: `translate3d(0, -${dragStep.value}px, 0)` };
  if (sourceIndex > targetIndex && index >= targetIndex && index < sourceIndex) return { transform: `translate3d(0, ${dragStep.value}px, 0)` };
  return undefined;
}

function commitDrag() {
  const sourceId = draggingModelId.value;
  const targetId = dragTargetModelId.value;
  const sourceIndex = props.modelValue.indexOf(sourceId);
  const targetIndex = props.modelValue.indexOf(targetId);
  if (sourceIndex >= 0 && targetIndex >= 0 && sourceIndex !== targetIndex) {
    const next = [...props.modelValue];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    dragSettling.value = true;
    emit("update:modelValue", next);
    void nextTick(() => requestAnimationFrame(() => { dragSettling.value = false; }));
  }
  cancelDrag();
}

function cancelDrag() {
  draggingModelId.value = "";
  dragTargetModelId.value = "";
  dragStep.value = 0;
  dragSlots = [];
}

function modelDescription(model: ModelConfig) {
  const names = [...(model.modelNames?.length ? model.modelNames : [{ name: model.model, order: 0 }])]
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((entry) => entry.name)
    .join(", ");
  return `${names} · ${(model.protocols || []).join(", ")}`;
}
</script>

<style scoped>
.model-entity-selection {
  display: grid;
}

.model-entity-group + .model-entity-group {
  border-top: 1px solid var(--line);
}

.model-entity-group-heading {
  display: grid;
  gap: 2px;
  padding: 12px 16px 8px;
}

.model-entity-group-heading strong,
.model-entity-copy strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}

.model-entity-group-heading small,
.model-entity-copy small,
.model-entity-empty {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.45;
}

.model-entity-list {
  display: grid;
}

.model-entity-row {
  display: flex;
  min-width: 0;
  min-height: 54px;
  align-items: center;
  gap: 10px;
  padding: 8px 12px 8px 16px;
  transition: transform 140ms cubic-bezier(.2, .8, .2, 1), background-color 120ms ease, opacity 120ms ease;
}

.model-entity-row-move {
  transition: transform 180ms ease, background-color 120ms ease, opacity 120ms ease;
}

.model-entity-list-dragging .model-entity-row {
  will-change: transform;
}

.model-entity-list-settling .model-entity-row {
  transition: none;
}

.model-entity-row-dragging {
  opacity: 0;
}

.model-entity-row + .model-entity-row {
  border-top: 1px solid var(--line);
}

.model-entity-order {
  display: grid;
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 6px;
  background: var(--surface-active);
  color: var(--text-muted);
  font-size: 12px;
}

.model-entity-copy {
  display: grid;
  min-width: 0;
  flex: 1 1 auto;
  gap: 2px;
}

.model-entity-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-entity-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
}

.model-entity-drag-handle {
  display: grid;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: grab;
  padding: 0;
  touch-action: none;
}

.model-entity-drag-handle:hover {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.model-entity-drag-handle:active {
  cursor: grabbing;
}

.model-entity-drag-handle:focus-visible {
  box-shadow: 0 0 0 2px var(--focus-ring);
  outline: none;
}

.model-entity-drag-handle:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.model-entity-empty {
  margin: 0;
  padding: 16px;
}

@media (max-width: 560px) {
  .model-entity-row {
    align-items: flex-start;
  }

  .model-entity-actions {
    align-self: center;
  }
}

@media (prefers-reduced-motion: reduce) {
  .model-entity-row,
  .model-entity-row-move {
    transition: none;
  }
}
</style>
