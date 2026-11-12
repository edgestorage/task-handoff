<template>
  <Teleport to="body">
    <aside
      v-if="present && !preference.collapsed"
      class="session-remote-desktop-preview"
      :class="[presenceClass, { 'is-interacting': dragging || resizing }]"
      :style="frameStyle"
      :aria-label="t('instances.remoteDesktop.preview')"
      @pointermove="moveDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
    >
      <div class="session-remote-desktop-preview-resize is-left" @pointerdown.stop.prevent="startResize('left', $event)" />
      <div class="session-remote-desktop-preview-resize is-right" @pointerdown.stop.prevent="startResize('right', $event)" />
      <div class="session-remote-desktop-preview-media" @click="openDetails">
        <InstanceRemoteDesktopViewer
          :capabilities="capabilities"
          :initial-target="target"
          :instance-id="instanceId"
          auto-connect
          preview
          @selection-change="$emit('selectionChange', $event)"
          @stream-size="setStreamSize"
        />
        <span class="session-remote-desktop-preview-badge">
          <MousePointerClick :size="12" aria-hidden="true" />
          {{ t("instances.remoteDesktop.previewHint") }}
        </span>
        <button type="button" class="session-remote-desktop-preview-close" :title="t('common.actions.close')" :aria-label="t('common.actions.close')" @pointerdown.stop @click.stop="$emit('close')">
          <X :size="16" />
        </button>
      </div>
      <footer class="session-remote-desktop-preview-foot" @pointerdown="startDrag($event)">
        <span class="session-remote-desktop-preview-copy">
          <Monitor :size="15" aria-hidden="true" />
          <span>
            <strong>{{ target.title || t("instances.remoteDesktop.title") }}</strong>
            <small>{{ target.subtitle || t("instances.remoteDesktop.lastOpened") }}</small>
          </span>
        </span>
        <button type="button" :title="t('instances.remoteDesktop.collapsePreview')" :aria-label="t('instances.remoteDesktop.collapsePreview')" @pointerdown.stop @click.stop="collapse">
          <ChevronDown :size="15" />
        </button>
        <button type="button" :title="t('instances.remoteDesktop.openDetails')" :aria-label="t('instances.remoteDesktop.openDetails')" @pointerdown.stop @click.stop="openDetails">
          <ExternalLink :size="15" />
        </button>
      </footer>
    </aside>
    <button
      v-else-if="present"
      type="button"
      class="session-remote-desktop-preview-pill"
      :class="[presenceClass, { 'is-interacting': dragging }]"
      :style="frameStyle"
      :title="t('instances.remoteDesktop.expandPreview')"
      @pointerdown="startDrag($event)"
      @pointermove="moveDrag"
      @pointerup="endDrag"
      @pointercancel="endDrag"
      @click="expandFromPill"
    >
      <Monitor :size="15" aria-hidden="true" />
      <span>{{ target.title || t("instances.remoteDesktop.title") }}</span>
      <ChevronUp :size="15" aria-hidden="true" />
    </button>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronUp, ExternalLink, Monitor, MousePointerClick, X } from "@lucide/vue";
import InstanceRemoteDesktopViewer from "../../apps/control-plane/instance-detail/InstanceRemoteDesktopViewer.vue";
import {
  clampSessionRemoteDesktopPreviewFrame,
  DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE,
  resizeSessionRemoteDesktopPreviewFrame,
  sessionRemoteDesktopPreviewAspectRatio,
  sessionRemoteDesktopPreviewLayout,
  sessionRemoteDesktopPreviewPreferenceForFrame,
  SESSION_REMOTE_DESKTOP_PREVIEW_COLLAPSED_HEIGHT,
  SESSION_REMOTE_DESKTOP_PREVIEW_COLLAPSED_WIDTH,
  SESSION_REMOTE_DESKTOP_PREVIEW_FOOTER_HEIGHT,
  SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN,
  SESSION_REMOTE_DESKTOP_PREVIEW_TOP_MARGIN,
  type SessionRemoteDesktopPreviewFrame,
  type SessionRemoteDesktopPreviewPreference,
  type SessionRemoteDesktopPreviewViewport,
} from "../../apps/control-plane/instance-detail/remoteDesktopFloatingPreview.ts";
import type { SessionRemoteDesktopTarget } from "../../apps/control-plane/instance-detail/sessionRemoteDesktopLinks.ts";

const props = defineProps<{
  capabilities?: Record<string, unknown>;
  instanceId: string;
  sessionId: string;
  target: SessionRemoteDesktopTarget;
  visible: boolean;
}>();

const emit = defineEmits<{
  close: [];
  openDetails: [];
  selectionChange: [target: SessionRemoteDesktopTarget];
}>();

const { t } = useI18n();
const viewport = ref<SessionRemoteDesktopPreviewViewport>(currentViewport());
const preference = ref(loadPreference(props.instanceId, props.sessionId));
const streamSize = ref({ width: props.target.width, height: props.target.height });
const mediaAspectRatio = computed(() => sessionRemoteDesktopPreviewAspectRatio(streamSize.value.width, streamSize.value.height));
const frame = ref(sessionRemoteDesktopPreviewLayout(viewport.value, preference.value, mediaAspectRatio.value));
const dragging = ref(false);
const resizing = ref(false);
const suppressClick = ref(false);
type PresencePhase = "hidden" | "entering" | "visible" | "exiting";
const present = ref(props.visible);
const presencePhase = ref<PresencePhase>(props.visible ? "entering" : "hidden");
const presenceClass = computed(() => presencePhase.value === "entering"
  ? "is-presence-entering"
  : presencePhase.value === "exiting" ? "is-presence-exiting" : "");
let dragStart: { x: number; y: number; frame: SessionRemoteDesktopPreviewFrame } | undefined;
let resizeStart: { x: number; edge: "left" | "right"; frame: SessionRemoteDesktopPreviewFrame } | undefined;
let clickSuppressedUntil = 0;
let dragMoved = false;
let enterFrame: number | undefined;
let exitTimer: number | undefined;

const PRESENCE_EXIT_DURATION_MS = 140;

const frameStyle = computed<CSSProperties>(() => ({
  left: `${frame.value.x}px`,
  top: `${frame.value.y}px`,
  width: `${frame.value.width}px`,
  height: `${frame.value.height}px`,
}));

watch([viewport, preference, mediaAspectRatio], () => {
  if (dragging.value || resizing.value) return;
  frame.value = sessionRemoteDesktopPreviewLayout(viewport.value, preference.value, mediaAspectRatio.value);
}, { deep: true });

watch(() => props.target, target => {
  streamSize.value = { width: target.width, height: target.height };
}, { deep: true });

function currentViewport(): SessionRemoteDesktopPreviewViewport {
  if (typeof window === "undefined") return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function updateViewport() {
  viewport.value = currentViewport();
}

function startDrag(event: PointerEvent) {
  if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
  event.preventDefault();
  dragStart = { x: event.clientX, y: event.clientY, frame: { ...frame.value } };
  dragMoved = false;
  dragging.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function moveDrag(event: PointerEvent) {
  if (!dragStart || !dragging.value) return;
  if (resizing.value) return;
  if (Math.abs(event.clientX - dragStart.x) > 3 || Math.abs(event.clientY - dragStart.y) > 3) dragMoved = true;
  const x = dragStart.frame.x + event.clientX - dragStart.x;
  const y = dragStart.frame.y + event.clientY - dragStart.y;
  frame.value = clampSessionRemoteDesktopPreviewFrame({ ...dragStart.frame, x, y }, viewport.value);
}

function endDrag(event?: PointerEvent) {
  if (resizing.value) {
    endResize(event);
    return;
  }
  if (!dragging.value) return;
  dragging.value = false;
  dragStart = undefined;
  preference.value = sessionRemoteDesktopPreviewPreferenceForFrame({
    collapsed: preference.value.collapsed,
    expandedWidth: preference.value.collapsed ? preference.value.width : frame.value.width,
    frame: frame.value,
    viewport: viewport.value,
  });
  savePreference(props.instanceId, props.sessionId, preference.value);
  if (dragMoved) {
    clickSuppressedUntil = Date.now() + 120;
    suppressClick.value = true;
    window.setTimeout(() => { suppressClick.value = false; }, 120);
  }
  dragMoved = false;
}

function startResize(edge: "left" | "right", event: PointerEvent) {
  if (preference.value.collapsed) return;
  event.preventDefault();
  resizeStart = { x: event.clientX, edge, frame: { ...frame.value } };
  resizing.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function moveResize(event: PointerEvent) {
  if (!resizeStart || !resizing.value) return;
  frame.value = resizeSessionRemoteDesktopPreviewFrame({
    dx: event.clientX - resizeStart.x,
    edge: resizeStart.edge,
    frame: resizeStart.frame,
    mediaAspectRatio: mediaAspectRatio.value,
    viewport: viewport.value,
  });
}

function endResize(event?: PointerEvent) {
  if (!resizing.value) return;
  if (event?.currentTarget && "releasePointerCapture" in event.currentTarget) {
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
  }
  resizing.value = false;
  resizeStart = undefined;
  preference.value = sessionRemoteDesktopPreviewPreferenceForFrame({
    collapsed: false,
    expandedWidth: frame.value.width,
    frame: frame.value,
    viewport: viewport.value,
  });
  savePreference(props.instanceId, props.sessionId, preference.value);
}

function setStreamSize(size: { width: number; height: number }) {
  if (size.width <= 0 || size.height <= 0) return;
  streamSize.value = size;
}

function openDetails() {
  if (Date.now() < clickSuppressedUntil) return;
  emit("openDetails");
}

function collapse() {
  preference.value = sessionRemoteDesktopPreviewPreferenceForFrame({
    collapsed: true,
    expandedWidth: frame.value.width,
    frame: frame.value,
    viewport: viewport.value,
  });
  frame.value = sessionRemoteDesktopPreviewLayout(viewport.value, preference.value, mediaAspectRatio.value);
  savePreference(props.instanceId, props.sessionId, preference.value);
}

function expandFromPill() {
  if (suppressClick.value || Date.now() < clickSuppressedUntil) return;
  preference.value = { ...preference.value, collapsed: false };
  frame.value = sessionRemoteDesktopPreviewLayout(viewport.value, preference.value, mediaAspectRatio.value);
  savePreference(props.instanceId, props.sessionId, preference.value);
}

function clearPresenceTimers() {
  if (enterFrame !== undefined) {
    window.cancelAnimationFrame(enterFrame);
    enterFrame = undefined;
  }
  if (exitTimer !== undefined) {
    window.clearTimeout(exitTimer);
    exitTimer = undefined;
  }
}

function enterPresence() {
  clearPresenceTimers();
  present.value = true;
  presencePhase.value = "entering";
  void nextTick(() => {
    if (!props.visible || !present.value) return;
    enterFrame = window.requestAnimationFrame(() => {
      enterFrame = undefined;
      if (props.visible && present.value) presencePhase.value = "visible";
    });
  });
}

function exitPresence() {
  clearPresenceTimers();
  presencePhase.value = "exiting";
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  exitTimer = window.setTimeout(() => {
    exitTimer = undefined;
    if (props.visible) return;
    present.value = false;
    presencePhase.value = "hidden";
  }, reduceMotion ? 0 : PRESENCE_EXIT_DURATION_MS);
}

watch(() => props.visible, visible => {
  if (visible) enterPresence();
  else if (present.value) exitPresence();
});

onMounted(() => {
  if (props.visible) enterPresence();
  window.addEventListener("resize", updateViewport);
  window.addEventListener("pointermove", moveResize);
  window.addEventListener("pointerup", endResize);
  window.addEventListener("pointercancel", endResize);
});

onBeforeUnmount(() => {
  clearPresenceTimers();
  window.removeEventListener("resize", updateViewport);
  window.removeEventListener("pointermove", moveResize);
  window.removeEventListener("pointerup", endResize);
  window.removeEventListener("pointercancel", endResize);
});

function loadPreference(instanceId: string, sessionId: string): SessionRemoteDesktopPreviewPreference {
  if (typeof window === "undefined") return { ...DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE };
  try {
    const value = JSON.parse(window.localStorage?.getItem(preferenceKey(instanceId, sessionId)) || "null") as Partial<SessionRemoteDesktopPreviewPreference> | null;
    return {
      collapsed: value?.collapsed === true,
      width: Number.isFinite(value?.width) ? Number(value?.width) : DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE.width,
      xRatio: Number.isFinite(value?.xRatio) ? Number(value?.xRatio) : 1,
      yRatio: Number.isFinite(value?.yRatio) ? Number(value?.yRatio) : 1,
    };
  } catch {
    return { ...DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE };
  }
}

function savePreference(instanceId: string, sessionId: string, value: SessionRemoteDesktopPreviewPreference) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(preferenceKey(instanceId, sessionId), JSON.stringify(value));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

function preferenceKey(instanceId: string, sessionId: string) {
  return `task-handoff.control-plane.remote-desktop-session-preview:${JSON.stringify([instanceId, sessionId])}`;
}
</script>

<style scoped>
.session-remote-desktop-preview,
.session-remote-desktop-preview-pill {
  position: fixed;
  z-index: 90;
  box-sizing: border-box;
  transform: translateY(0) scale(1);
  transform-origin: center;
  transition:
    left 180ms ease,
    top 180ms ease,
    width 180ms ease,
    height 180ms ease,
    box-shadow 180ms ease,
    opacity 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
    transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
  user-select: none;
  will-change: opacity, transform;
}

.session-remote-desktop-preview.is-interacting,
.session-remote-desktop-preview-pill.is-interacting {
  transition: none;
}

.session-remote-desktop-preview.is-presence-entering,
.session-remote-desktop-preview-pill.is-presence-entering {
  opacity: 0;
  pointer-events: none;
  transform: translateY(8px) scale(0.96);
}

.session-remote-desktop-preview.is-presence-exiting,
.session-remote-desktop-preview-pill.is-presence-exiting {
  opacity: 0;
  pointer-events: none;
  transform: translateY(8px) scale(0.96);
  transition-duration: 140ms;
}

.session-remote-desktop-preview {
  display: flex;
  overflow: hidden;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface-raised);
  box-shadow: 0 18px 52px rgb(0 0 0 / 24%);
}

.session-remote-desktop-preview-media {
  position: relative;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
  background: #050506;
  cursor: pointer;
}

.session-remote-desktop-preview-media :deep(.remote-desktop-viewer) {
  width: 100%;
  height: 100%;
  margin: 0;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  pointer-events: none;
}

.session-remote-desktop-preview-badge {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 7px;
  border-radius: 999px;
  background: rgb(0 0 0 / 62%);
  color: rgb(255 255 255 / 86%);
  font-size: 11px;
  font-weight: 500;
  pointer-events: none;
}

.session-remote-desktop-preview-close {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  width: 28px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border: 1px solid rgb(255 255 255 / 18%);
  border-radius: 999px;
  background: rgb(0 0 0 / 58%);
  color: white;
}

.session-remote-desktop-preview-close:hover,
.session-remote-desktop-preview-close:focus-visible {
  background: rgb(0 0 0 / 76%);
}

.session-remote-desktop-preview-foot {
  display: flex;
  min-height: 54px;
  flex: 0 0 54px;
  align-items: center;
  gap: 5px;
  padding: 7px 8px 7px 12px;
  border-top: 1px solid var(--line-subtle);
  background: var(--surface-raised);
  cursor: grab;
}

.session-remote-desktop-preview-copy {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 9px;
  color: var(--text-muted);
}

.session-remote-desktop-preview-copy > span {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 1px;
}

.session-remote-desktop-preview-copy strong,
.session-remote-desktop-preview-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-remote-desktop-preview-copy strong {
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 500;
  line-height: 16px;
}

.session-remote-desktop-preview-copy small {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 400;
  line-height: 14px;
}

.session-remote-desktop-preview-foot button {
  display: inline-flex;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
}

.session-remote-desktop-preview-foot button:hover,
.session-remote-desktop-preview-foot button:focus-visible {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.session-remote-desktop-preview-resize {
  position: absolute;
  z-index: 3;
  top: 0;
  bottom: 54px;
  width: 9px;
  cursor: ew-resize;
}

.session-remote-desktop-preview-resize.is-left {
  left: 0;
}

.session-remote-desktop-preview-resize.is-right {
  right: 0;
}

.session-remote-desktop-preview-resize:hover {
  background: color-mix(in srgb, var(--brand-accent) 24%, transparent);
}

.session-remote-desktop-preview-pill {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface-raised);
  box-shadow: 0 12px 34px rgb(0 0 0 / 20%);
  color: var(--text);
  cursor: grab;
}

.session-remote-desktop-preview-pill span {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-remote-desktop-preview-pill:hover,
.session-remote-desktop-preview-pill:focus-visible {
  border-color: var(--line-strong);
  background: var(--surface-hover);
}

@media (prefers-reduced-motion: reduce) {
  .session-remote-desktop-preview,
  .session-remote-desktop-preview-pill {
    transition: none;
  }
}
</style>
