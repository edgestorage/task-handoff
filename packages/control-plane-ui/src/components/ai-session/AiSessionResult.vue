<template>
  <div
    ref="turnElement"
    class="ai-session-result"
    :class="[
      `ai-session-result-${tone}`,
      { 'has-response': displayContent },
    ]"
    :style="turnMinHeight ? { minHeight: `${turnMinHeight}px` } : undefined"
  >
    <div ref="turnContentElement" class="ai-session-result-content">
      <AiSessionQueue
        v-if="showQueue && isLatest && session.queue?.items.length"
        :busy="busy"
        :can-interrupt="canInterrupt"
        :queue="session.queue"
        :tone="tone"
        @edit-queued-message="$emit('editQueuedMessage', $event)"
        @remove-queued-message="$emit('removeQueuedMessage', $event)"
        @reorder-queued-messages="$emit('reorderQueuedMessages', $event)"
        @retry-queued-message="$emit('retryQueuedMessage', $event)"
        @steer-queued-message="$emit('steerQueuedMessage', $event)"
      />

      <AiSessionTurnHistory
        :key="turnId"
        :nodes="activityHistory"
        :loading="activityHistoryStatus === 'loading'"
        :loadable="activityHistoryStatus === 'idle' || activityHistoryStatus === 'stale'"
        :error="activityHistoryError"
        :started-at="turnStartedAt"
        :ended-at="turnEndedAt"
        :active="active"
        @load="$emit('loadActivityHistory')"
        @retry="$emit('retryActivityHistory')"
      />

      <details v-if="retryWarning" class="ai-session-retry-warning" role="status" aria-live="polite">
        <summary>
          <TriangleAlert :size="18" aria-hidden="true" />
          <div>
            <strong>{{ t("sessions.detail.retryWarning") }}</strong>
            <p class="ai-session-retry-warning-preview">{{ retryWarningFirstLine }}</p>
            <p class="ai-session-retry-warning-detail">{{ retryWarning }}</p>
          </div>
          <ChevronRight class="ai-session-retry-warning-chevron" :size="16" aria-hidden="true" />
        </summary>
      </details>

      <section
        v-if="displayContent"
        class="ai-session-detail-response"
        :class="{ 'ai-session-detail-response-active': active }"
      >
        <AiSessionStreamingMarkdown
          :code-tools="markdownCodeTools"
          :content="responseContent"
          :file-links="fileLinks"
          :instance-id="instanceId"
          :is-latest="isLatest"
          :provider-turn-id="providerTurnId"
          :session-id="session.id"
          :turn-id="turnId"
          @open-file="$emit('openFile', $event)"
        />
      </section>

      <AiSessionToolActivity
        v-if="isLatest && active"
        :current-tool="session.currentTool"
        :phase="session.phase"
        :status="session.status"
        :summary="session.summary"
        :tool-calls-since-last-message="session.toolCallsSinceLastMessage"
        :tone="tone"
        :activities="activities"
        :nodes="activityNodes"
        :error="activityError"
        :interactive="activityInteractive"
        :loading="activityLoading"
      />

      <AiSessionSubAgents
        v-if="isLatest && session.subAgents?.length"
        :sub-agents="session.subAgents"
      />

      <div v-if="isLatest && canResolveApproval" class="ai-session-detail-approval">
        <button v-if="approvalDecisions.includes('allow')" type="button" :disabled="busy" @click="$emit('resolveApproval', 'allow')">
          <Check :size="14" />
          <span>{{ t("sessions.actions.allow") }}</span>
        </button>
        <button v-if="approvalDecisions.includes('skip')" type="button" :disabled="busy" @click="$emit('resolveApproval', 'skip')">
          <Ban :size="14" />
          <span>{{ t("sessions.actions.skip") }}</span>
        </button>
        <button v-if="approvalDecisions.includes('deny')" type="button" :disabled="busy" @click="$emit('resolveApproval', 'deny')">
          <X :size="14" />
          <span>{{ t("sessions.actions.deny") }}</span>
        </button>
      </div>

      <slot name="turn-footer" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { Ban, Check, ChevronRight, TriangleAlert, X } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onBeforeUpdate, onUpdated, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AiSessionSummary } from "../../api/types";
import type { AiSessionTimelineActivity } from "@task-handoff/protocol/ai-sessions";
import type { TimelineTurnNode } from "./timelineActivities";
import { messageMatchesTurn, useStreamingMessagesStore } from "../../apps/control-plane/useStreamingMessagesStore";
import { createLatestTurnHeightBuffer } from "../../lib/latest-turn-height";
import AiSessionQueue from "./AiSessionQueue.vue";
import AiSessionStreamingMarkdown from "./AiSessionStreamingMarkdown.vue";
import AiSessionTurnHistory from "./AiSessionTurnHistory.vue";
import AiSessionSubAgents from "./AiSessionSubAgents.vue";
import AiSessionToolActivity from "./AiSessionToolActivity.vue";

const { t } = useI18n();
const markdownCodeTools = computed(() => ({
  copiedLabel: t("sessions.markdown.copied"),
  copyLabel: t("sessions.markdown.copy"),
  plainTextLabel: t("sessions.markdown.plainText"),
}));

const props = withDefaults(defineProps<{
  busy?: boolean;
  canInterrupt?: boolean;
  canResolveApproval?: boolean;
  approvalDecisions?: Array<"allow" | "deny" | "skip">;
  fileLinks?: boolean;
  instanceId: string;
  isLatest?: boolean;
  responseContent?: string;
  showQueue?: boolean;
  retryWarning?: string;
  providerTurnId?: string;
  turnId?: string;
  turnStartedAt?: string;
  turnEndedAt?: string;
  session: AiSessionSummary;
  tone?: "detail" | "board";
  activities?: AiSessionTimelineActivity[];
  activityNodes?: TimelineTurnNode[];
  activityHistory?: TimelineTurnNode[];
  activityHistoryStatus?: "idle" | "loading" | "ready" | "stale" | "error";
  activityHistoryError?: string;
  activityError?: string;
  activityInteractive?: boolean;
  activityLoading?: boolean;
}>(), {
  busy: false,
  canInterrupt: false,
  canResolveApproval: false,
  approvalDecisions: () => ["allow", "deny", "skip"],
  fileLinks: false,
  isLatest: false,
  responseContent: "",
  showQueue: false,
  retryWarning: "",
  tone: "detail",
  activities: () => [],
  activityNodes: () => [],
  activityHistory: () => [],
  activityHistoryStatus: "ready",
  activityHistoryError: "",
  activityError: "",
  activityInteractive: false,
  activityLoading: false,
});

const emit = defineEmits<{
  editQueuedMessage: [payload: { queueId: string; message: string }];
  openFile: [href: string];
  removeQueuedMessage: [queueId: string];
  reorderQueuedMessages: [payload: { expectedRevision: number; queueIds: string[] }];
  resolveApproval: [decision: "allow" | "deny" | "skip"];
  retryQueuedMessage: [queueId: string];
  steerQueuedMessage: [queueId: string];
  layoutWillChange: [element: HTMLElement];
  layoutCommitted: [element: HTMLElement];
  loadActivityHistory: [];
  retryActivityHistory: [];
}>();

const retryWarningFirstLine = computed(() => props.retryWarning.split(/\r\n|\r|\n/, 1)[0]);
const active = computed(() => props.isLatest && (props.session.status === "running" || props.session.status === "waiting"));
const turnElement = ref<HTMLElement>();
const turnContentElement = ref<HTMLElement>();
const turnMinHeight = ref(0);
const turnHeightBuffer = createLatestTurnHeightBuffer(100);
let turnResizeObserver: ResizeObserver | undefined;

function bufferLatestTurnHeight() {
  const content = turnContentElement.value;
  const enabled = props.isLatest && props.tone === "detail";
  turnMinHeight.value = content
    ? turnHeightBuffer.update(content.getBoundingClientRect().height, enabled)
    : 0;
}

function observeTurnHeight() {
  turnResizeObserver?.disconnect();
  turnResizeObserver = undefined;
  const content = turnContentElement.value;
  if (!content) {
    turnMinHeight.value = 0;
    return;
  }
  bufferLatestTurnHeight();
  if (typeof ResizeObserver !== "undefined") {
    turnResizeObserver = new ResizeObserver(bufferLatestTurnHeight);
    turnResizeObserver.observe(content);
  }
}

watch(turnContentElement, () => void nextTick(observeTurnHeight), { flush: "post" });
watch(() => [props.isLatest, props.tone] as const, () => {
  turnHeightBuffer.reset();
  turnMinHeight.value = 0;
  void nextTick(observeTurnHeight);
});
onBeforeUnmount(() => turnResizeObserver?.disconnect());
onBeforeUpdate(() => {
  if (props.isLatest && props.tone === "detail" && turnElement.value) {
    emit("layoutWillChange", turnElement.value);
  }
});
onUpdated(() => {
  if (props.isLatest && props.tone === "detail" && turnElement.value) {
    emit("layoutCommitted", turnElement.value);
  }
});

const streamingMessages = useStreamingMessagesStore();
const streamingContent = computed(() => {
  const activeMessage = props.isLatest
    ? streamingMessages.activeMessage(props.instanceId, props.session.id).value?.value
    : undefined;
  return messageMatchesTurn(activeMessage, { id: props.turnId, providerTurnId: props.providerTurnId })
    ? activeMessage!.receivedText
    : "";
});
const displayContent = computed(() => streamingContent.value || props.responseContent);
</script>

<style scoped>
.ai-session-result {
  --detail-activity-gap: 16px;
  --detail-response-line-height: 1.55;
  --detail-activity-border: var(--line-subtle);
  --detail-activity-surface: var(--surface-subtle);
  --detail-activity-text: var(--text);
  --detail-activity-strong: var(--text-strong);
  --detail-activity-muted: var(--text-muted);
  --detail-activity-danger: var(--status-danger);
  --detail-action-bg: var(--surface-raised);
  display: grid;
  align-content: start;
  min-width: 0;
}

.ai-session-result-content {
  display: grid;
  align-content: start;
  gap: var(--detail-activity-gap);
  min-width: 0;
}

.ai-session-result-detail .ai-session-result-content {
  gap: 0;
}

.ai-session-result-detail > .ai-session-result-content > * {
  margin-top: 0;
}

.ai-session-result-detail > .ai-session-result-content > * + * {
  margin-top: var(--detail-activity-gap);
}

.ai-session-retry-warning {
  background: var(--status-warning-bg);
  border: 1px solid color-mix(in srgb, var(--status-warning) 40%, var(--line-subtle));
  border-radius: 8px;
  color: var(--status-warning);
}

.ai-session-retry-warning > summary {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: flex-start;
  padding: 12px 14px;
  cursor: pointer;
  list-style: none;
  user-select: none;
}

.ai-session-retry-warning > summary::-webkit-details-marker { display: none; }

.ai-session-retry-warning > summary > svg:first-child { margin-top: 1px; }

.ai-session-retry-warning > summary > div {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.ai-session-retry-warning-chevron {
  align-self: center;
  transition: transform 120ms ease;
}

.ai-session-retry-warning[open] .ai-session-retry-warning-chevron { transform: rotate(90deg); }

.ai-session-retry-warning strong {
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
}

.ai-session-retry-warning p {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 400;
  line-height: 1.55;
  margin: 0;
}

.ai-session-retry-warning-preview {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-session-retry-warning-detail {
  display: none;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.ai-session-retry-warning[open] .ai-session-retry-warning-preview { display: none; }
.ai-session-retry-warning[open] .ai-session-retry-warning-detail { display: block; }

.ai-session-result-detail :slotted(.ai-session-turn-actions) {
  margin-top: 8px;
}

.ai-session-result-board {
  --detail-activity-gap: 8px;
  --detail-response-line-height: 1.5;
  --detail-activity-border: var(--ai-board-column-border);
  --detail-activity-surface: var(--ai-board-card-bg);
  --detail-activity-text: var(--ai-board-title);
  --detail-activity-strong: var(--ai-board-title);
  --detail-activity-muted: var(--ai-board-muted);
  --detail-activity-danger: var(--ai-board-card-failed-border);
  --detail-action-bg: var(--ai-board-floating-bg);
  padding-top: 4px;
}

.ai-session-detail-response {
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--detail-activity-strong);
  font-size: 14px;
  line-height: var(--detail-response-line-height);
  padding-bottom: 12px;
}

.ai-session-result-detail .ai-session-detail-response {
  margin-inline: -10px;
  padding-inline: 10px;
  padding-bottom: 0;
}

.ai-session-result-board .ai-session-detail-response {
  margin-inline: -14px;
  padding-inline: 14px;
}

.ai-session-detail-response-active {
  padding-bottom: 4px;
}

.ai-session-result-detail .ai-session-detail-response-active {
  padding-bottom: 0;
}

.ai-session-detail-response :deep(.ai-session-streaming-markdown),
.ai-session-detail-response :deep(.markstream-vue) {
  color: var(--detail-activity-strong);
  font-size: 14px;
  font-weight: 400;
  line-height: var(--detail-response-line-height);
  overflow-wrap: anywhere;
  white-space: normal;
}

.ai-session-result-board :deep(.ai-session-tool-activity) {
  margin-top: 0;
}

.ai-session-result-board.has-response .ai-session-detail-response + :deep(.ai-session-tool-activity) {
  margin-top: calc(-1 * var(--detail-activity-gap));
}

.ai-session-detail-approval {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.ai-session-detail-approval button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 30px;
  border: 1px solid var(--detail-activity-border);
  border-radius: 7px;
  background: var(--detail-action-bg);
  color: var(--detail-activity-text);
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
  padding: 0 10px;
}

.ai-session-detail-approval button:hover,
.ai-session-detail-approval button:focus-visible {
  border-color: var(--focus-ring, var(--detail-activity-strong));
  color: var(--detail-activity-strong);
  outline: none;
}

.ai-session-detail-approval button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>
