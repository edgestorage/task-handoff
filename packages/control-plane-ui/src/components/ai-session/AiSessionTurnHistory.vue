<template>
  <div v-if="loading && !nodes.length" class="ai-session-turn-history-status" aria-busy="true">
    <LoaderCircle class="ai-session-turn-history-loading-icon" :size="15" aria-hidden="true" />
    <span>{{ t("sessions.timeline.earlierProcessLoading") }}</span>
  </div>
  <button v-else-if="error && !nodes.length" type="button" class="ai-session-turn-history-status ai-session-turn-history-retry" @click="$emit('retry')">
    <ChevronRight :size="15" />
    <span>{{ t("sessions.timeline.earlierProcessFailed") }}</span>
  </button>
  <details v-else-if="nodes.length" class="ai-session-turn-history">
    <summary>
      <ChevronRight :size="15" />
      <span>{{ t("sessions.timeline.earlierProcess") }}</span>
    </summary>
    <div class="ai-session-turn-history-content">
      <template v-for="node in nodes" :key="node.id">
        <article
          v-if="node.type === 'message'"
          class="ai-session-turn-history-message"
          :class="{ 'ai-session-turn-history-message-user': node.message.type === 'user-message' }"
        >
          <MarkdownContent :content="node.message.text" :code-tools="markdownCodeTools" />
        </article>
        <AiSessionActivityGroup v-else :activities="node.activities" />
      </template>
    </div>
  </details>
  <div v-else class="ai-session-turn-history-status ai-session-turn-history-empty">
    <Minus :size="15" aria-hidden="true" />
    <span>{{ t("sessions.timeline.noEarlierProcess") }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronRight, LoaderCircle, Minus } from "@lucide/vue";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import type { TimelineTurnNode } from "./timelineActivities";
import AiSessionActivityGroup from "./AiSessionActivityGroup.vue";

defineProps<{ nodes: TimelineTurnNode[]; loading?: boolean; error?: string }>();
defineEmits<{ retry: [] }>();
const { t } = useI18n();
const markdownCodeTools = computed(() => ({
  copiedLabel: t("sessions.markdown.copied"),
  copyLabel: t("sessions.markdown.copy"),
  plainTextLabel: t("sessions.markdown.plainText"),
}));
</script>

<style scoped>
.ai-session-turn-history { min-width: 0; color: var(--text-muted); }
.ai-session-turn-history-status {
  display: flex;
  align-items: center;
  gap: 5px;
  width: fit-content;
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--text-muted);
  font: inherit;
  font-size: 14px;
  line-height: inherit;
}
.ai-session-turn-history-retry { cursor: pointer; }
.ai-session-turn-history-loading-icon { animation: ai-session-turn-history-spin 800ms linear infinite; }
.ai-session-turn-history > summary {
  display: flex;
  align-items: center;
  gap: 5px;
  width: fit-content;
  cursor: pointer;
  list-style: none;
  font-size: 14px;
  font-weight: 400;
}
.ai-session-turn-history > summary::-webkit-details-marker { display: none; }
.ai-session-turn-history > summary svg { transition: transform 120ms ease; }
.ai-session-turn-history[open] > summary svg { transform: rotate(90deg); }
.ai-session-turn-history-content {
  display: grid;
  gap: 6px;
  margin: 6px 0 0 7px;
  padding-left: 12px;
  border-left: 1px solid var(--line-subtle);
}
.ai-session-turn-history-message { color: var(--text); font-size: 14px; line-height: 1.55; }
.ai-session-turn-history-message-user {
  justify-self: end;
  width: fit-content;
  max-width: min(78%, 620px);
  border-radius: 14px;
  background: var(--surface-hover);
  padding: 12px 14px;
}
.ai-session-turn-history-message :deep(.markdown-content),
.ai-session-turn-history-message :deep(.markdown-content > *) { max-width: 100%; overflow-wrap: anywhere; }
@keyframes ai-session-turn-history-spin { to { transform: rotate(360deg); } }
</style>
