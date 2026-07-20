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
        :instance-id="instanceId"
        :is-latest="isLatest"
        :session-id="session.id"
      />
    </section>

    <section v-if="contextCompactions.length" class="ai-session-context-compactions" aria-live="polite">
      <div
        v-for="compaction in contextCompactions"
        :key="compaction.id"
        class="ai-session-context-compaction"
        :data-state="compaction.status"
      >
        <Minimize2 :size="14" />
        <span>{{ compaction.status === "completed" ? "Context compacted" : "Compacting context…" }}</span>
      </div>
    </section>

    <AiSessionToolActivity
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
      <span>Queue · {{ session.queue.pendingCount }}</span>
      <div class="ai-session-detail-queue-list">
        <article
          v-for="item in session.queue.items"
          :key="item.id"
          class="ai-session-detail-queue-item"
          :data-state="item.status"
        >
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

    <div v-if="canResolveApproval" class="ai-session-detail-approval">
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
</template>

<script setup lang="ts">
import { Ban, Check, Minimize2, X } from "@lucide/vue";
import { computed } from "vue";
import type { AiSessionContextCompaction } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionSummary } from "../../api/types";
import { useStreamingMessagesStore } from "../../apps/control-plane/useStreamingMessagesStore";
import AiSessionStreamingMarkdown from "./AiSessionStreamingMarkdown.vue";
import AiSessionSubAgents from "./AiSessionSubAgents.vue";
import AiSessionToolActivity from "./AiSessionToolActivity.vue";

const props = withDefaults(defineProps<{
  busy?: boolean;
  canInterrupt?: boolean;
  canResolveApproval?: boolean;
  contextCompactions?: AiSessionContextCompaction[];
  instanceId: string;
  isLatest?: boolean;
  responseContent?: string;
  session: AiSessionSummary;
  tone?: "detail" | "board";
}>(), {
  busy: false,
  canInterrupt: false,
  canResolveApproval: false,
  contextCompactions: () => [],
  isLatest: false,
  responseContent: "",
  tone: "detail",
});

defineEmits<{
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

.ai-session-context-compactions {
  display: grid;
  gap: 6px;
}

.ai-session-context-compaction {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--detail-activity-muted);
  font-size: 12px;
  line-height: 1.4;
}

.ai-session-context-compaction[data-state="running"] svg {
  animation: context-compaction-pulse 1.2s ease-in-out infinite;
}

@keyframes context-compaction-pulse {
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .ai-session-context-compaction[data-state="running"] svg {
    animation: none;
  }
}

.ai-session-result.has-response .ai-session-detail-response + :deep(.ai-session-tool-activity) {
  margin-top: calc(-1 * var(--detail-activity-gap));
}

.ai-session-detail-queue {
  display: grid;
  gap: 7px;
  min-width: 0;
  border-bottom: 1px solid var(--detail-activity-border);
  padding-bottom: 12px;
}

.ai-session-detail-queue > span {
  color: var(--detail-activity-muted);
  font-size: 12px;
  font-weight: 800;
}

.ai-session-detail-queue-list {
  display: grid;
  gap: 8px;
}

.ai-session-detail-queue-item {
  display: grid;
  gap: 7px;
  min-width: 0;
  border: 1px solid var(--detail-activity-border);
  border-radius: 7px;
  background: var(--detail-activity-surface);
  padding: 9px;
}

.ai-session-detail-queue-item[data-state="failed"] {
  border-color: var(--detail-activity-danger);
}

.ai-session-detail-queue-item p {
  margin: 0;
  color: var(--detail-activity-text);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.ai-session-detail-queue-item small {
  color: var(--detail-activity-muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.ai-session-detail-queue-item div {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ai-session-detail-queue-item button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 26px;
  border: 1px solid var(--detail-activity-border);
  border-radius: 7px;
  background: transparent;
  color: var(--detail-activity-text);
  cursor: pointer;
  font-size: 11px;
  padding: 0 8px;
}

.ai-session-detail-queue-item button:hover,
.ai-session-detail-queue-item button:focus-visible {
  border-color: var(--focus-ring, var(--detail-activity-strong));
  color: var(--detail-activity-strong);
  outline: none;
}

.ai-session-detail-queue-item button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
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
