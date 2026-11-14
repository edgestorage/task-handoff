<template>
  <div ref="host" class="remote-desktop-surface-layer">
    <div
      v-for="(tabs, instanceId) in sessionTabs"
      :key="instanceId"
      class="remote-desktop-instance-layer"
    >
      <div
        v-for="tab in tabs.filter((item) => item.kind === 'remote-desktop')"
        :key="tab.key"
        class="remote-desktop-layer-item"
        :style="itemStyle(instanceId, tab.key)"
        :data-instance-id="instanceId"
        :data-session-key="tab.key"
      >
        <SessionRemoteDesktopSurface
          v-if="canInteract && remoteDesktopSessionId(tab)"
          :instance-id="instanceId"
          :session-id="remoteDesktopSessionId(tab)"
          :capabilities="instanceCapabilities[instanceId]"
          :active="isActiveTab(instanceId, tab.key)"
          :target="sessionRemoteDesktopLinkFor(instanceId, remoteDesktopSessionId(tab))?.target"
        />
        <InstanceRemoteDesktopViewer
          v-else-if="canInteract"
          :active="isActiveTab(instanceId, tab.key)"
          :auto-connect="Boolean(remoteDesktopSessionId(tab))"
          :can-manage="canManage"
          :capabilities="instanceCapabilities[instanceId]"
          embedded
          :initial-target="remoteDesktopSessionId(tab) ? sessionRemoteDesktopLinkFor(instanceId, remoteDesktopSessionId(tab)!)?.target : undefined"
          :instance-id="instanceId"
          @selection-change="rememberSelection(instanceId, tab, $event)"
          @stopped="handleStopped(instanceId, tab)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type CSSProperties } from "vue";
import type { SessionTab } from "../useInstanceSessions";
import SessionRemoteDesktopSurface from "../../../components/remote-desktop/SessionRemoteDesktopSurface.vue";
import InstanceRemoteDesktopViewer from "./InstanceRemoteDesktopViewer.vue";
import type { SessionPaneId } from "./useActiveInstanceSessions";
import { requestCloseSessionRemoteDesktop } from "./sessionRemoteDesktopEvents";
import {
  rememberSessionRemoteDesktopLink,
  removeSessionRemoteDesktopLink,
  sessionRemoteDesktopLinkFor,
  type SessionRemoteDesktopTarget,
} from "./sessionRemoteDesktopLinks";

type SurfaceState = {
  leftSessionKey: string;
  rightSessionKey: string;
};

const props = defineProps<{
  activeInstanceId?: string;
  canInteract: boolean;
  canManage: boolean;
  instanceCapabilities: Record<string, Record<string, unknown> | undefined>;
  sessionTabs: Record<string, SessionTab[]>;
  surfaceState: Record<string, SurfaceState>;
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
  const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-remote-desktop-surface]"));
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

function activePane(instanceId: string, sessionKey: string): SessionPaneId | undefined {
  if (instanceId !== props.activeInstanceId) return undefined;
  const state = props.surfaceState[instanceId];
  if (state?.leftSessionKey === sessionKey) return "left";
  if (state?.rightSessionKey === sessionKey) return "right";
  return undefined;
}

function isActiveTab(instanceId: string, sessionKey: string) {
  const pane = activePane(instanceId, sessionKey);
  return Boolean(pane && layoutRects.value.has(`${instanceId}:${pane}`));
}

function remoteDesktopSessionId(tab: SessionTab) {
  const value = tab.source?.aiSessionId;
  return typeof value === "string" && value ? value : "";
}

function rememberSelection(instanceId: string, tab: SessionTab, target: SessionRemoteDesktopTarget) {
  const sessionId = remoteDesktopSessionId(tab);
  if (!sessionId) return;
  rememberSessionRemoteDesktopLink({ instanceId, sessionId, target });
}

function handleStopped(instanceId: string, tab: SessionTab) {
  const sessionId = remoteDesktopSessionId(tab);
  if (!sessionId) return;
  removeSessionRemoteDesktopLink(instanceId, sessionId);
  requestCloseSessionRemoteDesktop({ instanceId, sessionId });
}

function itemStyle(instanceId: string, sessionKey: string): CSSProperties {
  // Read the revision so Vue re-evaluates styles when pane geometry changes.
  void layoutVersion.value;
  const pane = activePane(instanceId, sessionKey);
  const rect = pane ? layoutRects.value.get(`${instanceId}:${pane}`) : undefined;
  const visible = Boolean(rect);
  return {
    left: `${rect?.x || 0}px`,
    top: `${rect?.y || 0}px`,
    width: `${rect?.width || 0}px`,
    height: `${rect?.height || 0}px`,
    visibility: visible ? "visible" : "hidden",
    pointerEvents: visible ? "auto" : "none",
  };
}

onMounted(() => {
  resizeObserver = new ResizeObserver(scheduleLayout);
  mutationObserver = new MutationObserver(scheduleLayout);
  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-pane", "data-instance-id"],
  });
  window.addEventListener("resize", scheduleLayout);
  void nextTick(scheduleLayout);
});

watch(
  [
    () => props.activeInstanceId,
    () => JSON.stringify(props.surfaceState),
    () => JSON.stringify(props.sessionTabs),
  ],
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
.remote-desktop-surface-layer {
  position: absolute;
  z-index: 9;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.remote-desktop-instance-layer,
.remote-desktop-layer-item {
  position: absolute;
  min-width: 0;
  min-height: 0;
}

.remote-desktop-instance-layer {
  inset: 0;
}

.remote-desktop-layer-item {
  overflow: hidden;
}
</style>
