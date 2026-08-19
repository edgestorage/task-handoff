<template>
  <span
    v-if="creationSource === 'app-session'"
    class="ai-session-origin-mark"
    :aria-label="t('sessions.actions.openedFromTerminal')"
    :title="t('sessions.actions.openedFromTerminal')"
  >
    <SquareTerminal :size="14" aria-hidden="true" />
  </span>
</template>

<script setup lang="ts">
import { SquareTerminal } from "@lucide/vue";
import { useI18n } from "vue-i18n";

defineProps<{
  creationSource?: "ai-session" | "app-session";
}>();

const { t } = useI18n();
</script>

<style scoped>
.ai-session-origin-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: var(--text-muted);
  opacity: 0.38;
  transition: opacity 120ms ease;
}
</style>
