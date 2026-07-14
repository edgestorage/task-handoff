<template>
  <aside ref="dockRoot" class="ai-board-floating-dock" aria-label="Selected AI session" :style="dockStyle" @click.stop>
    <Transition name="ai-board-floating-panel-fade" mode="out-in">
      <section v-if="!collapsed" class="ai-board-floating-detail">
        <div class="ai-board-floating-resize ai-board-floating-resize-top" @pointerdown.stop.prevent="startResize('top', $event)" />
        <div class="ai-board-floating-resize ai-board-floating-resize-left" @pointerdown.stop.prevent="startResize('left', $event)" />
        <div class="ai-board-floating-resize ai-board-floating-resize-right" @pointerdown.stop.prevent="startResize('right', $event)" />
        <div class="ai-board-floating-resize ai-board-floating-resize-top-left" @pointerdown.stop.prevent="startResize('top-left', $event)" />
        <div class="ai-board-floating-resize ai-board-floating-resize-top-right" @pointerdown.stop.prevent="startResize('top-right', $event)" />
        <header class="ai-board-floating-head">
          <div>
            <span>{{ instanceDisplayName(card.instance) }}</span>
            <strong>{{ aiSessionAppDisplayName(card.appTab, card.session.agent) }} · {{ aiSessionStatusLabel(card.session) }}</strong>
          </div>
          <div class="ai-board-floating-head-actions">
            <TooltipProvider :delay-duration="120">
              <Tooltip>
                <TooltipTrigger as-child>
                  <button type="button" title="Session details" aria-label="Session details">
                    <CircleHelp :size="15" />
                  </button>
                </TooltipTrigger>
                <TooltipContent class="ai-board-session-info-tooltip" align="end" side="bottom" :side-offset="8">
                  <dl>
                    <div>
                      <dt>Workspace</dt>
                      <dd>{{ card.session.cwd || "Unknown" }}</dd>
                    </div>
                    <div>
                      <dt>Session</dt>
                      <dd>{{ card.session.providerSessionId || card.session.id }}</dd>
                    </div>
                    <div>
                      <dt>App Binding</dt>
                      <dd>{{ card.session.appSessionId || "Not bound" }}</dd>
                    </div>
                  </dl>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <button type="button" title="Open app session" aria-label="Open app session" @click="$emit('openAiSessionApp', card.instance, card.session)">
              <ExternalLink :size="15" />
            </button>
            <button type="button" title="Collapse details" @click="$emit('update:collapsed', true)">
              <ChevronDown :size="15" />
            </button>
          </div>
        </header>

        <ScrollArea class="ai-board-floating-scroll">
          <div class="ai-board-floating-content">
            <section class="ai-board-floating-block ai-board-floating-block-user">
              <span>User Message</span>
              <MarkdownContent :content="displayAiSessionTitle(card.session, promptIndex)" />
            </section>

            <section class="ai-board-floating-block ai-board-floating-block-assistant">
              <span>AI Response / Progress</span>
              <MarkdownContent :content="displayAiSessionMessage(card.session, promptIndex)" />
            </section>

            <div v-if="card.session.currentTool?.name" class="ai-board-floating-tool">
              <span>Current Tool</span>
              <strong>{{ card.session.currentTool.name }}</strong>
              <small v-if="card.session.currentTool.inputPreview">{{ card.session.currentTool.inputPreview }}</small>
            </div>

            <section v-if="card.session.queue?.items.length" class="ai-board-floating-block ai-board-floating-queue">
              <span>Queue · {{ card.session.queue.pendingCount }}</span>
              <div class="ai-board-floating-queue-list">
                <article v-for="item in card.session.queue.items" :key="item.id" class="ai-board-floating-queue-item" :data-state="item.status">
                  <p>{{ item.message }}</p>
                  <small v-if="item.error">{{ item.error }}</small>
                  <div>
                    <button type="button" :disabled="busy || !canInterrupt" @click="$emit('steerQueuedMessage', item.id)">Steer</button>
                    <button v-if="item.status === 'failed'" type="button" :disabled="busy" @click="$emit('retryQueuedMessage', item.id)">Retry</button>
                    <button type="button" :disabled="busy" @click="$emit('removeQueuedMessage', item.id)">Remove</button>
                  </div>
                </article>
              </div>
            </section>

            <div v-if="canResolveApproval" class="ai-board-floating-approval">
              <button type="button" :disabled="busy" @click="$emit('resolveApproval', 'allow')">
                <Check :size="14" />
                <span>Allow</span>
              </button>
              <button type="button" :disabled="busy" @click="$emit('resolveApproval', 'skip')">
                <Ban :size="14" />
                <span>Skip</span>
              </button>
              <button type="button" :disabled="busy" @click="$emit('resolveApproval', 'deny')">
                <X :size="14" />
                <span>Deny</span>
              </button>
            </div>
          </div>
        </ScrollArea>
      </section>

      <button v-else type="button" class="ai-board-floating-restore" @click="$emit('update:collapsed', false)">
        <ChevronUp :size="14" />
        <span>{{ aiSessionAppDisplayName(card.appTab, card.session.agent) }} · {{ aiSessionStatusLabel(card.session) }}</span>
      </button>
    </Transition>

    <AiSessionComposer
      class="ai-board-floating-compose"
      :model-value="draft"
      :attachments="attachments"
      :busy="busy"
      :can-interrupt="canInterrupt"
      @update:model-value="$emit('update:draft', $event)"
      @update:attachments="$emit('update:attachments', $event)"
      @add-context="$emit('addContext')"
      @run="$emit('run')"
      @steer="$emit('steer')"
    />
  </aside>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { Ban, Check, ChevronDown, ChevronUp, CircleHelp, ExternalLink, X } from "@lucide/vue";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions } from "../../../api/types";
import AiSessionComposer, { type AiSessionComposerAttachment } from "../../../components/ai-session/AiSessionComposer.vue";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import {
  aiSessionAppDisplayName,
  aiSessionStatusLabel,
  displayAiSessionMessage,
  displayAiSessionTitle,
} from "../useInstanceSessions";
import type { AiBoardCard } from "./aiBoardTypes";

defineProps<{
  busy: boolean;
  canInterrupt: boolean;
  canResolveApproval: boolean;
  card: AiBoardCard;
  collapsed: boolean;
  attachments: AiSessionComposerAttachment[];
  draft: string;
  instanceDisplayName: (instance: InstanceBoardItem) => string;
  promptIndex: number;
}>();

defineEmits<{
  addContext: [];
  openAiSessionApp: [instance: InstanceWithAiSessions, session?: AiSessionSummary];
  removeQueuedMessage: [queueId: string];
  resolveApproval: [decision: "allow" | "deny" | "skip"];
  retryQueuedMessage: [queueId: string];
  run: [];
  steer: [];
  steerQueuedMessage: [queueId: string];
  "update:collapsed": [value: boolean];
  "update:attachments": [value: AiSessionComposerAttachment[]];
  "update:draft": [value: string];
}>();

type ResizeHandle = "top" | "left" | "right" | "top-left" | "top-right";

const MIN_DOCK_WIDTH = 420;
const DEFAULT_DOCK_WIDTH = 760;
const MIN_DETAIL_HEIGHT = 180;
const DEFAULT_DETAIL_HEIGHT = 420;
const DOCK_SIDE_GUTTER = 48;
const DOCK_VERTICAL_RESERVE = 260;
const DOCK_SIZE_STORAGE_KEY = "task-handoff:ai-board:floating-dock-size";

const dockWidth = ref(DEFAULT_DOCK_WIDTH);
const detailHeight = ref(DEFAULT_DETAIL_HEIGHT);
const dockRoot = ref<HTMLElement>();
let activeResize:
  | {
      handle: ResizeHandle;
      pointerId: number;
      startX: number;
      startY: number;
      startWidth: number;
      startHeight: number;
    }
  | undefined;

const dockStyle = computed(() => ({
  "--ai-board-floating-width": `${dockWidth.value}px`,
  "--ai-board-floating-detail-height": `${detailHeight.value}px`,
}));

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function maxDockWidth() {
  const parent = dockRoot.value?.offsetParent;
  const parentWidth = parent instanceof HTMLElement ? parent.clientWidth : window.innerWidth;
  return Math.max(MIN_DOCK_WIDTH, parentWidth - DOCK_SIDE_GUTTER);
}

function maxDetailHeight() {
  return Math.max(MIN_DETAIL_HEIGHT, window.innerHeight - DOCK_VERTICAL_RESERVE);
}

function clampCurrentSize() {
  dockWidth.value = clamp(dockWidth.value, MIN_DOCK_WIDTH, maxDockWidth());
  detailHeight.value = clamp(detailHeight.value, MIN_DETAIL_HEIGHT, maxDetailHeight());
}

function loadSavedSize() {
  try {
    const saved = window.localStorage.getItem(DOCK_SIZE_STORAGE_KEY);
    if (!saved) {
      return;
    }
    const parsed = JSON.parse(saved) as Partial<{ width: unknown; detailHeight: unknown }>;
    if (typeof parsed.width === "number" && Number.isFinite(parsed.width)) {
      dockWidth.value = parsed.width;
    }
    if (typeof parsed.detailHeight === "number" && Number.isFinite(parsed.detailHeight)) {
      detailHeight.value = parsed.detailHeight;
    }
  } catch {
    window.localStorage.removeItem(DOCK_SIZE_STORAGE_KEY);
  }
}

function saveSize() {
  window.localStorage.setItem(
    DOCK_SIZE_STORAGE_KEY,
    JSON.stringify({
      width: dockWidth.value,
      detailHeight: detailHeight.value,
    }),
  );
}

function startResize(handle: ResizeHandle, event: PointerEvent) {
  clampCurrentSize();
  activeResize = {
    handle,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: dockWidth.value,
    startHeight: detailHeight.value,
  };
  document.body.dataset.aiBoardResizing = "true";
  window.addEventListener("pointermove", handleResizeMove);
  window.addEventListener("pointerup", stopResize);
  window.addEventListener("pointercancel", stopResize);
}

function handleResizeMove(event: PointerEvent) {
  if (!activeResize || event.pointerId !== activeResize.pointerId) {
    return;
  }
  const { handle, startHeight, startWidth, startX, startY } = activeResize;
  if (handle.includes("top")) {
    detailHeight.value = clamp(startHeight + startY - event.clientY, MIN_DETAIL_HEIGHT, maxDetailHeight());
  }
  if (handle.includes("left")) {
    dockWidth.value = clamp(startWidth + (startX - event.clientX) * 2, MIN_DOCK_WIDTH, maxDockWidth());
  } else if (handle.includes("right")) {
    dockWidth.value = clamp(startWidth + (event.clientX - startX) * 2, MIN_DOCK_WIDTH, maxDockWidth());
  }
}

function stopResize(event?: PointerEvent) {
  if (event && activeResize && event.pointerId !== activeResize.pointerId) {
    return;
  }
  activeResize = undefined;
  delete document.body.dataset.aiBoardResizing;
  window.removeEventListener("pointermove", handleResizeMove);
  window.removeEventListener("pointerup", stopResize);
  window.removeEventListener("pointercancel", stopResize);
  clampCurrentSize();
  saveSize();
}

function handleViewportResize() {
  clampCurrentSize();
}

onMounted(() => {
  loadSavedSize();
  clampCurrentSize();
  window.addEventListener("resize", handleViewportResize);
});

onBeforeUnmount(() => {
  stopResize();
  window.removeEventListener("resize", handleViewportResize);
});
</script>

<style scoped>
.ai-board-floating-dock {
  --ai-board-floating-radius: 20px;
  display: grid;
  position: absolute;
  bottom: 18px;
  left: 50%;
  z-index: 20;
  gap: 8px;
  width: min(var(--ai-board-floating-width, 760px), calc(100% - 48px));
  min-width: min(420px, calc(100% - 48px));
  color: var(--text);
  transform: translateX(-50%);
}

.ai-board-floating-detail,
.ai-board-floating-restore {
  overflow: hidden;
  border: 1px solid var(--ai-board-column-border);
  border-radius: var(--ai-board-floating-radius);
  background: color-mix(in srgb, var(--ai-board-column-bg) 82%, transparent);
  -webkit-backdrop-filter: blur(16px) saturate(1.24);
  backdrop-filter: blur(16px) saturate(1.24);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.34);
}

.ai-board-floating-detail {
  display: grid;
  position: relative;
  grid-template-rows: auto minmax(0, 1fr);
  height: min(var(--ai-board-floating-detail-height, 420px), calc(100vh - 260px));
  min-height: 180px;
  max-height: calc(100vh - 260px);
}

.ai-board-floating-panel-fade-enter-active,
.ai-board-floating-panel-fade-leave-active {
  transition: opacity 90ms ease;
}

.ai-board-floating-panel-fade-enter-from,
.ai-board-floating-panel-fade-leave-to {
  opacity: 0;
}

.ai-board-floating-resize {
  position: absolute;
  z-index: 5;
  background: transparent;
  touch-action: none;
}

.ai-board-floating-resize-top {
  top: 0;
  right: 14px;
  left: 14px;
  height: 10px;
  cursor: ns-resize;
}

.ai-board-floating-resize-left,
.ai-board-floating-resize-right {
  top: 12px;
  bottom: 12px;
  width: 10px;
  cursor: ew-resize;
}

.ai-board-floating-resize-left {
  left: 0;
}

.ai-board-floating-resize-right {
  right: 0;
}

.ai-board-floating-resize-top-left,
.ai-board-floating-resize-top-right {
  top: 0;
  width: 18px;
  height: 18px;
}

.ai-board-floating-resize-top-left {
  left: 0;
  cursor: nwse-resize;
}

.ai-board-floating-resize-top-right {
  right: 0;
  cursor: nesw-resize;
}

.ai-board-floating-resize:hover::after {
  content: "";
  position: absolute;
  inset: 3px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ai-board-active-border) 38%, transparent);
}

:global(body[data-ai-board-resizing="true"]) {
  user-select: none;
  cursor: ns-resize;
}

.ai-board-floating-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  border-bottom: 1px solid var(--ai-board-column-border);
  background: var(--ai-board-column-head-bg);
  padding: 12px 14px;
}

.ai-board-floating-head > div:first-child {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.ai-board-floating-head span,
.ai-board-floating-tool span,
.ai-board-floating-tool small {
  color: var(--ai-board-muted);
  font-size: 12px;
}

.ai-board-floating-head strong {
  min-width: 0;
  overflow: hidden;
  color: var(--ai-board-title);
  font-size: 14px;
  font-weight: 850;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-board-floating-head .ai-board-floating-head-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 6px;
}

.ai-board-floating-head-actions button,
.ai-board-floating-restore {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--ai-board-floating-border);
  background: var(--ai-board-floating-bg);
  color: var(--ai-board-floating-text);
  cursor: pointer;
}

.ai-board-floating-head-actions button {
  width: 26px;
  height: 26px;
  border-radius: 6px;
}

.ai-board-floating-head-actions button:hover,
.ai-board-floating-head-actions button:focus-visible,
.ai-board-floating-restore:hover,
.ai-board-floating-restore:focus-visible {
  border-color: var(--ai-board-floating-hover-border);
  color: var(--ai-board-floating-hover-text);
  outline: none;
}

.ai-board-floating-scroll {
  min-height: 0;
}

.ai-board-floating-content {
  display: grid;
  gap: 12px;
  min-width: 0;
  padding: 14px;
}

.ai-board-floating-block,
.ai-board-floating-tool {
  display: grid;
  gap: 7px;
  min-width: 0;
  border-bottom: 1px solid var(--ai-board-column-border);
  padding-bottom: 12px;
}

.ai-board-floating-block > span,
.ai-board-floating-queue > span {
  color: var(--ai-board-muted);
  font-size: 12px;
  font-weight: 800;
}

.ai-board-floating-block > div {
  color: var(--ai-board-title);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.ai-board-floating-block-assistant {
  border: 0;
  background: var(--ai-board-assistant-bg);
  margin-inline: -14px;
  padding: 12px 14px;
}

.ai-board-floating-block-assistant > span {
  color: var(--ai-board-active-text);
}

.ai-board-floating-block-assistant > div {
  color: var(--ai-board-title);
}

.ai-board-floating-block :deep(code) {
  border-radius: 4px;
  background: var(--ai-board-code-bg);
  color: var(--ai-board-code-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.92em;
  padding: 1px 4px;
}

.ai-board-floating-tool strong {
  color: var(--ai-board-title);
  font-size: 13px;
}

.ai-board-floating-tool small {
  overflow-wrap: anywhere;
}

.ai-board-floating-approval {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.ai-board-floating-approval button,
.ai-board-floating-queue-item button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--ai-board-floating-border);
  border-radius: 7px;
  background: var(--ai-board-floating-bg);
  color: var(--ai-board-floating-text);
  cursor: pointer;
}

.ai-board-floating-approval button {
  gap: 6px;
  min-height: 30px;
  font-size: 12px;
  font-weight: 800;
  padding: 0 10px;
}

.ai-board-floating-approval button:hover,
.ai-board-floating-approval button:focus-visible,
.ai-board-floating-queue-item button:hover,
.ai-board-floating-queue-item button:focus-visible {
  border-color: var(--ai-board-floating-hover-border);
  color: var(--ai-board-floating-hover-text);
  outline: none;
}

.ai-board-floating-approval button:disabled,
.ai-board-floating-queue-item button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ai-board-floating-queue-list {
  display: grid;
  gap: 8px;
}

.ai-board-floating-queue-item {
  display: grid;
  gap: 7px;
  min-width: 0;
  border: 1px solid var(--ai-board-column-border);
  border-radius: 7px;
  background: var(--ai-board-card-bg);
  padding: 9px;
}

.ai-board-floating-queue-item[data-state="failed"] {
  border-color: var(--ai-board-card-failed-border);
}

.ai-board-floating-queue-item p {
  margin: 0;
  color: var(--ai-board-title);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.ai-board-floating-queue-item small {
  color: var(--ai-board-stale-text);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.ai-board-floating-queue-item div {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ai-board-floating-queue-item button {
  min-height: 26px;
  font-size: 11px;
  padding: 0 8px;
}

.ai-board-floating-restore {
  gap: 8px;
  justify-self: center;
  min-width: 0;
  max-width: 100%;
  min-height: 34px;
  padding: 0 12px;
}

.ai-board-floating-restore span {
  overflow: hidden;
  font-size: 12px;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-board-floating-compose {
  --ai-composer-radius: var(--ai-board-floating-radius);
  --ai-composer-border: var(--ai-board-column-border);
  --ai-composer-bg: color-mix(in srgb, var(--ai-board-card-bg) 82%, transparent);
  --ai-composer-text: var(--ai-board-title);
  --ai-composer-muted: var(--ai-board-muted);
  --ai-composer-primary-bg: var(--ai-board-active-border);
  --ai-composer-primary-text: var(--ai-board-title);
  --ai-composer-stop-bg: var(--ai-board-card-failed-border);
  --ai-composer-stop-text: var(--ai-board-stale-text);
  --ai-composer-danger: var(--ai-board-stale-text);
  --ai-composer-shadow: 0 18px 48px rgba(0, 0, 0, 0.34);
  min-height: 86px;
  max-height: min(280px, calc(100vh - 144px));
  -webkit-backdrop-filter: blur(16px) saturate(1.24);
  backdrop-filter: blur(16px) saturate(1.24);
}

:global(.ai-board-session-info-tooltip) {
  max-width: min(520px, calc(100vw - 32px));
  border: 1px solid var(--ai-board-column-border) !important;
  background: color-mix(in srgb, var(--ai-board-column-bg) 92%, transparent) !important;
  color: var(--ai-board-message) !important;
  -webkit-backdrop-filter: blur(16px) saturate(1.18);
  backdrop-filter: blur(16px) saturate(1.18);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.34);
  padding: 12px;
}

:global(.ai-board-session-info-tooltip dl) {
  display: grid;
  gap: 10px;
  margin: 0;
}

:global(.ai-board-session-info-tooltip div) {
  display: grid;
  gap: 3px;
  min-width: 0;
}

:global(.ai-board-session-info-tooltip dt) {
  color: var(--ai-board-muted) !important;
  font-size: 11px;
  font-weight: 800;
}

:global(.ai-board-session-info-tooltip dd) {
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--ai-board-message) !important;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  line-height: 1.35;
}

.ai-board-floating-compose :deep(.ai-session-composer__input) {
  min-height: 64px;
  padding: 10px 14px 4px;
}

.ai-board-floating-compose :deep(.ai-session-composer__toolbar) {
  padding: 2px 8px 8px;
}

.ai-board-floating-compose :deep(.ai-session-composer__tool) {
  width: 28px;
  height: 28px;
}

.ai-board-floating-compose :deep(.ai-session-composer__primary) {
  width: 30px;
  height: 30px;
}

.ai-board-floating-compose :deep(.ai-session-composer__error) {
  padding: 0 12px 8px;
}

@media (max-width: 780px) {
  .ai-board-floating-dock {
    bottom: 12px;
    width: calc(100% - 24px);
    min-width: 0;
  }

  .ai-board-floating-detail {
    height: min(var(--ai-board-floating-detail-height, 380px), calc(100vh - 220px));
    max-height: calc(100vh - 220px);
  }
}
</style>
