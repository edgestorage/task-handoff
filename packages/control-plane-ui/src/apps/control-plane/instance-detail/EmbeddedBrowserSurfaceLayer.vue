<template>
  <div ref="host" class="embedded-browser-surface-layer" aria-hidden="false">
    <div
      v-for="(tabs, instanceId) in browserSessionTabs"
      :key="instanceId"
      class="embedded-browser-instance-layer"
    >
      <div
        v-for="tab in tabs.filter((item) => item.kind === 'embedded-browser')"
        :key="tab.key"
        class="embedded-browser-layer-item"
        :style="itemStyle(instanceId, tab.key)"
        :data-instance-id="instanceId"
        :data-session-key="tab.key"
      >
        <EmbeddedBrowserTab
          :instance-id="instanceId"
          :session-key="tab.key"
          :background-throttled="!isActiveTab(instanceId, tab.key)"
          :initial-url="typeof tab.source?.currentUrl === 'string' ? tab.source.currentUrl : typeof tab.source?.initialUrl === 'string' ? tab.source.initialUrl : undefined"
          @update-tab="(patch) => $emit('updateBrowserTab', instanceId, tab.key, patch)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type CSSProperties } from "vue";
import type { SessionTab } from "../useInstanceSessions";
import EmbeddedBrowserTab from "./EmbeddedBrowserTab.vue";
import type { SessionPaneId } from "./useActiveInstanceSessions";

type SurfaceState = {
  leftSessionKey: string;
  rightSessionKey: string;
};

const props = defineProps<{
  activeInstanceId?: string;
  browserSessionTabs: Record<string, SessionTab[]>;
  browserSurfaceState: Record<string, SurfaceState>;
}>();

defineEmits<{
  updateBrowserTab: [instanceId: string, sessionKey: string, patch: { title?: string; url?: string; status?: string }];
}>();

const host = ref<HTMLElement>();
const layoutRects = shallowRef(new Map<string, DOMRect>());
const layoutVersion = ref(0);
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;
let layoutFrame: number | undefined;

function scheduleLayout() {
  if (layoutFrame !== undefined) return;
  layoutFrame = window.requestAnimationFrame(() => {
    layoutFrame = undefined;
    updateLayout();
  });
}

function updateLayout() {
  const hostElement = host.value;
  if (!hostElement) return;
  const hostRect = hostElement.getBoundingClientRect();
  const next = new Map<string, DOMRect>();
  const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-browser-surface]"));
  for (const target of targets) {
    const instanceId = target.dataset.instanceId;
    const pane = target.dataset.pane as SessionPaneId | undefined;
    if (!instanceId || !pane) continue;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    next.set(`${instanceId}:${pane}`, new DOMRect(
      rect.left - hostRect.left,
      rect.top - hostRect.top,
      rect.width,
      rect.height,
    ));
  }
  layoutRects.value = next;
  layoutVersion.value += 1;
  resizeObserver?.disconnect();
  for (const target of targets) resizeObserver?.observe(target);
}

function itemStyle(instanceId: string, sessionKey: string): CSSProperties {
  // Read the revision so Vue re-evaluates styles when pane geometry changes.
  void layoutVersion.value;
  const state = props.browserSurfaceState[instanceId];
  const pane = state?.rightSessionKey === sessionKey
    ? "right"
    : state?.leftSessionKey === sessionKey ? "left" : undefined;
  const rect = pane ? layoutRects.value.get(`${instanceId}:${pane}`) : undefined;
  const visible = instanceId === props.activeInstanceId && Boolean(rect);
  return {
    left: `${rect?.x || 0}px`,
    top: `${rect?.y || 0}px`,
    width: `${rect?.width || 0}px`,
    height: `${rect?.height || 0}px`,
    visibility: visible ? "visible" : "hidden",
    pointerEvents: visible ? "auto" : "none",
  };
}

function isActiveTab(instanceId: string, sessionKey: string) {
  if (instanceId !== props.activeInstanceId) return false;
  const state = props.browserSurfaceState[instanceId];
  return state?.leftSessionKey === sessionKey || state?.rightSessionKey === sessionKey;
}

onMounted(() => {
  resizeObserver = new ResizeObserver(scheduleLayout);
  mutationObserver = new MutationObserver(scheduleLayout);
  mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-pane", "data-instance-id"] });
  window.addEventListener("resize", scheduleLayout);
  void nextTick(scheduleLayout);
});

watch(
  [() => props.activeInstanceId, () => JSON.stringify(props.browserSurfaceState)],
  () => void nextTick(scheduleLayout),
  { flush: "post" },
);

onBeforeUnmount(() => {
  if (layoutFrame !== undefined) window.cancelAnimationFrame(layoutFrame);
  window.removeEventListener("resize", scheduleLayout);
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
});
</script>

<style scoped>
.embedded-browser-surface-layer {
  position: absolute;
  z-index: 8;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.embedded-browser-instance-layer,
.embedded-browser-layer-item {
  position: absolute;
  min-width: 0;
  min-height: 0;
}

.embedded-browser-instance-layer {
  inset: 0;
}

.embedded-browser-layer-item {
  overflow: hidden;
}
</style>
