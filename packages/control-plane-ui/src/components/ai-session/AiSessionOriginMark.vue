<template>
  <span
    v-if="creationSource === 'app-session'"
    class="ai-session-origin-mark"
    :aria-label="t('sessions.actions.openedFromTerminal')"
    :title="t('sessions.actions.openedFromTerminal')"
  >
    <SquareTerminal :size="17" aria-hidden="true" />
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
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 2;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  color: var(--text-muted);
  opacity: 0.38;
  pointer-events: none;
  transition: opacity 120ms ease;
}
</style>
