<template>
  <details v-if="nodes.length" class="ai-session-turn-history">
    <summary>
      <ChevronRight :size="15" />
      <span>{{ t("sessions.timeline.earlierProcess") }}</span>
    </summary>
    <div class="ai-session-turn-history-content">
      <template v-for="node in nodes" :key="node.id">
        <article v-if="node.type === 'message'" class="ai-session-turn-history-message">
          <MarkdownContent :content="node.message.text" :code-tools="markdownCodeTools" />
        </article>
        <AiSessionActivityGroup v-else :activities="node.activities" />
      </template>
    </div>
  </details>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronRight } from "@lucide/vue";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import type { TimelineTurnNode } from "./timelineActivities";
import AiSessionActivityGroup from "./AiSessionActivityGroup.vue";

defineProps<{ nodes: TimelineTurnNode[] }>();
const { t } = useI18n();
const markdownCodeTools = computed(() => ({
  copiedLabel: t("sessions.markdown.copied"),
  copyLabel: t("sessions.markdown.copy"),
  plainTextLabel: t("sessions.markdown.plainText"),
}));
</script>

<style scoped>
.ai-session-turn-history { min-width: 0; color: var(--text-muted); }
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
.ai-session-turn-history-message :deep(.markdown-content),
.ai-session-turn-history-message :deep(.markdown-content > *) { max-width: 100%; overflow-wrap: anywhere; }
</style>
