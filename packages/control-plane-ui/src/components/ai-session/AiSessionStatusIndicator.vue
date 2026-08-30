<template>
  <span
    class="ai-session-status-indicator"
    :data-size="size"
    :data-state="status"
    aria-hidden="true"
  >
    <span v-if="status === 'running'" class="ai-session-status-indicator__spinner" />
    <span v-else class="ai-session-status-indicator__dot" />
  </span>
</template>

<script setup lang="ts">
import type { AiSessionStatus } from "@task-handoff/protocol/ai-sessions";

withDefaults(defineProps<{
  size?: "compact" | "default";
  status: AiSessionStatus["status"];
}>(), {
  size: "default",
});
</script>

<style scoped>
.ai-session-status-indicator {
  display: inline-grid;
  place-items: center;
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  vertical-align: middle;
}

.ai-session-status-indicator[data-size="compact"] {
  width: 12px;
  height: 12px;
}

.ai-session-status-indicator__spinner {
  position: relative;
  display: block;
  box-sizing: border-box;
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--ai-session-running-track);
  border-radius: 50%;
  color: var(--ai-session-running-indicator);
}

.ai-session-status-indicator__spinner::after {
  position: absolute;
  inset: -1.5px;
  box-sizing: border-box;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  content: "";
  animation: ai-session-status-spin 1600ms linear infinite;
}

.ai-session-status-indicator[data-size="compact"] .ai-session-status-indicator__spinner {
  width: 12px;
  height: 12px;
}

.ai-session-status-indicator__dot {
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--ai-session-status-dot, var(--brand-accent));
  box-shadow: var(--ai-session-status-dot-shadow, 0 0 0 3px var(--brand-accent-soft));
}

.ai-session-status-indicator[data-size="compact"] .ai-session-status-indicator__dot {
  width: 6px;
  height: 6px;
  box-shadow: var(--ai-session-status-dot-compact-shadow, 0 0 0 2px var(--brand-accent-soft));
}

.ai-session-status-indicator[data-state="waiting"] .ai-session-status-indicator__dot {
  background: var(--ai-session-status-waiting, var(--status-warning));
  box-shadow: var(--ai-session-status-waiting-shadow, 0 0 0 3px var(--status-warning-bg));
}

.ai-session-status-indicator[data-size="compact"][data-state="waiting"] .ai-session-status-indicator__dot {
  box-shadow: 0 0 0 2px var(--status-warning-bg);
}

.ai-session-status-indicator[data-state="failed"] .ai-session-status-indicator__dot {
  background: var(--ai-session-status-failed, var(--status-danger));
  box-shadow: var(--ai-session-status-failed-shadow, 0 0 0 3px var(--status-danger-bg));
}

.ai-session-status-indicator[data-size="compact"][data-state="failed"] .ai-session-status-indicator__dot {
  box-shadow: 0 0 0 2px var(--status-danger-bg);
}

.ai-session-status-indicator[data-state="idle"] .ai-session-status-indicator__dot {
  background: var(--ai-session-status-idle, var(--text-subtle));
  box-shadow: var(--ai-session-status-idle-shadow, 0 0 0 3px var(--surface-subtle));
}

.ai-session-status-indicator[data-size="compact"][data-state="idle"] {
  visibility: hidden;
}

@keyframes ai-session-status-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .ai-session-status-indicator__spinner::after { animation: none; }
}
</style>
