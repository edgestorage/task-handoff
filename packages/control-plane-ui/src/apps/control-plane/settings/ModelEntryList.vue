<template>
  <div ref="listElement" class="model-entry-list">
    <div v-if="entries.length" class="model-entry-columns" aria-hidden="true">
      <span></span>
      <span>{{ externalLabel }}</span>
      <span>{{ upstreamLabel }}</span>
      <span></span>
    </div>
    <div v-if="emptyText && !entries.length" class="model-entry-empty">{{ emptyText }}</div>
    <TransitionGroup name="model-entry-row" tag="div" class="model-entry-items" :class="{ 'model-entry-items-dragging': draggingIndex !== undefined, 'model-entry-items-settling': dragSettling }" @dragover.prevent @drop.prevent="commitDrag">
      <div v-for="(entry, index) in entries" :key="entryKey(entry)" class="model-entry-row" :class="{ 'model-entry-row-dragging': draggingIndex === index }" :style="dragStyle(index)" @dragover.prevent="previewDrag($event, index)">
        <DropdownMenu :open="openMenuKey === entryKey(entry)" @update:open="handleMenuOpenChange($event, entryKey(entry))">
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              class="model-entry-drag-handle"
              draggable="true"
              aria-keyshortcuts="ArrowUp ArrowDown"
              :aria-label="reorderLabel"
              :title="reorderLabel"
              @click="toggleMenu($event, entryKey(entry))"
              @dragend="cancelDrag"
              @dragstart="startDrag($event, index)"
              @keydown.capture="handleHandleKeydown($event, index, entryKey(entry))"
              @pointerdown.capture="rememberMenuState(entryKey(entry))"
            >
              <GripVertical :size="18" :stroke-width="1.8" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" :side-offset="6">
            <DropdownMenuItem :disabled="index === 0" @select="moveEntry(index, -1)"><ChevronUp :size="14" /><span>{{ moveUpLabel }}</span></DropdownMenuItem>
            <DropdownMenuItem :disabled="index === entries.length - 1" @select="moveEntry(index, 1)"><ChevronDown :size="14" /><span>{{ moveDownLabel }}</span></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <label class="model-entry-field">
          <span class="model-entry-field-label">{{ externalLabel }}</span>
          <ControlPlaneInput v-model="entry.name" :aria-label="externalLabel" :placeholder="externalPlaceholder" @update:model-value="(value: string) => emit('externalNameInput', index, value)" />
        </label>
        <label class="model-entry-field">
          <span class="model-entry-field-label">{{ upstreamLabel }}</span>
          <ControlPlaneInput v-model="entry.upstreamName" :aria-label="upstreamLabel" :placeholder="upstreamPlaceholderText(entry)" />
        </label>
        <Button class="model-entry-delete" type="button" variant="ghost" size="icon" :disabled="removeDisabled" :aria-label="removeLabel" @click="emit('remove', index)"><Trash2 :size="14" /></Button>
        <small v-if="rowNote?.(entry)" class="model-entry-note">{{ rowNote(entry) }}</small>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { ChevronDown, ChevronUp, GripVertical, Trash2 } from "@lucide/vue";
import { nextTick, ref } from "vue";
import { Button } from "../../../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";

type ModelEntry = { name: string; upstreamName?: string };

const props = withDefaults(defineProps<{
  entries: ModelEntry[];
  externalLabel: string;
  upstreamLabel: string;
  externalPlaceholder: string;
  upstreamPlaceholder: string | ((entry: ModelEntry) => string);
  reorderLabel: string;
  moveUpLabel: string;
  moveDownLabel: string;
  removeLabel: string;
  removeDisabled?: boolean;
  emptyText?: string;
  rowNote?: (entry: ModelEntry) => string | undefined;
}>(), { emptyText: "", removeDisabled: false, rowNote: undefined });
const emit = defineEmits<{
  remove: [index: number];
  move: [index: number, direction: -1 | 1];
  reorder: [source: number, target: number];
  externalNameInput: [index: number, value: string];
}>();

function upstreamPlaceholderText(entry: ModelEntry) {
  return typeof props.upstreamPlaceholder === "function" ? props.upstreamPlaceholder(entry) : props.upstreamPlaceholder;
}

const entryKeys = new WeakMap<object, number>();
let nextEntryKey = 0;
function entryKey(entry: object) {
  const existing = entryKeys.get(entry);
  if (existing !== undefined) return existing;
  const key = nextEntryKey++;
  entryKeys.set(entry, key);
  return key;
}

const listElement = ref<HTMLElement>();
const draggingIndex = ref<number>();
const dragTargetIndex = ref<number>();
const dragStep = ref(0);
const dragSettling = ref(false);
const openMenuKey = ref<number>();
const menuOpenOnPointerDownKey = ref<number>();

function startDrag(event: DragEvent, index: number) {
  openMenuKey.value = undefined;
  menuOpenOnPointerDownKey.value = undefined;
  draggingIndex.value = index;
  dragTargetIndex.value = index;
  const row = (event.currentTarget as HTMLElement | null)?.closest<HTMLElement>(".model-entry-row");
  const items = row?.parentElement;
  dragStep.value = row ? row.offsetHeight + Number.parseFloat(items ? getComputedStyle(items).rowGap || "0" : "0") : 0;
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(index));
  if (row) event.dataTransfer.setDragImage(row, 12, row.offsetHeight / 2);
}
function previewDrag(event: DragEvent, targetIndex: number) {
  const sourceIndex = draggingIndex.value;
  if (sourceIndex === undefined) return;
  const row = event.currentTarget as HTMLElement;
  const midpoint = row.getBoundingClientRect().top + row.offsetHeight / 2;
  if (sourceIndex < targetIndex && event.clientY < midpoint) return;
  if (sourceIndex > targetIndex && event.clientY > midpoint) return;
  dragTargetIndex.value = targetIndex;
}
function dragStyle(index: number) {
  const sourceIndex = draggingIndex.value;
  const targetIndex = dragTargetIndex.value;
  if (sourceIndex === undefined || targetIndex === undefined || sourceIndex === targetIndex) return undefined;
  if (sourceIndex < targetIndex && index > sourceIndex && index <= targetIndex) return { transform: `translate3d(0, -${dragStep.value}px, 0)` };
  if (sourceIndex > targetIndex && index >= targetIndex && index < sourceIndex) return { transform: `translate3d(0, ${dragStep.value}px, 0)` };
  return undefined;
}
function commitDrag() {
  const sourceIndex = draggingIndex.value;
  const targetIndex = dragTargetIndex.value;
  if (sourceIndex !== undefined && targetIndex !== undefined && sourceIndex !== targetIndex) {
    dragSettling.value = true;
    emit("reorder", sourceIndex, targetIndex);
    void nextTick(() => requestAnimationFrame(() => { dragSettling.value = false; }));
  }
  cancelDrag();
}
function cancelDrag() {
  draggingIndex.value = undefined;
  dragTargetIndex.value = undefined;
  dragStep.value = 0;
}
function moveEntry(index: number, direction: -1 | 1) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= props.entries.length) return;
  emit("move", index, direction);
  void nextTick(() => listElement.value?.querySelectorAll<HTMLButtonElement>(".model-entry-drag-handle")[targetIndex]?.focus());
}
function rememberMenuState(key: number) {
  menuOpenOnPointerDownKey.value = openMenuKey.value === key ? key : undefined;
}
function toggleMenu(event: MouseEvent, key: number) {
  const wasOpen = event.detail === 0 ? openMenuKey.value === key : menuOpenOnPointerDownKey.value === key;
  openMenuKey.value = wasOpen ? undefined : key;
  menuOpenOnPointerDownKey.value = undefined;
}
function handleMenuOpenChange(open: boolean, key: number) {
  if (!open && openMenuKey.value === key) openMenuKey.value = undefined;
}
function handleHandleKeydown(event: KeyboardEvent, index: number, key: number) {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopImmediatePropagation();
    openMenuKey.value = openMenuKey.value === key ? undefined : key;
    return;
  }
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  const targetIndex = index + (event.key === "ArrowUp" ? -1 : 1);
  if (targetIndex < 0 || targetIndex >= props.entries.length) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  moveEntry(index, event.key === "ArrowUp" ? -1 : 1);
}
</script>

<style scoped>
.model-entry-list { display: grid; gap: 7px; }
.model-entry-columns { color: var(--text-muted); display: grid; font-size: 12px; font-weight: 400; gap: 6px; grid-template-columns: 32px minmax(0,1fr) minmax(0,1fr) 36px; }
.model-entry-empty { border: 1px dashed var(--line-strong); border-radius: 6px; color: var(--text-muted); font-size: 12px; padding: 10px; text-align: center; }
.model-entry-items { display: grid; gap: 7px; }
.model-entry-row { align-items: center; border-radius: 6px; display: grid; gap: 6px; grid-template-columns: 32px minmax(0,1fr) minmax(0,1fr) auto; transition: transform 140ms cubic-bezier(.2,.8,.2,1), background-color 120ms ease, opacity 120ms ease; }
.model-entry-field { display: grid; gap: 3px; min-width: 0; }
.model-entry-field > span { color: var(--text-muted); font-size: 12px; font-weight: 400; }
.model-entry-field-label { display: none; }
.model-entry-note { color: var(--text-muted); font-size: 12px; grid-column: 1 / -1; line-height: 1.45; }
.model-entry-row-move { transition: transform 180ms ease, background-color 120ms ease, opacity 120ms ease; }
.model-entry-items-dragging .model-entry-row { will-change: transform; }
.model-entry-items-settling .model-entry-row { transition: none; }
.model-entry-drag-handle { align-items: center; align-self: stretch; background: transparent; border: 0; border-radius: 5px; color: var(--text-muted); cursor: grab; display: flex; justify-content: center; min-height: 36px; padding: 0; touch-action: none; }
.model-entry-drag-handle:hover { background: var(--surface-hover); color: var(--text-strong); }
.model-entry-drag-handle:active { cursor: grabbing; }
.model-entry-drag-handle:focus-visible { box-shadow: 0 0 0 2px var(--focus-ring); outline: none; }
.model-entry-row-dragging { opacity: 0; }
@media(max-width:560px) {
  .model-entry-columns { display: none; }
  .model-entry-field-label { display: block; }
  .model-entry-row { grid-template-columns: 32px minmax(0,1fr) auto; }
  .model-entry-drag-handle { grid-column: 1; grid-row: 1 / span 2; }
  .model-entry-field { grid-column: 2; }
  .model-entry-field:first-of-type { grid-row: 1; }
  .model-entry-field:last-of-type { grid-row: 2; }
  .model-entry-delete { grid-column: 3; grid-row: 1; }
}
@media(prefers-reduced-motion:reduce) { .model-entry-row, .model-entry-row-move { transition: none; } }
</style>
