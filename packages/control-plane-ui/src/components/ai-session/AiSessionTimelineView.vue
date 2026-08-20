<template>
  <section ref="timelineElement" class="ai-session-timeline" :aria-label="t('sessions.timeline.full')">
    <div class="ai-session-timeline-virtual-list" :style="{ height: `${virtualTotalSize}px` }">
      <section
        v-for="virtualTurn in virtualTurns"
        :key="turns[virtualTurn.index].id"
        :ref="measureVirtualTurn"
        class="ai-session-timeline-turn"
        :data-index="virtualTurn.index"
        :style="{ transform: `translateY(${virtualTurn.start - scrollMargin}px)` }"
      >
        <div
          v-for="message in turns[virtualTurn.index].userMessages"
          :key="message.id"
          class="ai-session-timeline-user-message"
        >
          <article
            class="ai-session-timeline-message"
            data-role="user-message"
            :data-message-id="message.id"
          >
            <MarkdownContent :content="message.text" :code-tools="markdownCodeTools" />
            <AiSessionMessageAttachments
              v-if="message.attachments?.length && conversationSessionId"
              :instance-id="instanceId"
              :session-id="conversationSessionId"
              :message-id="message.id"
              :attachments="message.attachments"
            />
          </article>
          <footer class="ai-session-user-message-actions" :aria-label="t('sessions.timeline.turnActions')">
            <time
              v-if="turns[virtualTurn.index].startedAt"
              class="ai-session-turn-time"
              :datetime="turns[virtualTurn.index].startedAt"
              :title="formatTurnDateTime(turns[virtualTurn.index].startedAt || '')"
            >{{ formatTurnTime(turns[virtualTurn.index].startedAt || '') }}</time>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              class="ai-session-user-message-copy"
              :aria-label="copiedMessageId === message.id ? t('sessions.markdown.copied') : t('sessions.markdown.copy')"
              :title="copiedMessageId === message.id ? t('sessions.markdown.copied') : t('sessions.markdown.copy')"
              @click="copyMessage(message)"
            >
              <Check v-if="copiedMessageId === message.id" :size="13" />
              <Copy v-else :size="13" />
            </Button>
          </footer>
        </div>
        <div class="ai-session-timeline-response">
          <AiSessionResult
            v-if="session"
            :busy="busy"
            :can-interrupt="canInterrupt"
            :can-resolve-approval="canResolveApproval"
            :instance-id="instanceId"
            :file-links="fileLinks"
            :is-latest="isLatestTurn(virtualTurn.index)"
            :response-content="turns[virtualTurn.index].latestResponse?.text || ''"
            :turn-started-at="turns[virtualTurn.index].startedAt"
            :turn-ended-at="turns[virtualTurn.index].endedAt"
            :session="session"
            :activities="turns[virtualTurn.index].activities"
            :activity-nodes="turns[virtualTurn.index].activityNodes"
            :activity-history="turns[virtualTurn.index].history"
            :activity-history-status="turns[virtualTurn.index].timelineStatus"
            :activity-history-error="turns[virtualTurn.index].timelineError"
            activity-interactive
            @layout-will-change="$emit('layoutWillChange')"
            @layout-committed="commitVirtualTurnLayout(virtualTurn.index, $event)"
            @edit-queued-message="$emit('editQueuedMessage', $event)"
            @open-file="$emit('openFile', $event)"
            @steer-queued-message="$emit('steerQueuedMessage', $event)"
            @retry-queued-message="$emit('retryQueuedMessage', $event)"
            @remove-queued-message="$emit('removeQueuedMessage', $event)"
            @reorder-queued-messages="$emit('reorderQueuedMessages', $event)"
            @resolve-approval="$emit('resolveApproval', $event)"
            @retry-activity-history="$emit('loadTurnTimeline', turns[virtualTurn.index].id, true)"
          >
            <template #turn-footer>
              <footer
                v-if="turns[virtualTurn.index].latestResponse && completedTurn(turns[virtualTurn.index].id)"
                class="ai-session-turn-actions"
                :aria-label="t('sessions.timeline.turnActions')"
              >
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  class="ai-session-turn-action"
                  :aria-label="copiedMessageId === turns[virtualTurn.index].latestResponse?.id ? t('sessions.markdown.copied') : t('sessions.markdown.copy')"
                  :title="copiedMessageId === turns[virtualTurn.index].latestResponse?.id ? t('sessions.markdown.copied') : t('sessions.markdown.copy')"
                  @click="copyMessage(turns[virtualTurn.index].latestResponse)"
                >
                  <Check v-if="copiedMessageId === turns[virtualTurn.index].latestResponse?.id" :size="13" />
                  <Copy v-else :size="13" />
                </Button>
                <Button
                  v-if="continuableTurn(turns[virtualTurn.index].id)"
                  type="button"
                  size="xs"
                  variant="ghost"
                  class="ai-session-turn-action"
                  :disabled="busy"
                  :aria-label="t('sessions.actions.continueFromTurn')"
                  :title="t('sessions.actions.continueFromTurn')"
                  @click="continueFromTurn(turns[virtualTurn.index].id)"
                >
                  <Split :size="13" />
                </Button>
                <time
                  v-if="turnTime(turns[virtualTurn.index].id)"
                  class="ai-session-turn-time"
                  :datetime="turnTime(turns[virtualTurn.index].id)"
                  :title="formatTurnDateTime(turnTime(turns[virtualTurn.index].id))"
                >{{ formatTurnTime(turnTime(turns[virtualTurn.index].id)) }}</time>
              </footer>
            </template>
          </AiSessionResult>
          <section
            v-else-if="turns[virtualTurn.index].latestResponse"
            class="ai-session-timeline-stored-response"
          >
            <MarkdownContent
              :content="turns[virtualTurn.index].latestResponse?.text || ''"
              :code-tools="markdownCodeTools"
            />
          </section>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { elementScroll, useVirtualizer } from "@tanstack/vue-virtual";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Copy, Split } from "@lucide/vue";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import type { AiSessionHistoryTurn, AiSessionTimelineActivity, AiSessionTurn } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionSummary } from "../../api/types";
import type { AiSessionTurnTimelineState } from "../../apps/control-plane/useAiSessionTimelineStore";
import { Button } from "../ui/button";
import AiSessionResult from "./AiSessionResult.vue";
import AiSessionMessageAttachments from "./AiSessionMessageAttachments.vue";
import type { TimelineMessage, TimelineTurnNode } from "./timelineActivities";
import { compactTimelineForTurn, turnElapsedEnd } from "./timelineActivities";

const props = withDefaults(defineProps<{
  busy?: boolean;
  canInterrupt?: boolean;
  canResolveApproval?: boolean;
  fileLinks?: boolean;
  instanceId: string;
  conversationSessionId?: string;
  session?: AiSessionSummary;
  storedTurns?: AiSessionHistoryTurn[];
  turnTimelines?: Record<string, AiSessionTurnTimelineState>;
}>(), {
  storedTurns: () => [],
  turnTimelines: () => ({}),
});
const emit = defineEmits<{
  editQueuedMessage: [payload: { queueId: string; message: string }];
  openFile: [href: string];
  removeQueuedMessage: [queueId: string];
  reorderQueuedMessages: [payload: { expectedRevision: number; queueIds: string[] }];
  resolveApproval: [decision: "allow" | "deny" | "skip"];
  retryQueuedMessage: [queueId: string];
  steerQueuedMessage: [queueId: string];
  stickyUserMessageChange: [message: { id: string; text: string } | undefined];
  continueFromTurn: [turnId: string];
  layoutWillChange: [];
  layoutCommitted: [];
  loadTurnTimeline: [turnId: string, force?: boolean];
}>();
const { locale, t } = useI18n();
const markdownCodeTools = computed(() => ({
  copiedLabel: t("sessions.markdown.copied"),
  copyLabel: t("sessions.markdown.copy"),
  plainTextLabel: t("sessions.markdown.plainText"),
}));

type DisplayConversationTurn = {
  id: string;
  startedAt?: string;
  endedAt?: string;
  userMessages: Extract<TimelineMessage, { type: "user-message" }>[];
  history: TimelineTurnNode[];
  latestResponse?: TimelineMessage;
  activities: AiSessionTimelineActivity[];
  activityNodes: TimelineTurnNode[];
  timelineStatus: AiSessionTurnTimelineState["status"];
  timelineError?: string;
};

const sourceTurns = computed(() => props.session?.turns || props.storedTurns);
const turns = computed<DisplayConversationTurn[]>(() => sourceTurns.value.map((turn) => {
  const state = props.turnTimelines[turn.id] || { status: "idle" as const, items: [] };
  const timeline = compactTimelineForTurn(state.items, turn);
  const retainedUserMessages = "userMessages" in turn && Array.isArray(turn.userMessages) ? turn.userMessages : [];
  const userMessages = retainedUserMessages.length
    ? retainedUserMessages.map((message) => ({ ...message, turnId: turn.id, type: "user-message" as const }))
    : turn.userPrompt?.trim()
    ? [{ id: `${turn.id}:user-summary`, turnId: turn.id, type: "user-message" as const, text: turn.userPrompt.trim(), attachments: [] }]
    : [];
  const responseText = turn.lastMessage?.trim() || (!props.session ? turn.summary?.trim() : "");
  const lastMessageItemId = "lastMessageItemId" in turn && typeof turn.lastMessageItemId === "string"
    ? turn.lastMessageItemId
    : `${turn.id}:ai-summary`;
  const latestResponse = responseText
    ? {
        id: lastMessageItemId,
        turnId: turn.id,
        type: "ai-message" as const,
        text: responseText,
      }
    : undefined;
  return {
    id: turn.id,
    startedAt: turn.startedAt,
    endedAt: turnElapsedEnd(turn),
    userMessages,
    history: timeline.history,
    latestResponse,
    activities: timeline.activities,
    activityNodes: timeline.activityNodes,
    timelineStatus: state.status,
    timelineError: state.error,
  };
}));
const copiedMessageId = ref("");
const timelineElement = ref<HTMLElement>();
const scrollElement = ref<HTMLElement>();
const scrollMargin = ref(0);
let stickyUserMessageId = "";
let stickyUserMessageFrame = 0;
let copiedTurnTimer: ReturnType<typeof setTimeout> | undefined;
const turnVirtualizer = useVirtualizer(computed(() => ({
  count: turns.value.length,
  estimateSize: () => 420,
  anchorTo: "end",
  gap: 24,
  getItemKey: (index: number) => turns.value[index]?.id || index,
  getScrollElement: () => scrollElement.value || null,
  overscan: 3,
  scrollEndThreshold: 48,
  scrollMargin: scrollMargin.value,
  measureElement: (element) => Math.ceil(element.getBoundingClientRect().height),
  scrollToFn: (offset, options, instance) => {
    if (options.adjustments && scrollElement.value?.closest(".is-user-layout-changing")) return;
    elementScroll(offset, options, instance);
  },
})));
const virtualTurns = computed(() => turnVirtualizer.value.getVirtualItems());
const virtualTotalSize = computed(() => turnVirtualizer.value.getTotalSize());

function syncScrollElement() {
  const viewport = timelineElement.value?.closest<HTMLElement>("[data-task-handoff-scroll-viewport]");
  if (scrollElement.value !== viewport) {
    scrollElement.value?.removeEventListener("scroll", scheduleStickyUserMessageUpdate);
    viewport?.addEventListener("scroll", scheduleStickyUserMessageUpdate, { passive: true });
  }
  scrollElement.value = viewport || undefined;
  if (!viewport || !timelineElement.value) {
    scrollMargin.value = 0;
    updateStickyUserMessage("");
    return;
  }
  scrollMargin.value = timelineElement.value.getBoundingClientRect().top
    - viewport.getBoundingClientRect().top
    + viewport.scrollTop;
  scheduleStickyUserMessageUpdate();
}

function updateStickyUserMessage(messageId: string) {
  if (stickyUserMessageId === messageId) return;
  stickyUserMessageId = messageId;
  const message = turns.value
    .flatMap((turn) => turn.userMessages)
    .find((item) => item.id === messageId);
  emit("stickyUserMessageChange", message ? { id: message.id, text: message.text } : undefined);
}

function scheduleStickyUserMessageUpdate() {
  cancelAnimationFrame(stickyUserMessageFrame);
  stickyUserMessageFrame = requestAnimationFrame(() => {
    const timeline = timelineElement.value;
    const viewport = scrollElement.value;
    if (!timeline || !viewport) {
      updateStickyUserMessage("");
      return;
    }

    const viewportTop = viewport.getBoundingClientRect().top;
    let nearestId = "";
    let nearestTop = Number.NEGATIVE_INFINITY;
    for (const node of timeline.querySelectorAll<HTMLElement>('[data-role="user-message"]')) {
      const naturalTop = node.getBoundingClientRect().top - viewportTop + viewport.scrollTop;
      if (naturalTop <= viewport.scrollTop + 0.5 && naturalTop > nearestTop) {
        nearestId = node.dataset.messageId || "";
        nearestTop = naturalTop;
      }
    }
    updateStickyUserMessage(nearestId);
  });
}

function measureVirtualTurn(element: unknown) {
  if (!(element instanceof HTMLElement)) return;
  turnVirtualizer.value.measureElement(element);
  const index = Number(element.dataset.index);
  if (!Number.isInteger(index)) return;
  // TanStack deliberately skips its synchronous measurement path during a
  // user scroll and waits for ResizeObserver. For these dynamic Turn rows that
  // leaves the estimate in the DOM for one paint; the later correction then
  // looks like a jump on the first upward pass. The Vue ref runs after the row
  // is patched but before paint, so commit the first real size here while still
  // keeping measureElement registered for subsequent content changes.
  turnVirtualizer.value.resizeItem(index, Math.ceil(element.getBoundingClientRect().height));
}

function loadVisibleTurnTimelines() {
  if (!props.session) return;
  for (const virtualTurn of virtualTurns.value) {
    const turn = turns.value[virtualTurn.index];
    if (!turn || (turn.timelineStatus !== "idle" && turn.timelineStatus !== "stale")) continue;
    emit("loadTurnTimeline", turn.id);
  }
}

function commitVirtualTurnLayout(index: number, element: HTMLElement) {
  const turn = element.closest<HTMLElement>(".ai-session-timeline-turn");
  if (turn) turnVirtualizer.value.resizeItem(index, Math.ceil(turn.getBoundingClientRect().height));
  void nextTick(() => emit("layoutCommitted"));
}

function isLatestTurn(index: number) {
  return index === turns.value.length - 1;
}

function sessionTurn(turnId: string): AiSessionTurn | undefined {
  return props.session?.turns?.find((turn) => turn.id === turnId || turn.providerTurnId === turnId);
}

function continuableTurn(turnId: string): AiSessionTurn | undefined {
  const turn = completedTurn(turnId);
  return props.session?.actions?.fork === true && turn?.providerTurnId
    ? turn
    : undefined;
}

function completedTurn(turnId: string): AiSessionTurn | undefined {
  const turn = sessionTurn(turnId);
  return turn?.status === "completed" ? turn : undefined;
}

function turnTime(turnId: string) {
  const turn = sessionTurn(turnId);
  return turn?.completedAt || turn?.updatedAt || turn?.startedAt || "";
}

function formatTurnTime(value: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat(locale.value, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTurnDateTime(value: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

async function copyMessage(message?: TimelineMessage) {
  if (!message?.text || !navigator.clipboard?.writeText) return;
  try {
    await navigator.clipboard.writeText(message.text);
  } catch {
    return;
  }
  copiedMessageId.value = message.id;
  clearTimeout(copiedTurnTimer);
  copiedTurnTimer = setTimeout(() => {
    if (copiedMessageId.value === message.id) copiedMessageId.value = "";
  }, 1_500);
}

function continueFromTurn(turnId: string) {
  const turn = continuableTurn(turnId);
  if (turn) emit("continueFromTurn", turn.id);
}

onMounted(() => {
  void nextTick(() => {
    syncScrollElement();
    loadVisibleTurnTimelines();
  });
  window.addEventListener("resize", syncScrollElement);
});
onBeforeUnmount(() => {
  clearTimeout(copiedTurnTimer);
  cancelAnimationFrame(stickyUserMessageFrame);
  scrollElement.value?.removeEventListener("scroll", scheduleStickyUserMessageUpdate);
  updateStickyUserMessage("");
  window.removeEventListener("resize", syncScrollElement);
});
watch(() => props.turnTimelines, () => void nextTick(() => {
  scheduleStickyUserMessageUpdate();
  loadVisibleTurnTimelines();
}), { flush: "post" });
watch(virtualTurns, () => void nextTick(() => {
  scheduleStickyUserMessageUpdate();
  loadVisibleTurnTimelines();
}), { flush: "post" });
watch(() => sourceTurns.value.map((turn) => `${turn.id}:${turn.status}`).join("|"), () => {
  void nextTick(loadVisibleTurnTimelines);
});
watch(virtualTotalSize, () => void nextTick(() => emit("layoutCommitted")), { flush: "post" });
watch(() => turns.value.length, () => void nextTick(syncScrollElement));
</script>

<style scoped>
.ai-session-timeline {
  position: relative;
  min-width: 0;
}

.ai-session-timeline-virtual-list {
  position: relative;
  width: 100%;
  min-width: 0;
}

.ai-session-timeline-turn {
  position: absolute;
  top: 0;
  left: 0;
  display: grid;
  width: 100%;
  gap: 24px;
  min-width: 0;
}

/* The outer TanStack list owns offscreen sizing for each mounted turn. */
.ai-session-timeline-turn :deep(.markdown-renderer) {
  content-visibility: visible;
  contain-intrinsic-size: none;
}

.ai-session-timeline-response {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.ai-session-turn-actions {
  display: flex;
  min-height: 26px;
  align-items: center;
  gap: 2px;
  color: var(--text-muted);
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}

.ai-session-timeline-turn:hover .ai-session-turn-actions,
.ai-session-timeline-turn:focus-within .ai-session-turn-actions {
  opacity: 1;
  pointer-events: auto;
}

.ai-session-turn-actions :deep(.ai-session-turn-action) {
  width: 26px;
  height: 26px;
  padding: 0;
  color: inherit;
}

.ai-session-turn-actions :deep(.ai-session-turn-action svg) {
  width: 13px;
  height: 13px;
}

.ai-session-turn-time {
  padding-inline: 6px;
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
}

@media (hover: none) {
  .ai-session-turn-actions {
    opacity: 1;
    pointer-events: auto;
  }
}

.ai-session-timeline-message {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.ai-session-timeline-user-message {
  justify-self: end;
  display: grid;
  justify-items: end;
  width: fit-content;
  max-width: min(78%, 620px);
  min-width: 0;
}

.ai-session-timeline-message[data-role="user-message"] {
  max-width: 100%;
  border-radius: 14px;
  background: var(--surface-hover);
  padding: 12px 14px;
  color: var(--text);
  font-size: 14px;
  line-height: 1.55;
}

.ai-session-user-message-actions {
  display: flex;
  min-height: 26px;
  align-items: center;
  margin-top: 8px;
  color: var(--text-muted);
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}

.ai-session-timeline-user-message:hover .ai-session-user-message-actions,
.ai-session-timeline-user-message:focus-within .ai-session-user-message-actions {
  opacity: 1;
  pointer-events: auto;
}

.ai-session-user-message-actions :deep(.ai-session-user-message-copy) {
  width: 26px;
  height: 26px;
  padding: 0;
  color: inherit;
}

@media (hover: none) {
  .ai-session-user-message-actions {
    opacity: 1;
    pointer-events: auto;
  }
}

.ai-session-timeline-message :deep(.markdown-content),
.ai-session-timeline-message :deep(.markdown-content > *) {
  max-width: 100%;
  overflow-wrap: anywhere;
}

.ai-session-timeline-stored-response {
  min-width: 0;
  color: var(--text);
  font-size: 14px;
  line-height: 1.55;
}

.ai-session-timeline-stored-response :deep(.markdown-content),
.ai-session-timeline-stored-response :deep(.markdown-content > *) {
  max-width: 100%;
  overflow-wrap: anywhere;
}

.ai-session-timeline-stored-response :deep(.markdown-content > :first-child) { margin-top: 0; }
.ai-session-timeline-stored-response :deep(.markdown-content > :last-child) { margin-bottom: 0; }
</style>
