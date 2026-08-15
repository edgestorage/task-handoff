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
        <article
          v-for="message in turns[virtualTurn.index].userMessages"
          :key="message.id"
          class="ai-session-timeline-message"
          data-role="user-message"
        >
          <MarkdownContent :content="message.text" :code-tools="markdownCodeTools" />
        </article>
        <AiSessionResult
          :busy="busy"
          :can-interrupt="canInterrupt"
          :can-resolve-approval="canResolveApproval"
          :instance-id="instanceId"
          :file-links="fileLinks"
          :is-latest="isLatestTurn(virtualTurn.index)"
          :response-content="turns[virtualTurn.index].latestResponse?.text || ''"
          :session="session"
          :activities="trailingActivities(turns[virtualTurn.index])"
          :activity-history="turns[virtualTurn.index].history"
          activity-interactive
          @edit-queued-message="$emit('editQueuedMessage', $event)"
          @open-file="$emit('openFile', $event)"
          @steer-queued-message="$emit('steerQueuedMessage', $event)"
          @retry-queued-message="$emit('retryQueuedMessage', $event)"
          @remove-queued-message="$emit('removeQueuedMessage', $event)"
          @reorder-queued-messages="$emit('reorderQueuedMessages', $event)"
          @resolve-approval="$emit('resolveApproval', $event)"
        />
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import type { AiSessionTimelineActivity, AiSessionTimelineItem } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionSummary } from "../../api/types";
import AiSessionResult from "./AiSessionResult.vue";
import type { ConversationTimelineTurn } from "./timelineActivities";
import { conversationTimelineTurns } from "./timelineActivities";

const props = defineProps<{
  busy?: boolean;
  canInterrupt?: boolean;
  canResolveApproval?: boolean;
  fileLinks?: boolean;
  instanceId: string;
  items: AiSessionTimelineItem[];
  session: AiSessionSummary;
}>();
defineEmits<{
  editQueuedMessage: [payload: { queueId: string; message: string }];
  openFile: [href: string];
  removeQueuedMessage: [queueId: string];
  reorderQueuedMessages: [payload: { expectedRevision: number; queueIds: string[] }];
  resolveApproval: [decision: "allow" | "deny" | "skip"];
  retryQueuedMessage: [queueId: string];
  steerQueuedMessage: [queueId: string];
}>();
const { t } = useI18n();
const markdownCodeTools = computed(() => ({
  copiedLabel: t("sessions.markdown.copied"),
  copyLabel: t("sessions.markdown.copy"),
  plainTextLabel: t("sessions.markdown.plainText"),
}));

const turns = computed(() => conversationTimelineTurns(props.items));
const timelineElement = ref<HTMLElement>();
const scrollElement = ref<HTMLElement>();
const scrollMargin = ref(0);
const turnVirtualizer = useVirtualizer(computed(() => ({
  count: turns.value.length,
  estimateSize: () => 420,
  gap: 24,
  getItemKey: (index: number) => turns.value[index]?.id || index,
  getScrollElement: () => scrollElement.value || null,
  overscan: 3,
  scrollMargin: scrollMargin.value,
})));
const virtualTurns = computed(() => turnVirtualizer.value.getVirtualItems());
const virtualTotalSize = computed(() => turnVirtualizer.value.getTotalSize());

function syncScrollElement() {
  const viewport = timelineElement.value?.closest<HTMLElement>("[data-task-handoff-scroll-viewport]");
  scrollElement.value = viewport || undefined;
  if (!viewport || !timelineElement.value) {
    scrollMargin.value = 0;
    return;
  }
  scrollMargin.value = timelineElement.value.getBoundingClientRect().top
    - viewport.getBoundingClientRect().top
    + viewport.scrollTop;
}

function measureVirtualTurn(element: unknown) {
  if (element instanceof HTMLElement) turnVirtualizer.value.measureElement(element);
}

function isLatestTurn(index: number) {
  return index === turns.value.length - 1;
}

function trailingActivities(turn: ConversationTimelineTurn): AiSessionTimelineActivity[] {
  return turn.trailing.flatMap((node) => node.type === "activities" ? node.activities : []);
}

onMounted(() => {
  void nextTick(syncScrollElement);
  window.addEventListener("resize", syncScrollElement);
});
onBeforeUnmount(() => window.removeEventListener("resize", syncScrollElement));
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

.ai-session-timeline-message {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.ai-session-timeline-message[data-role="user-message"] {
  border-bottom: 1px solid var(--line-subtle);
  padding-bottom: 12px;
  color: var(--text);
  font-size: 14px;
  line-height: 1.55;
}

.ai-session-timeline-message :deep(.markdown-content),
.ai-session-timeline-message :deep(.markdown-content > *) {
  max-width: 100%;
  overflow-wrap: anywhere;
}
</style>
