<template>
  <div ref="host" class="embedded-browser-surface-layer" aria-hidden="false">
    <div
      v-for="instanceId in pageInstanceIds"
      :key="instanceId"
      class="embedded-browser-instance-layer"
    >
      <div
        v-for="pageKey in stablePages[instanceId] || []"
        :key="pageKey"
        class="embedded-browser-layer-item"
        :style="itemStyle(instanceId, pageKey)"
        :data-instance-id="instanceId"
        :data-browser-page-key="pageKey"
      >
        <EmbeddedBrowserTab
          :instance-id="instanceId"
          :page-key="pageKey"
          :creation-ref="pageRecord(instanceId, pageKey)?.creationRef"
          :background-throttled="!isPageVisible(instanceId, pageKey)"
          :capture-active="isCaptureActive(instanceId, pageKey)"
          :initial-url="pageInitialUrl(instanceId, pageKey)"
          :open-pages="openPagesFor(instanceId)"
          @update-tab="(patch) => $emit('updateBrowserTab', instanceId, pageKey, patch)"
          @close-tab="$emit('closeBrowserTab', instanceId, hostTabKey(instanceId, pageKey) || pageKey)"
          @move-page="(targetPageKey) => $emit('moveBrowserPage', instanceId, hostTabKey(instanceId, pageKey) || '', targetPageKey)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type CSSProperties } from "vue";
import type { SessionTab } from "../useInstanceSessions";
import EmbeddedBrowserTab from "./EmbeddedBrowserTab.vue";
import type { BrowserPageSurface, SessionPaneId } from "./useActiveInstanceSessions";
import {
  ackDesktopBrowserCaptureSurface,
  listDesktopBrowserTabs,
  onDesktopBrowserCaptureSurface,
  onDesktopBrowserCaptureSurfaceRelease,
  onDesktopBrowserTabsChanged,
  type DesktopBrowserCaptureSurface,
  type DesktopBrowserTab,
} from "../../../lib/desktopBridge";

type SurfaceState = {
  leftSessionKey: string;
  rightSessionKey: string;
};

const BACKGROUND_BROWSER_WIDTH = 1280;
const BACKGROUND_BROWSER_HEIGHT = 720;

const props = defineProps<{
  activeInstanceId?: string;
  browserSessionTabs: Record<string, SessionTab[]>;
  browserPages: Record<string, BrowserPageSurface[]>;
  browserSurfaceState: Record<string, SurfaceState>;
}>();

defineEmits<{
  updateBrowserTab: [instanceId: string, pageKey: string, patch: { title?: string; url?: string; status?: string }];
  closeBrowserTab: [instanceId: string, slotKey: string];
  moveBrowserPage: [instanceId: string, targetSlotKey: string, sourcePageKey: string];
}>();

const host = ref<HTMLElement>();
const layoutRects = shallowRef(new Map<string, DOMRect>());
const layoutVersion = ref(0);
const desktopBrowserTabs = ref<Record<string, DesktopBrowserTab[]>>({});
const captureSurfaces = ref<Record<string, DesktopBrowserCaptureSurface>>({});
// Layers must never reorder: moving a <webview> in the DOM detaches and resets
// its guest. This registry keeps first-seen order and only appends/removes.
const stablePages = ref<Record<string, string[]>>({});
const pageInstanceIds = computed(() => Object.keys(stablePages.value));
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;
let layoutFrame: number | undefined;
let stopBrowserTabsChanged: (() => void) | undefined;
let stopCaptureSurface: (() => void) | undefined;
let stopCaptureSurfaceRelease: (() => void) | undefined;
const captureSurfaceTimers = new Map<string, number>();
let browserTabsRefreshSequence = 0;
let disposed = false;

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

function tabPageKey(tab: SessionTab) {
  const pageKey = tab.source?.pageKey;
  return typeof pageKey === "string" && pageKey ? pageKey : tab.key;
}

function hostTab(instanceId: string, pageKey: string) {
  return (props.browserSessionTabs[instanceId] || []).find((tab) => tabPageKey(tab) === pageKey);
}

function hostTabKey(instanceId: string, pageKey: string) {
  return hostTab(instanceId, pageKey)?.key;
}

function paneForPage(instanceId: string, pageKey: string): SessionPaneId | undefined {
  const tab = hostTab(instanceId, pageKey);
  const state = props.browserSurfaceState[instanceId];
  if (!tab || !state) return undefined;
  if (state.rightSessionKey === tab.key) return "right";
  if (state.leftSessionKey === tab.key) return "left";
  return undefined;
}

function pageRecord(instanceId: string, pageKey: string) {
  return (props.browserPages[instanceId] || []).find((page) => page.key === pageKey);
}

function pageInitialUrl(instanceId: string, pageKey: string) {
  const page = pageRecord(instanceId, pageKey);
  return page?.currentUrl || page?.initialUrl;
}

function itemStyle(instanceId: string, pageKey: string): CSSProperties {
  // Read the revision so Vue re-evaluates styles when pane geometry changes.
  void layoutVersion.value;
  const pane = paneForPage(instanceId, pageKey);
  const rect = pane ? layoutRects.value.get(`${instanceId}:${pane}`) : undefined;
  if (!rect) {
    // A background webview must keep a real size and stay visible in the DOM.
    // CDP clients read Page.getLayoutMetrics before they ask for a screenshot,
    // so a 0x0 guest makes them compute a 12x1 capture clip. Hiding the surface
    // with visibility: hidden also pauses requestAnimationFrame, which breaks
    // Playwright locators and input on background tabs. Keep it off-screen so
    // it cannot intercept pointer events, and only move it on-stage while a
    // screenshot is being captured.
    const capture = captureSurfaces.value[captureSurfaceKey(instanceId, pageKey)];
    return {
      left: capture ? "0px" : `-${BACKGROUND_BROWSER_WIDTH + 100}px`,
      top: "0px",
      width: `${capture?.width || BACKGROUND_BROWSER_WIDTH}px`,
      height: `${capture?.height || BACKGROUND_BROWSER_HEIGHT}px`,
      visibility: "visible",
      // Chromium skips compositor frames entirely for opacity: 0, which makes
      // capturePage return a tiny empty image. Keep the surface effectively
      // invisible without allowing the optimizer to drop its frame.
      opacity: capture ? 1 : undefined,
      pointerEvents: "none",
    };
  }
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

function captureSurfaceKey(instanceId: string, pageKey: string) {
  return `${instanceId}\u0000${pageKey}`;
}

function clearCaptureSurface(requestId: string) {
  const timer = captureSurfaceTimers.get(requestId);
  if (timer !== undefined) window.clearTimeout(timer);
  captureSurfaceTimers.delete(requestId);
  const next: Record<string, DesktopBrowserCaptureSurface> = {};
  for (const [key, surface] of Object.entries(captureSurfaces.value)) {
    if (surface.requestId !== requestId) next[key] = surface;
  }
  captureSurfaces.value = next;
}

function handleCaptureSurface(input: DesktopBrowserCaptureSurface) {
  const key = captureSurfaceKey(input.instanceId, input.pageKey);
  captureSurfaces.value = { ...captureSurfaces.value, [key]: input };
  const ack = () => ackDesktopBrowserCaptureSurface(input.requestId);
  const ready = (attempt: number) => {
    if (disposed || !captureSurfaces.value[key]) return;
    const item = findLayerItem(input.instanceId, input.pageKey);
    const rect = item?.getBoundingClientRect();
    // The native guest needs a couple of compositor frames after its surface
    // becomes visible. Give it a short settle window before the snapshot.
    if (rect && rect.width > 0 && rect.height > 0) {
      window.setTimeout(ack, 300);
      return;
    }
    if (attempt >= 20) {
      ack();
      return;
    }
    window.setTimeout(() => ready(attempt + 1), 50);
  };
  void nextTick(() => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => ready(0)));
    // Background windows do not fire rAF reliably; polling still converges once
    // the guest receives its new native viewport.
    window.setTimeout(() => ready(8), 400);
  });
  const timer = window.setTimeout(() => clearCaptureSurface(input.requestId), 9_000);
  captureSurfaceTimers.set(input.requestId, timer);
}

function findLayerItem(instanceId: string, pageKey: string) {
  // Story page keys are JSON arrays and contain quotes, so they cannot be
  // interpolated into an attribute selector without escaping.
  return [...document.querySelectorAll<HTMLElement>("[data-browser-page-key]")]
    .find((element) => element.dataset.instanceId === instanceId && element.dataset.browserPageKey === pageKey);
}

function isPageVisible(instanceId: string, pageKey: string) {
  return instanceId === props.activeInstanceId && Boolean(paneForPage(instanceId, pageKey));
}

function isCaptureActive(instanceId: string, pageKey: string) {
  return Boolean(captureSurfaces.value[captureSurfaceKey(instanceId, pageKey)]);
}

async function refreshDesktopBrowserTabs() {
  const sequence = ++browserTabsRefreshSequence;
  const result = await listDesktopBrowserTabs().catch(() => undefined);
  if (disposed || sequence !== browserTabsRefreshSequence || !result?.ok) return;
  const grouped: Record<string, DesktopBrowserTab[]> = {};
  for (const tab of result.tabs || []) {
    if (!tab.instanceId) continue;
    (grouped[tab.instanceId] ||= []).push(tab);
  }
  desktopBrowserTabs.value = grouped;
}

function syncStablePages() {
  const next: Record<string, string[]> = {};
  const sources = props.browserPages || {};
  const appendInstance = (instanceId: string) => {
    if (next[instanceId]) return;
    const previous = stablePages.value[instanceId] || [];
    const pages = sources[instanceId] || [];
    const present = new Set(pages.map((page) => page.key));
    const ordered = previous.filter((key) => present.has(key));
    for (const page of pages) {
      if (!ordered.includes(page.key)) ordered.push(page.key);
    }
    next[instanceId] = ordered;
  };
  for (const instanceId of Object.keys(stablePages.value)) {
    if (sources[instanceId]) appendInstance(instanceId);
  }
  for (const instanceId of Object.keys(sources)) appendInstance(instanceId);
  stablePages.value = next;
}

function openPagesFor(instanceId: string) {
  const pages = new Map<string, { key: string; title?: string; status?: string; url?: string }>();
  for (const page of props.browserPages[instanceId] || []) {
    pages.set(page.key, {
      key: page.key,
      title: page.title,
      status: page.status,
      url: page.currentUrl || page.initialUrl || "about:blank",
    });
  }
  for (const tab of props.browserSessionTabs[instanceId] || []) {
    const key = tabPageKey(tab);
    const current = pages.get(key);
    const url = typeof tab.source?.currentUrl === "string"
      ? tab.source.currentUrl
      : typeof tab.source?.initialUrl === "string" ? tab.source.initialUrl : "about:blank";
    pages.set(key, {
      key,
      title: current?.title || tab.title,
      status: current?.status || tab.status,
      url: current?.url || url,
    });
  }
  for (const tab of desktopBrowserTabs.value[instanceId] || []) {
    const key = tab.sessionKey?.trim();
    if (!key) continue;
    const current = pages.get(key);
    pages.set(key, {
      key,
      title: tab.title || current?.title,
      status: tab.state || current?.status,
      url: tab.url || current?.url || "about:blank",
    });
  }
  return [...pages.values()];
}

onMounted(() => {
  resizeObserver = new ResizeObserver(scheduleLayout);
  mutationObserver = new MutationObserver(scheduleLayout);
  mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-pane", "data-instance-id"] });
  window.addEventListener("resize", scheduleLayout);
  stopBrowserTabsChanged = onDesktopBrowserTabsChanged(() => { void refreshDesktopBrowserTabs(); });
  stopCaptureSurface = onDesktopBrowserCaptureSurface(handleCaptureSurface);
  stopCaptureSurfaceRelease = onDesktopBrowserCaptureSurfaceRelease(({ requestId }) => clearCaptureSurface(requestId));
  void refreshDesktopBrowserTabs();
  void nextTick(scheduleLayout);
});

watch(
  () => props.browserPages,
  () => {
    syncStablePages();
    void nextTick(scheduleLayout);
  },
  { deep: true, immediate: true, flush: "post" },
);

watch(
  [() => props.activeInstanceId, () => JSON.stringify(props.browserSurfaceState)],
  () => void nextTick(scheduleLayout),
  { flush: "post" },
);

onBeforeUnmount(() => {
  disposed = true;
  if (layoutFrame !== undefined) window.cancelAnimationFrame(layoutFrame);
  window.removeEventListener("resize", scheduleLayout);
  stopBrowserTabsChanged?.();
  stopCaptureSurface?.();
  stopCaptureSurfaceRelease?.();
  for (const timer of captureSurfaceTimers.values()) window.clearTimeout(timer);
  captureSurfaceTimers.clear();
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
