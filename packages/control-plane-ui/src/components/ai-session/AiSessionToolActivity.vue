<template>
  <section
    v-if="visible"
    class="ai-session-tool-activity"
    :class="`ai-session-tool-activity-${tone}`"
    :aria-label="heading"
  >
    <span>{{ heading }}</span>
    <strong v-if="currentTool?.name">{{ currentTool.name }}</strong>
    <small v-if="currentTool?.inputPreview">{{ currentTool.inputPreview }}</small>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { AiSessionTool } from "../../api/types";

const props = withDefaults(defineProps<{
  currentTool?: AiSessionTool;
  toolCallsSinceLastMessage?: number;
  tone?: "detail" | "board";
}>(), {
  currentTool: undefined,
  toolCallsSinceLastMessage: 0,
  tone: "detail",
});

const count = computed(() => Math.max(0, props.toolCallsSinceLastMessage));
const visible = computed(() => Boolean(props.currentTool?.name) || count.value > 0);
const heading = computed(() => props.currentTool?.name
  ? `Current Tool · ${count.value}`
  : `Tools executed · ${count.value}`);
</script>

<style scoped>
.ai-session-tool-activity {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.ai-session-tool-activity > span,
.ai-session-tool-activity > small {
  color: var(--text-muted);
  font-size: 12px;
}

.ai-session-tool-activity > strong {
  color: var(--text-strong);
  font-size: 13px;
}

.ai-session-tool-activity > small {
  overflow-wrap: anywhere;
}

.ai-session-tool-activity-detail {
  border-top: 1px solid var(--line-subtle);
  padding-top: 10px;
}

.ai-session-tool-activity-board {
  gap: 7px;
  border-bottom: 1px solid var(--ai-board-column-border);
  padding-bottom: 12px;
}

.ai-session-tool-activity-board > span,
.ai-session-tool-activity-board > small {
  color: var(--ai-board-muted);
}

.ai-session-tool-activity-board > strong {
  color: var(--ai-board-title);
}
</style>
