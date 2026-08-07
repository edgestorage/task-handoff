<template>
  <div
    class="ai-session-result"
    :class="[
      `ai-session-result-${tone}`,
      { 'has-response': displayContent },
    ]"
  >
    <section
      v-show="displayContent"
      class="ai-session-detail-response"
      :class="{ 'ai-session-detail-response-active': session.status === 'running' || session.status === 'waiting' }"
    >
      <AiSessionStreamingMarkdown
        :content="responseContent"
        :file-links="fileLinks"
        :instance-id="instanceId"
        :is-latest="isLatest"
        :session-id="session.id"
        @open-file="$emit('openFile', $event)"
      />
    </section>

    <AiSessionToolActivity
      v-if="isLatest"
      :current-tool="session.currentTool"
      :phase="session.phase"
      :status="session.status"
      :summary="session.summary"
      :tool-calls-since-last-message="session.toolCallsSinceLastMessage"
      :tone="tone"
    />

    <AiSessionSubAgents
      v-if="session.subAgents?.length"
      :sub-agents="session.subAgents"
    />

    <section v-if="session.queue?.items.length" class="ai-session-detail-queue">
      <span class="ai-session-detail-queue-label">{{ t("sessions.activity.queue", { count: session.queue.pendingCount }) }}</span>
      <ScrollArea class="ai-session-detail-queue-list" :horizontal="false">
        <article
          v-for="item in session.queue.items"
          :key="item.id"
          class="ai-session-detail-queue-item"
          :data-state="item.status"
        >
          <GripVertical class="ai-session-detail-queue-icon" :size="17" :stroke-width="1.8" />
          <div class="ai-session-detail-queue-copy">
            <p>{{ item.message }}</p>
            <small v-if="item.error">{{ item.error }}</small>
          </div>
          <div class="ai-session-detail-queue-actions">
            <button type="button" :disabled="busy || !canInterrupt" :title="t('sessions.activity.steer')" @click="$emit('steerQueuedMessage', item.id)">
              <CornerDownRight :size="15" />
              <span>{{ t("sessions.activity.steer") }}</span>
            </button>
            <button v-if="item.status === 'failed'" type="button" :disabled="busy" :aria-label="t('sessions.activity.retry')" :title="t('sessions.activity.retry')" @click="$emit('retryQueuedMessage', item.id)">
              <RotateCcw :size="15" />
            </button>
            <button type="button" class="ai-session-detail-queue-remove" :disabled="busy" :aria-label="t('sessions.activity.remove')" :title="t('sessions.activity.remove')" @click="$emit('removeQueuedMessage', item.id)">
              <Trash2 :size="15" />
            </button>
          </div>
        </article>
      </ScrollArea>
    </section>

    <div v-if="canResolveApproval" class="ai-session-detail-approval">
      <button type="button" :disabled="busy" @click="$emit('resolveApproval', 'allow')">
        <Check :size="14" />
        <span>{{ t("sessions.actions.allow") }}</span>
      </button>
      <button type="button" :disabled="busy" @click="$emit('resolveApproval', 'skip')">
        <Ban :size="14" />
        <span>{{ t("sessions.actions.skip") }}</span>
      </button>
      <button type="button" :disabled="busy" @click="$emit('resolveApproval', 'deny')">
        <X :size="14" />
        <span>{{ t("sessions.actions.deny") }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Ban, Check, CornerDownRight, GripVertical, RotateCcw, Trash2, X } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { AiSessionSummary } from "../../api/types";
import { useStreamingMessagesStore } from "../../apps/control-plane/useStreamingMessagesStore";
import { ScrollArea } from "../ui/scroll-area";
import AiSessionStreamingMarkdown from "./AiSessionStreamingMarkdown.vue";
import AiSessionSubAgents from "./AiSessionSubAgents.vue";
import AiSessionToolActivity from "./AiSessionToolActivity.vue";

const { t } = useI18n();

const props = withDefaults(defineProps<{
  busy?: boolean;
  canInterrupt?: boolean;
  canResolveApproval?: boolean;
  fileLinks?: boolean;
  instanceId: string;
  isLatest?: boolean;
  responseContent?: string;
  session: AiSessionSummary;
  tone?: "detail" | "board";
}>(), {
  busy: false,
  canInterrupt: false,
  canResolveApproval: false,
  fileLinks: false,
  isLatest: false,
  responseContent: "",
  tone: "detail",
});

defineEmits<{
  openFile: [href: string];
  removeQueuedMessage: [queueId: string];
  resolveApproval: [decision: "allow" | "deny" | "skip"];
  retryQueuedMessage: [queueId: string];
  steerQueuedMessage: [queueId: string];
}>();

const streamingMessages = useStreamingMessagesStore();
const streamingContent = computed(() => props.isLatest
  ? streamingMessages.activeMessage(props.instanceId, props.session.id).value?.value.receivedText || ""
  : "");
const displayContent = computed(() => streamingContent.value || props.responseContent);
</script>

<style scoped>
.ai-session-result {
  --detail-activity-gap: 12px;
  --detail-response-line-height: 1.55;
  --detail-activity-border: var(--line-subtle);
  --detail-activity-surface: var(--surface-subtle);
  --detail-activity-text: var(--text);
  --detail-activity-strong: var(--text-strong);
  --detail-activity-muted: var(--text-muted);
  --detail-activity-danger: var(--status-danger);
  --detail-action-bg: var(--surface-raised);
  display: grid;
  gap: var(--detail-activity-gap);
  min-width: 0;
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
  padding-bottom: 12px;
}

.ai-session-result-detail .ai-session-detail-response {
  margin-inline: -10px;
  padding-inline: 10px;
}

.ai-session-result-board .ai-session-detail-response {
  margin-inline: -14px;
  padding-inline: 14px;
}

.ai-session-detail-response-active {
  padding-bottom: 4px;
}

.ai-session-detail-response :deep(> div) {
  color: var(--detail-activity-strong);
  font-size: 14px;
  font-weight: 400;
  line-height: var(--detail-response-line-height);
  overflow-wrap: anywhere;
  white-space: normal;
}

.ai-session-result :deep(.ai-session-tool-activity) {
  margin-top: 0;
}

.ai-session-result.has-response .ai-session-detail-response + :deep(.ai-session-tool-activity) {
  margin-top: calc(-1 * var(--detail-activity-gap));
}

.ai-session-detail-queue {
  min-width: 0;
}

.ai-session-detail-queue-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  clip-path: inset(50%);
}

.ai-session-detail-queue-list {
  max-height: 220px;
  border: 1px solid var(--detail-activity-border);
  border-radius: 10px;
  background: var(--detail-action-bg);
}

.ai-session-detail-queue-item {
  display: grid;
  grid-template-columns: 17px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-width: 0;
  min-height: 42px;
  padding: 7px 9px;
}

.ai-session-detail-queue-item + .ai-session-detail-queue-item {
  border-top: 1px solid var(--detail-activity-border);
}

.ai-session-detail-queue-icon {
  color: var(--detail-activity-muted);
}

.ai-session-detail-queue-item[data-state="failed"] .ai-session-detail-queue-icon {
  color: var(--detail-activity-danger);
}

.ai-session-detail-queue-copy {
  min-width: 0;
}

.ai-session-detail-queue-item p {
  margin: 0;
  color: var(--detail-activity-text);
  font-size: 13px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.ai-session-detail-queue-item small {
  color: var(--detail-activity-muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.ai-session-detail-queue-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.ai-session-detail-queue-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 28px;
  min-height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--detail-activity-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 0 5px;
}

.ai-session-detail-queue-actions button:hover {
  background: var(--detail-activity-surface);
  color: var(--detail-activity-strong);
}

.ai-session-detail-queue-actions button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--focus-ring, var(--detail-activity-strong));
}

.ai-session-detail-queue-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ai-session-detail-queue-actions .ai-session-detail-queue-remove:hover {
  background: color-mix(in srgb, var(--detail-activity-danger) 12%, transparent);
  color: var(--detail-activity-danger);
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
