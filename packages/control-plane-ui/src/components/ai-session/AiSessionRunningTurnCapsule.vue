<template>
  <Transition name="ai-session-running-capsule">
    <button
      v-if="visible"
      type="button"
      class="ai-session-running-capsule"
      :data-tone="tone"
      :aria-label="label"
      :title="t('sessions.panel.backLatestTurn')"
      @click="$emit('latest')"
    >
      <AiSessionStatusIndicator class="ai-session-running-capsule__spinner" status="running" />
      <span>{{ label }}</span>
    </button>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { AiSessionSummary } from "../../api/types";
import { aiSessionTurns } from "../../apps/control-plane/useInstanceSessions";
import AiSessionStatusIndicator from "./AiSessionStatusIndicator.vue";
import { aiSessionActivityText } from "./aiSessionActivityText";

const props = withDefaults(defineProps<{
  promptCount: number;
  promptIndex: number;
  session?: AiSessionSummary;
  timelineMode: "compact" | "full";
  tone?: "board" | "panel";
}>(), {
  session: undefined,
  tone: "panel",
});

defineEmits<{
  latest: [];
}>();

const { t } = useI18n();
const latestTurnRunning = computed(() => {
  if (props.session?.status !== "running") return false;
  const latestTurn = aiSessionTurns(props.session).at(-1);
  return latestTurn ? latestTurn.status === "running" : true;
});
const visible = computed(() => props.timelineMode === "compact"
  && props.promptIndex < props.promptCount - 1
  && latestTurnRunning.value);
const label = computed(() => props.session ? aiSessionActivityText(props.session, t) : "");
</script>

<style scoped>
.ai-session-running-capsule {
  position: absolute;
  right: 0;
  bottom: calc(100% + 16px);
  left: 0;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  width: max-content;
  max-width: min(calc(100% - 40px), 360px);
  min-height: 32px;
  gap: 7px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-overlay) 90%, transparent);
  box-shadow: 0 4px 16px rgb(0 0 0 / 10%);
  color: var(--text-muted);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  cursor: pointer;
  font-size: 12px;
  font-weight: 400;
  line-height: 1;
  margin: 0 auto;
  padding: 0 12px 0 9px;
}

.ai-session-running-capsule[data-tone="board"] {
  border-color: var(--ai-board-floating-border, var(--ai-board-column-border));
  background: color-mix(in srgb, var(--ai-board-column-bg) 90%, transparent);
  color: var(--ai-board-muted);
  box-shadow: var(--ai-board-floating-shadow, 0 4px 16px rgb(0 0 0 / 24%));
}

.ai-session-running-capsule:hover {
  color: var(--text);
}

.ai-session-running-capsule[data-tone="board"]:hover {
  color: var(--ai-board-title);
}

.ai-session-running-capsule > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-session-running-capsule__spinner {
  flex: 0 0 auto;
}

.ai-session-running-capsule-enter-active,
.ai-session-running-capsule-leave-active {
  transition: opacity 120ms ease, transform 120ms ease;
}

.ai-session-running-capsule-enter-from,
.ai-session-running-capsule-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

</style>
