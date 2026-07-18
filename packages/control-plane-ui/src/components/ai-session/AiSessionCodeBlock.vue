<template>
  <div class="ai-session-highlighted-code" v-html="html" />
</template>

<script setup lang="ts">
import { computed } from "vue";
import { renderCodeBlock } from "@task-handoff/web-theme/markdown";

const props = defineProps<{
  node: {
    code?: unknown;
    language?: unknown;
    raw?: unknown;
  };
}>();

const html = computed(() => renderCodeBlock(
  props.node.code ?? props.node.raw,
  props.node.language,
));
</script>
