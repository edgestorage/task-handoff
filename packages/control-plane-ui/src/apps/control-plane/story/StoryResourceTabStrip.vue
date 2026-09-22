<template>
  <ResourceTabStrip :items="items" :active-key="activeKey" @select="$emit('select', $event)" v-slot="{ onKeydown }">
  <ResourceTabViewport ref="viewport" :active-key="activeKey" :item-count="items.length">
  <TransitionGroup name="session-tab-reorder" tag="div" class="session-tab-strip-content" role="tablist" :aria-label="t('stories.resources.tabs')" @keydown="onKeydown">
    <span
      v-for="item in visibleItems"
      :key="item.key"
      class="story-resource-tab-shell session-tab-sortable-shell"
    >
      <ResourceTabItem
        :label="item.label"
        :active="item.key === activeKey"
        :drag-placeholder="draggingKey === item.key"
        :disabled="item.closing"
        :closing="item.closing"
        :close-label="item.closeLabel"
        :close-title="item.closeLabel"
        :data-resource-tab-key="item.key"
        :tabindex="item.key === activeKey ? 0 : -1"
        :title="item.description"
        @select="handleSelect($event, item.key)"
        @close="$emit('close', item.key)"
        @pointerdown="startPointer($event, item)"
      >
        <template #icon>
          <Terminal v-if="item.kind === 'terminal'" :size="14" class="session-tab-icon" />
          <Globe2 v-else-if="item.kind === 'embedded-browser'" :size="14" class="session-tab-icon" />
          <AppWindow v-else-if="item.kind === 'app'" :size="14" class="session-tab-icon" />
          <FolderTree v-else-if="item.kind === 'files'" :size="14" class="session-tab-icon" />
          <FileDiff v-else-if="item.kind === 'changes-review'" :size="14" class="session-tab-icon" />
          <GitBranch v-else :size="14" class="session-tab-icon" />
        </template>
      </ResourceTabItem>
    </span>
  </TransitionGroup>
  </ResourceTabViewport>
  </ResourceTabStrip>
  <Teleport to="body">
    <div v-if="pointerDrag" class="session-tab-pointer-overlay" :style="pointerOverlayStyle" aria-hidden="true">
      <component :is="dragIcon" :size="14" class="session-tab-icon" />
      <strong>{{ pointerDrag.item.label }}</strong>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { AppWindow, FileDiff, FolderTree, GitBranch, Globe2, Terminal } from "@lucide/vue";
import ResourceTabItem from "../shared/ResourceTabItem.vue";
import ResourceTabStrip from "../shared/ResourceTabStrip.vue";
import ResourceTabViewport from "../shared/ResourceTabViewport.vue";
import { reorderStoryResourceKeys, storyResourceDropTargetAt, type StoryResourceDropPlacement, type StoryResourceDropTarget } from "./storyResourceOrder.ts";

export type StoryResourceTabItem = {
  key: string;
  label: string;
  instanceLabel: string;
  description: string;
  closeLabel: string;
  kind: "terminal" | "app" | "embedded-browser" | "files" | "changes-review" | "worktrees";
  status?: string;
  closing?: boolean;
};

const props = defineProps<{ items: StoryResourceTabItem[]; activeKey: string }>();
const emit = defineEmits<{ select: [key: string]; close: [key: string]; reorder: [sourceKey: string, targetKey: string, placement: StoryResourceDropPlacement] }>();
const { t } = useI18n();
const viewport = ref<InstanceType<typeof ResourceTabViewport>>();
const draggingKey = ref("");
const dropTarget = ref<StoryResourceDropTarget>();
const suppressClickUntil = ref(0);
const pointerDrag = ref<{ item: StoryResourceTabItem; x: number; y: number; width: number; height: number }>();
let pending: { pointerId: number; item: StoryResourceTabItem; tab: HTMLElement; startX: number; startY: number; offsetX: number; offsetY: number; width: number; height: number } | undefined;
let moved = false;

function startPointer(event: PointerEvent, item: StoryResourceTabItem) {
  if (event.button !== 0 || item.closing) return;
  const target = event.target instanceof Element ? event.target : undefined;
  if (target?.closest("button, input")) return;
  const tab = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  if (!tab) return;
  cancelPointer();
  const bounds = tab.getBoundingClientRect();
  pending = { pointerId: event.pointerId, item, tab, startX: event.clientX, startY: event.clientY, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top, width: bounds.width, height: bounds.height };
  window.addEventListener("pointermove", movePointer, true);
  window.addEventListener("pointerup", finishPointer, true);
  window.addEventListener("pointercancel", cancelPointer, true);
  window.addEventListener("keydown", cancelEscape, true);
}
function movePointer(event: PointerEvent) {
  if (!pending || event.pointerId !== pending.pointerId) return;
  if (!draggingKey.value && Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) < 5) return;
  event.preventDefault();
  if (!draggingKey.value) {
    draggingKey.value = pending.item.key;
    try { pending.tab.setPointerCapture?.(pending.pointerId); } catch { /* Window listeners remain authoritative. */ }
    document.body.classList.add("session-tab-pointer-dragging");
  }
  pointerDrag.value = { item: pending.item, x: event.clientX - pending.offsetX, y: event.clientY - pending.offsetY, width: pending.width, height: pending.height };
  moved = true;
  const scope = pending?.tab.closest<HTMLElement>(".story-resource-sidebar") || document.body;
  const tabs = [...scope.querySelectorAll<HTMLElement>("[data-resource-tab-key]")].filter((tab) => tab.dataset.resourceTabKey !== draggingKey.value);
  dropTarget.value = storyResourceDropTargetAt(tabs.flatMap((tab) => {
    const key = tab.dataset.resourceTabKey;
    if (!key) return [];
    const bounds = tab.getBoundingClientRect();
    return [{ key, midpoint: bounds.left + bounds.width / 2 }];
  }), event.clientX);
  viewport.value?.scrollAtPointer(event.clientX);
}
function finishPointer(event: PointerEvent) {
  if (!pending || event.pointerId !== pending.pointerId) return;
  if (draggingKey.value && moved && dropTarget.value) emit("reorder", draggingKey.value, dropTarget.value.key, dropTarget.value.placement);
  cleanupPointer(Boolean(draggingKey.value));
}
function cancelEscape(event: KeyboardEvent) { if (event.key === "Escape") { event.preventDefault(); cancelPointer(); } }
function cancelPointer() { cleanupPointer(Boolean(draggingKey.value)); }
function cleanupPointer(suppressClick: boolean) {
  const current = pending;
  window.removeEventListener("pointermove", movePointer, true);
  window.removeEventListener("pointerup", finishPointer, true);
  window.removeEventListener("pointercancel", cancelPointer, true);
  window.removeEventListener("keydown", cancelEscape, true);
  if (current?.tab.hasPointerCapture?.(current.pointerId)) current.tab.releasePointerCapture(current.pointerId);
  pending = undefined;
  pointerDrag.value = undefined;
  draggingKey.value = "";
  dropTarget.value = undefined;
  moved = false;
  document.body.classList.remove("session-tab-pointer-dragging");
  if (suppressClick) suppressClickUntil.value = Date.now() + 250;
}
function handleSelect(event: MouseEvent | KeyboardEvent, key: string) {
  if (Date.now() < suppressClickUntil.value) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  emit("select", key);
}
const visibleItems = computed(() => {
  if (!draggingKey.value || !dropTarget.value) return props.items;
  const byKey = new Map(props.items.map((item) => [item.key, item]));
  return reorderStoryResourceKeys([...byKey.keys()], draggingKey.value, dropTarget.value.key, dropTarget.value.placement)
    .map((key) => byKey.get(key)!);
});
const pointerOverlayStyle = computed(() => pointerDrag.value ? {
  width: `${pointerDrag.value.width}px`,
  height: `${pointerDrag.value.height}px`,
  transform: `translate3d(${pointerDrag.value.x}px, ${pointerDrag.value.y}px, 0)`,
} : undefined);
const dragIcon = computed(() => {
  const kind = pointerDrag.value?.item.kind;
  if (kind === "terminal") return Terminal;
  if (kind === "embedded-browser") return Globe2;
  if (kind === "app") return AppWindow;
  if (kind === "files") return FolderTree;
  if (kind === "changes-review") return FileDiff;
  return GitBranch;
});
onBeforeUnmount(cancelPointer);
</script>
