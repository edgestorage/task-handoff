<template>
  <div class="ai-session-highlighted-code" v-html="html" @click="handleMarkdownCodeCopy" />
</template>

<script setup lang="ts">
import { computed, inject } from "vue";
import { handleMarkdownCodeCopy, renderCodeBlock } from "@task-handoff/web-theme/markdown";
import { aiSessionMarkdownCodeToolsKey, defaultAiSessionMarkdownCodeTools } from "./markdown-code-tools";

const props = defineProps<{
  node: {
    code?: unknown;
    language?: unknown;
    raw?: unknown;
  };
}>();
const codeTools = inject(aiSessionMarkdownCodeToolsKey, computed(() => defaultAiSessionMarkdownCodeTools));

const html = computed(() => renderCodeBlock(
  props.node.code ?? props.node.raw,
  props.node.language,
  codeTools.value,
));
</script>

<style scoped>
.ai-session-highlighted-code {
  margin: 0.75em 0;
}

.ai-session-highlighted-code :deep(.markdown-code-block) {
  max-width: 100%;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--line, transparent);
  border-radius: 7px;
  background: var(--surface-inset, rgb(127 127 127 / 14%));
}

.ai-session-highlighted-code :deep(.markdown-code-toolbar) {
  display: flex;
  min-height: 34px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-bottom: 1px solid var(--line, transparent);
  padding: 0 10px 0 12px;
  color: var(--text-muted, currentColor);
  font-size: 12px;
  line-height: 1;
}

.ai-session-highlighted-code :deep(.markdown-code-language) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-session-highlighted-code :deep(.markdown-code-copy) {
  min-height: 28px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 0 6px;
}

.ai-session-highlighted-code :deep(.markdown-code-copy:hover) {
  background: var(--surface-hover, rgb(127 127 127 / 12%));
  color: var(--text-strong, currentColor);
}

.ai-session-highlighted-code :deep(.markdown-code-copy:focus-visible) {
  outline: 2px solid var(--focus-ring, var(--brand-accent, currentColor));
  outline-offset: 1px;
}

.ai-session-highlighted-code :deep(.markdown-code-block > pre) {
  margin: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}
</style>
