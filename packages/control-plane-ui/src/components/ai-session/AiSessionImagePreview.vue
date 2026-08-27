<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Copy, Minus, Plus, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu";

const props = defineProps<{
  open: boolean;
  src?: string;
  alt?: string;
  copyable?: boolean;
}>();

const emit = defineEmits<{
  (event: "update:open", value: boolean): void;
  (event: "copy"): void;
}>();

const { t } = useI18n();
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.25;
const MIN_VISIBLE_RATIO = 0.2;
const contentStyle = {
  position: "fixed",
  inset: "0",
  left: "0",
  top: "0",
  width: "100vw",
  maxWidth: "none",
  height: "100dvh",
  transform: "none",
  overflow: "hidden",
  border: "0",
  borderRadius: "0",
  background: "transparent",
  boxShadow: "none",
  padding: "0",
  animation: "none",
  transition: "none",
} as const;
const zoom = ref(1);
const naturalWidth = ref(0);
const naturalHeight = ref(0);
const viewportWidth = ref(0);
const viewportHeight = ref(0);
const panX = ref(0);
const panY = ref(0);
const dragging = ref(false);
let dragPointerId: number | undefined;
let dragStartX = 0;
let dragStartY = 0;
let dragStartPanX = 0;
let dragStartPanY = 0;
let dragMoved = false;
let ignoreStageClick = false;

const fittedSize = computed(() => {
  if (!naturalWidth.value || !naturalHeight.value || !viewportWidth.value || !viewportHeight.value) return undefined;
  const fit = Math.min(
    1,
    viewportWidth.value * 0.92 / naturalWidth.value,
    viewportHeight.value * 0.86 / naturalHeight.value,
  );
  return {
    width: naturalWidth.value * fit,
    height: naturalHeight.value * fit,
  };
});

const displayedSize = computed(() => fittedSize.value
  ? { width: fittedSize.value.width * zoom.value, height: fittedSize.value.height * zoom.value }
  : undefined);

const imageStyle = computed(() => displayedSize.value ? {
  width: `${displayedSize.value.width}px`,
  height: `${displayedSize.value.height}px`,
  left: `${viewportWidth.value / 2 + panX.value}px`,
  top: `${viewportHeight.value / 2 + panY.value}px`,
} : undefined);

watch(() => [props.open, props.src] as const, () => {
  resetView();
  void nextTick(updateViewport);
});

onMounted(() => {
  updateViewport();
  window.addEventListener("resize", handleResize);
});

onBeforeUnmount(() => window.removeEventListener("resize", handleResize));

function updateViewport() {
  if (typeof window === "undefined") return;
  viewportWidth.value = window.innerWidth;
  viewportHeight.value = window.innerHeight;
}

function handleResize() {
  updateViewport();
  clampPan();
}

function resetView() {
  zoom.value = 1;
  panX.value = 0;
  panY.value = 0;
  naturalWidth.value = 0;
  naturalHeight.value = 0;
  dragging.value = false;
  dragPointerId = undefined;
}

function close() {
  emit("update:open", false);
}

function panBounds() {
  const size = displayedSize.value;
  if (!size) return undefined;
  const visibleWidth = size.width * MIN_VISIBLE_RATIO;
  const visibleHeight = size.height * MIN_VISIBLE_RATIO;
  return {
    minX: visibleWidth - size.width / 2 - viewportWidth.value / 2,
    maxX: viewportWidth.value / 2 - visibleWidth + size.width / 2,
    minY: visibleHeight - size.height / 2 - viewportHeight.value / 2,
    maxY: viewportHeight.value / 2 - visibleHeight + size.height / 2,
  };
}

function clampPan(nextX = panX.value, nextY = panY.value) {
  const bounds = panBounds();
  if (!bounds) return;
  panX.value = Math.min(bounds.maxX, Math.max(bounds.minX, nextX));
  panY.value = Math.min(bounds.maxY, Math.max(bounds.minY, nextY));
}

function changeZoom(delta: number, anchorX = viewportWidth.value / 2, anchorY = viewportHeight.value / 2) {
  const previousZoom = zoom.value;
  const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, previousZoom + delta));
  if (nextZoom === previousZoom) return;

  const ratio = nextZoom / previousZoom;
  const previousCenterX = viewportWidth.value / 2 + panX.value;
  const previousCenterY = viewportHeight.value / 2 + panY.value;
  const nextCenterX = anchorX - (anchorX - previousCenterX) * ratio;
  const nextCenterY = anchorY - (anchorY - previousCenterY) * ratio;
  zoom.value = nextZoom;
  clampPan(nextCenterX - viewportWidth.value / 2, nextCenterY - viewportHeight.value / 2);
}

function handleImageLoad(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  naturalWidth.value = image.naturalWidth;
  naturalHeight.value = image.naturalHeight;
  panX.value = 0;
  panY.value = 0;
}

function handlePointerDown(event: PointerEvent) {
  if (event.button !== 0 || !(event.target instanceof HTMLImageElement)) return;
  event.preventDefault();
  dragging.value = true;
  dragMoved = false;
  dragPointerId = event.pointerId;
  dragStartX = event.clientX;
  dragStartY = event.clientY;
  dragStartPanX = panX.value;
  dragStartPanY = panY.value;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function handlePointerMove(event: PointerEvent) {
  if (!dragging.value || event.pointerId !== dragPointerId) return;
  const deltaX = event.clientX - dragStartX;
  const deltaY = event.clientY - dragStartY;
  if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) dragMoved = true;
  clampPan(dragStartPanX + deltaX, dragStartPanY + deltaY);
}

function handlePointerUp(event: PointerEvent) {
  if (event.pointerId !== dragPointerId) return;
  (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  dragging.value = false;
  dragPointerId = undefined;
  if (dragMoved) {
    ignoreStageClick = true;
    window.setTimeout(() => { ignoreStageClick = false; }, 0);
  }
}

function handleStageClick(event: MouseEvent) {
  if (ignoreStageClick) {
    ignoreStageClick = false;
    return;
  }
  close();
}

function handleWheel(event: WheelEvent) {
  event.preventDefault();
  changeZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP, event.clientX, event.clientY);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    changeZoom(ZOOM_STEP);
  } else if (event.key === "-") {
    event.preventDefault();
    changeZoom(-ZOOM_STEP);
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="ai-session-image-preview" :style="contentStyle" @keydown="handleKeydown">
      <DialogTitle class="sr-only">{{ alt }}</DialogTitle>
      <div class="ai-session-image-preview__toolbar">
        <Button type="button" variant="ghost" size="icon-sm" :title="t('sessions.composer.zoomOut')" :aria-label="t('sessions.composer.zoomOut')" :disabled="zoom <= MIN_ZOOM" @click="changeZoom(-ZOOM_STEP)">
          <Minus :size="18" />
        </Button>
        <span aria-live="polite">{{ Math.round(zoom * 100) }}%</span>
        <Button type="button" variant="ghost" size="icon-sm" :title="t('sessions.composer.zoomIn')" :aria-label="t('sessions.composer.zoomIn')" :disabled="zoom >= MAX_ZOOM" @click="changeZoom(ZOOM_STEP)">
          <Plus :size="18" />
        </Button>
        <i aria-hidden="true" />
        <Button type="button" variant="ghost" size="icon-sm" :title="t('common.actions.close')" :aria-label="t('common.actions.close')" @click="close">
          <X :size="19" />
        </Button>
      </div>

      <div
        class="ai-session-image-preview__stage"
        :class="{ 'is-dragging': dragging }"
        @click="handleStageClick"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="handlePointerUp"
        @wheel="handleWheel"
      >
        <ContextMenu v-if="src">
          <ContextMenuTrigger as-child>
            <img :src="src" :alt="alt" :style="imageStyle" draggable="false" @load="handleImageLoad" @dragstart.prevent />
          </ContextMenuTrigger>
          <ContextMenuContent v-if="copyable">
            <ContextMenuItem @select="emit('copy')">
              <Copy :size="15" />
              <span>{{ t("sessions.composer.copyImage") }}</span>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
:global(.ai-session-image-preview) {
  position: fixed;
  inset: 0;
  left: 0;
  top: 0;
  display: block;
  width: 100vw;
  max-width: none;
  height: 100dvh;
  overflow: hidden;
  transform: none;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  padding: 0;
}

.ai-session-image-preview__stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
  touch-action: none;
  user-select: none;
}

.ai-session-image-preview__stage img {
  position: absolute;
  display: block;
  max-width: none;
  max-height: none;
  transform: translate(-50%, -50%);
  object-fit: contain;
  cursor: grab;
  will-change: left, top, width, height;
}

.ai-session-image-preview__stage.is-dragging img { cursor: grabbing; }

.ai-session-image-preview__toolbar {
  position: fixed;
  top: 18px;
  right: 18px;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 38px;
  border: 1px solid rgb(255 255 255 / 18%);
  border-radius: 10px;
  background: rgb(18 18 20 / 82%);
  color: white;
  box-shadow: 0 8px 28px rgb(0 0 0 / 28%);
  backdrop-filter: blur(10px);
  padding: 4px;
}

.ai-session-image-preview__toolbar button {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0;
}

.ai-session-image-preview__toolbar button:hover:not(:disabled) { background: rgb(255 255 255 / 12%); }
.ai-session-image-preview__toolbar button:disabled { cursor: default; opacity: .4; }
.ai-session-image-preview__toolbar span { min-width: 46px; font-size: 12px; font-variant-numeric: tabular-nums; text-align: center; }
.ai-session-image-preview__toolbar i { width: 1px; height: 20px; background: rgb(255 255 255 / 18%); }

@media (max-width: 620px) {
  .ai-session-image-preview__toolbar { top: 12px; right: 12px; }
}
</style>
