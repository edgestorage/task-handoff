<template>
  <aside ref="dockRoot" class="ai-board-floating-dock" :aria-label="t('sessions.detail.selected')" :style="dockStyle" @click.stop>
    <Transition name="ai-board-floating-panel-fade" mode="out-in">
      <section v-if="!collapsed" class="ai-board-floating-detail" :class="{ 'is-scrolled': detailScrolled }">
        <div class="ai-board-floating-resize ai-board-floating-resize-top" @pointerdown.stop.prevent="startResize('top', $event)" />
        <div class="ai-board-floating-resize ai-board-floating-resize-left" @pointerdown.stop.prevent="startResize('left', $event)" />
        <div class="ai-board-floating-resize ai-board-floating-resize-right" @pointerdown.stop.prevent="startResize('right', $event)" />
        <div class="ai-board-floating-resize ai-board-floating-resize-top-left" @pointerdown.stop.prevent="startResize('top-left', $event)" />
        <div class="ai-board-floating-resize ai-board-floating-resize-top-right" @pointerdown.stop.prevent="startResize('top-right', $event)" />
        <header class="ai-board-floating-head">
          <div>
            <span class="ai-board-floating-primary-line">
              <span>{{ instanceDisplayName(card.instance) }}</span>
            </span>
            <strong class="ai-board-floating-secondary-line">
              <span>{{ aiSessionAppDisplayName(card.appTab, card.session.agent, t) }}</span>
              <span aria-hidden="true">·</span>
              <span class="ai-board-floating-workspace">
                <TooltipProvider :delay-duration="120">
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <b>{{ aiSessionBasename(card.session.cwd) || t("sessions.board.unknownFolder") }}</b>
                    </TooltipTrigger>
                    <TooltipContent class="ai-session-path-tooltip" side="top" :side-offset="8">{{ card.session.cwd || t("sessions.board.unknownPath") }}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </span>
            </strong>
          </div>
          <div class="ai-board-floating-head-actions">
            <AiSessionTurnNavigator
              :count="promptCount"
              :index="promptIndex"
              :aria-label="t('sessions.composer.navigation')"
              :previous-label="t('sessions.actions.previousMessage', { agent: card.session.agent })"
              :next-label="t('sessions.actions.nextMessage', { agent: card.session.agent })"
              tone="board"
              @previous="$emit('previousPrompt')"
              @next="$emit('nextPrompt')"
            />
            <TooltipProvider :delay-duration="120">
              <Tooltip>
                <TooltipTrigger as-child>
                  <button type="button" :title="t('sessions.detail.sessionDetails')" :aria-label="t('sessions.detail.sessionDetails')">
                    <CircleHelp :size="15" />
                  </button>
                </TooltipTrigger>
                <TooltipContent class="ai-board-session-info-tooltip" align="end" side="bottom" :side-offset="8">
                  <dl>
                    <div>
                      <dt>{{ t("sessions.detail.workspace") }}</dt>
                      <dd>{{ card.session.cwd || t("sessions.detail.unknown") }}</dd>
                    </div>
                    <div>
                      <dt>{{ t("sessions.detail.session") }}</dt>
                      <dd>{{ card.session.providerSessionId || card.session.id }}</dd>
                    </div>
                    <div>
                      <dt>{{ t("sessions.detail.appBinding") }}</dt>
                      <dd>{{ card.session.appSessionId || t("sessions.detail.notBound") }}</dd>
                    </div>
                  </dl>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <button type="button" :title="t('sessions.actions.openApp')" :aria-label="t('sessions.actions.openApp')" @click="$emit('openAiSessionApp', card.instance, card.session)">
              <ExternalLink :size="15" />
            </button>
            <button type="button" :title="t('sessions.detail.collapse')" @click="$emit('update:collapsed', true)">
              <ChevronDown :size="15" />
            </button>
          </div>
        </header>

        <ScrollArea class="ai-board-floating-scroll">
          <div class="ai-board-floating-content">
            <section ref="promptSectionEl" class="ai-board-floating-block ai-board-floating-block-user">
              <div
                ref="promptContentEl"
                class="ai-board-floating-prompt-content"
                :class="{ expanded: promptExpanded }"
              >
                <MarkdownContent :content="displayAiSessionTitle(card.session, promptIndex, t)" />
              </div>
              <button
                v-if="promptHasOverflow"
                type="button"
                class="ai-board-floating-prompt-toggle"
                :aria-expanded="promptExpanded"
                @click="togglePrompt"
              >
                <span>{{ promptExpanded ? t("sessions.detail.collapsePrompt") : t("sessions.detail.expand") }}</span>
                <ChevronDown :size="13" :class="{ open: promptExpanded }" />
              </button>
            </section>

            <div
              v-if="detailScrolled && promptStickyPlaceholderHeight > 0"
              class="ai-board-floating-prompt-placeholder"
              :style="{ height: `${promptStickyPlaceholderHeight}px` }"
              aria-hidden="true"
            />

            <AiSessionResult
              :busy="busy"
              :can-interrupt="canInterrupt"
              :can-resolve-approval="canResolveApproval"
              :instance-id="card.instance.id"
              :is-latest="promptIndex >= promptCount - 1"
              :response-content="displayAiSessionResponse(card.session, promptIndex, t)"
              :session="card.session"
              tone="board"
              @edit-queued-message="$emit('editQueuedMessage', $event)"
              @reorder-queued-messages="$emit('reorderQueuedMessages', $event)"
              @steer-queued-message="$emit('steerQueuedMessage', $event)"
              @retry-queued-message="$emit('retryQueuedMessage', $event)"
              @remove-queued-message="$emit('removeQueuedMessage', $event)"
              @resolve-approval="$emit('resolveApproval', $event)"
            />
          </div>
        </ScrollArea>
      </section>

      <button v-else type="button" class="ai-board-floating-restore" @click="$emit('update:collapsed', false)">
        <ChevronUp :size="14" />
        <span>{{ aiSessionAppDisplayName(card.appTab, card.session.agent, t) }} · {{ aiSessionBasename(card.session.cwd) || t("sessions.board.unknownFolder") }}</span>
      </button>
    </Transition>

    <AiSessionComposer
      ref="composerEl"
      class="ai-board-floating-compose"
      :model-value="draft"
      :attachments="attachments"
      :editing-label="editingLabel"
      :mention-bindings="mentionBindings"
      :mention-context="mentionContext"
      :mention-trigger="mentionTrigger"
      :command-trigger="commandTrigger"
      :session-busy="sessionBusy"
      :busy="busy"
      :can-interrupt="canInterrupt"
      :provider="card.session.agent"
      :permission-key="aiSessionPermissionKey(card.instance.id, card.session.id)"
      :default-permission-mode="card.instance.config.defaultCodexPermissionMode"
      @update:model-value="$emit('update:draft', $event)"
      @update:attachments="$emit('update:attachments', $event)"
      @update:mention-bindings="$emit('update:mentionBindings', $event)"
      @run="$emit('run', $event)"
      @cancel-edit="$emit('cancelEdit')"
      @steer="$emit('steer')"
      @command="$emit('command', $event)"
    />
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronUp, CircleHelp, ExternalLink } from "@lucide/vue";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions } from "../../../api/types";
import AiSessionComposer, { type AiSessionComposerAttachment } from "../../../components/ai-session/AiSessionComposer.vue";
import AiSessionResult from "../../../components/ai-session/AiSessionResult.vue";
import type { AiSessionMentionBinding } from "../../../components/ai-session/mentions";
import type { AiSessionCommandInput, AiSessionPermissionMode } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionMentionContext } from "../../../components/ai-session/useAiSessionMentions";
import { aiSessionPermissionKey } from "../useAiSessionPermissionMode";
import AiSessionTurnNavigator from "../../../components/ai-session/AiSessionTurnNavigator.vue";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import {
  aiSessionAppDisplayName,
  aiSessionBasename,
  displayAiSessionResponse,
  displayAiSessionTitle,
} from "../useInstanceSessions";
import type { AiBoardCard } from "./aiBoardTypes";

const { t } = useI18n();

const props = defineProps<{
  busy: boolean;
  canInterrupt: boolean;
  canResolveApproval: boolean;
  card: AiBoardCard;
  collapsed: boolean;
  attachments: AiSessionComposerAttachment[];
  draft: string;
  editingLabel?: string;
  mentionBindings: AiSessionMentionBinding[];
  mentionContext?: AiSessionMentionContext;
  mentionTrigger: string;
  commandTrigger: string;
  sessionBusy: boolean;
  instanceDisplayName: (instance: InstanceBoardItem) => string;
  promptCount: number;
  promptIndex: number;
}>();

defineEmits<{
  cancelEdit: [];
  editQueuedMessage: [payload: { queueId: string; message: string }];
  nextPrompt: [];
  openAiSessionApp: [instance: InstanceWithAiSessions, session?: AiSessionSummary];
  previousPrompt: [];
  removeQueuedMessage: [queueId: string];
  reorderQueuedMessages: [payload: { expectedRevision: number; queueIds: string[] }];
  resolveApproval: [decision: "allow" | "deny" | "skip"];
  retryQueuedMessage: [queueId: string];
  run: [permissionMode?: AiSessionPermissionMode];
  command: [input: AiSessionCommandInput];
  steer: [];
  steerQueuedMessage: [queueId: string];
  "update:collapsed": [value: boolean];
  "update:attachments": [value: AiSessionComposerAttachment[]];
  "update:draft": [value: string];
  "update:mentionBindings": [value: AiSessionMentionBinding[]];
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
const composerEl = ref<InstanceType<typeof AiSessionComposer>>();
const detailScrolled = ref(false);
const promptContentEl = ref<HTMLElement>();
const promptSectionEl = ref<HTMLElement>();
const promptHasOverflow = ref(false);
const promptExpanded = ref(false);
const promptStickyPlaceholderHeight = ref(0);
defineExpose({ focusComposer: () => composerEl.value?.focus() });
let detailScrollViewport: HTMLElement | undefined;
let detailScrollLayoutRevision = 0;
let detailScrollLayoutPending = false;
let promptStickyThreshold = 0;
let promptResizeObserver: ResizeObserver | undefined;
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

function updatePromptOverflow() {
  const element = promptContentEl.value;
  if (promptExpanded.value) return;
  promptHasOverflow.value = Boolean(element && element.scrollHeight > element.clientHeight + 1);
}

function togglePrompt() {
  promptExpanded.value = !promptExpanded.value;
  if (!promptExpanded.value) {
    void nextTick(updatePromptOverflow);
  }
}

function updatePromptStickyThreshold() {
  if (detailScrolled.value) return;
  const prompt = promptSectionEl.value;
  const content = promptContentEl.value;
  const viewport = detailScrollViewport;
  if (!prompt || !content || !viewport) {
    promptStickyThreshold = 0;
    return;
  }
  const detail = dockRoot.value?.querySelector<HTMLElement>(".ai-board-floating-detail");
  if (!detail) {
    promptStickyThreshold = 0;
    return;
  }
  const expandedDividerOffset = prompt.getBoundingClientRect().bottom
    - viewport.getBoundingClientRect().top
    + viewport.scrollTop;
  detail.classList.add("is-scrolled");
  const stickyHeight = prompt.getBoundingClientRect().height;
  detail.classList.remove("is-scrolled");
  promptStickyThreshold = Math.max(0, Math.ceil(expandedDividerOffset - stickyHeight));
}

function updatePromptLayout() {
  updatePromptOverflow();
  updatePromptStickyThreshold();
}

function stopObservingDetailScroll() {
  detailScrollViewport?.removeEventListener("scroll", handleDetailScroll);
  detailScrollViewport = undefined;
  detailScrollLayoutRevision += 1;
  detailScrollLayoutPending = false;
  detailScrolled.value = false;
  promptStickyPlaceholderHeight.value = 0;
  promptStickyThreshold = 0;
}

function observeDetailScroll() {
  stopObservingDetailScroll();
  const viewport = dockRoot.value?.querySelector<HTMLElement>(".ai-board-floating-scroll [data-task-handoff-scroll-viewport]");
  if (!viewport) return;
  detailScrollViewport = viewport;
  updatePromptStickyThreshold();
  viewport.addEventListener("scroll", handleDetailScroll, { passive: true });
  handleDetailScroll();
}

function handleDetailScroll() {
  if (detailScrollLayoutPending) return;
  const scrollTop = detailScrollViewport?.scrollTop || 0;
  if (!detailScrolled.value && promptStickyThreshold <= 0) {
    updatePromptStickyThreshold();
  }
  if (!detailScrolled.value && promptStickyThreshold > 0 && scrollTop > promptStickyThreshold) {
    void enterDetailStickyLayout();
  } else if (detailScrolled.value && scrollTop <= promptStickyThreshold) {
    detailScrollLayoutRevision += 1;
    promptStickyPlaceholderHeight.value = 0;
    detailScrolled.value = false;
  }
}

async function enterDetailStickyLayout() {
  const prompt = promptSectionEl.value;
  if (!prompt || detailScrolled.value) return;
  const revision = ++detailScrollLayoutRevision;
  const previousScrollTop = detailScrollViewport?.scrollTop || 0;
  const expandedHeight = prompt.getBoundingClientRect().height;
  updatePromptStickyThreshold();
  detailScrollLayoutPending = true;
  detailScrolled.value = true;
  await nextTick();
  if (revision !== detailScrollLayoutRevision || !detailScrolled.value || !promptSectionEl.value) {
    detailScrollLayoutPending = false;
    return;
  }
  const stickyHeight = promptSectionEl.value.getBoundingClientRect().height;
  promptStickyPlaceholderHeight.value = Math.max(0, Math.ceil(expandedHeight - stickyHeight));
  await nextTick();
  if (revision === detailScrollLayoutRevision && detailScrollViewport) {
    detailScrollViewport.scrollTop = previousScrollTop;
  }
  detailScrollLayoutPending = false;
}

function observePrompt() {
  promptResizeObserver?.disconnect();
  promptResizeObserver = undefined;
  if (typeof ResizeObserver !== "undefined") {
    promptResizeObserver = new ResizeObserver(updatePromptLayout);
    if (promptContentEl.value) promptResizeObserver.observe(promptContentEl.value);
    if (promptSectionEl.value) promptResizeObserver.observe(promptSectionEl.value);
  }
  updatePromptLayout();
}

watch(
  [
    () => props.card.session.id,
    () => props.promptIndex,
    () => displayAiSessionTitle(props.card.session, props.promptIndex, t),
  ],
  () => {
    promptExpanded.value = false;
    promptHasOverflow.value = false;
    void nextTick(observePrompt);
  },
);

watch(
  () => props.collapsed,
  () => void nextTick(() => {
    observePrompt();
    observeDetailScroll();
  }),
);

onMounted(() => {
  loadSavedSize();
  clampCurrentSize();
  window.addEventListener("resize", handleViewportResize);
  void nextTick(() => {
    observePrompt();
    observeDetailScroll();
  });
});

onBeforeUnmount(() => {
  stopResize();
  stopObservingDetailScroll();
  promptResizeObserver?.disconnect();
  window.removeEventListener("resize", handleViewportResize);
});
</script>

<style scoped>
.ai-board-floating-dock {
  --ai-board-floating-radius: 20px;
  --ai-board-floating-surface-border: var(--line-strong);
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
  border: 1px solid var(--ai-board-floating-surface-border);
  border-radius: var(--ai-board-floating-radius);
  background: color-mix(in srgb, var(--ai-board-column-bg) 82%, transparent);
  -webkit-backdrop-filter: blur(16px) saturate(1.24);
  backdrop-filter: blur(16px) saturate(1.24);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.34);
}

.ai-board-floating-detail {
  --ai-board-floating-sticky-padding-block: 10px;
  --ai-board-floating-sticky-border-width: 1px;
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
  flex: 1 1 auto;
  gap: 3px;
  min-width: 0;
}

.ai-board-floating-head span {
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

.ai-board-floating-workspace {
  display: flex;
  align-items: baseline;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}

.ai-board-floating-head .ai-board-floating-workspace {
  color: inherit;
  font-size: inherit;
  font-weight: inherit;
}

.ai-board-floating-secondary-line {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.ai-board-floating-head .ai-board-floating-secondary-line > span:first-child,
.ai-board-floating-head .ai-board-floating-secondary-line > span:nth-child(2) {
  color: inherit;
  font-size: inherit;
  font-weight: inherit;
}

.ai-board-floating-primary-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.ai-board-floating-primary-line > span:first-child {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-board-floating-workspace b {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-board-floating-workspace b {
  flex: 0 1 auto;
  color: inherit;
  font-size: inherit;
  font-weight: inherit;
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
  gap: 8px;
  min-width: 0;
  padding: 14px;
}

.ai-board-floating-block {
  display: grid;
  gap: 7px;
  min-width: 0;
  border-bottom: 1px solid var(--ai-board-column-border);
  padding-bottom: 12px;
}

.ai-board-floating-block > span {
  color: var(--ai-board-muted);
  font-size: 12px;
  font-weight: 800;
}

.ai-board-floating-block > div {
  color: var(--ai-board-title);
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.ai-board-floating-block-user {
  position: relative;
}

.ai-board-floating-prompt-content {
  min-width: 0;
  max-height: calc(1.55em * 3);
  overflow: hidden;
  color: var(--ai-board-title);
  font-size: 14px;
  line-height: 1.55;
  white-space: normal;
}

.ai-board-floating-prompt-content.expanded {
  max-height: none;
}

.ai-board-floating-prompt-content :deep(.markdown-content),
.ai-board-floating-prompt-content :deep(.markdown-content > *) {
  max-width: 100%;
  overflow-wrap: anywhere;
}

.ai-board-floating-prompt-toggle {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  gap: 3px;
  border: 0;
  background: transparent;
  color: var(--ai-board-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}

.ai-board-floating-prompt-toggle:hover {
  color: var(--ai-board-title);
}

.ai-board-floating-prompt-toggle svg {
  transition: transform 160ms ease;
}

.ai-board-floating-prompt-toggle svg.open {
  transform: rotate(180deg);
}

.ai-board-floating-detail.is-scrolled .ai-board-floating-block-user {
  position: sticky;
  top: 0;
  z-index: 3;
  margin-inline: -14px;
  border-bottom: var(--ai-board-floating-sticky-border-width) solid var(--ai-board-column-border);
  background: var(--ai-board-column-head-bg);
  padding: var(--ai-board-floating-sticky-padding-block) 14px;
}

.ai-board-floating-detail.is-scrolled .ai-board-floating-prompt-content {
  max-height: 1.55em;
}

.ai-board-floating-detail.is-scrolled .ai-board-floating-prompt-content :deep(.markdown-content),
.ai-board-floating-detail.is-scrolled .ai-board-floating-prompt-content :deep(.markdown-content > *) {
  display: block;
  max-width: 100%;
  margin-block: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-board-floating-detail.is-scrolled .ai-board-floating-prompt-toggle {
  display: none;
}

.ai-board-floating-prompt-placeholder {
  min-height: 0;
  margin-top: -8px;
  pointer-events: none;
}

.ai-board-floating-block :deep(code) {
  border-radius: 4px;
  background: var(--ai-board-code-bg);
  color: var(--ai-board-code-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.92em;
  padding: 1px 4px;
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
  --ai-composer-border: var(--ai-board-floating-surface-border);
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
