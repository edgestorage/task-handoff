<template>
  <section v-if="goal" class="ai-session-goal" :data-state="goal.status" :data-tone="tone">
    <Target class="ai-session-goal-icon" :size="16" aria-hidden="true" />
    <span class="ai-session-goal-label">{{ t("sessions.goal.label") }}</span>
    <span class="ai-session-goal-status">{{ statusLabel }}</span>
    <TooltipProvider :delay-duration="120">
      <Tooltip>
        <TooltipTrigger as-child>
          <p class="ai-session-goal-objective">{{ goal.objective }}</p>
        </TooltipTrigger>
        <TooltipContent class="ai-session-goal-tooltip" side="bottom" :side-offset="8" align="start">
          <p>{{ goal.objective }}</p>
          <small v-if="usageLabel">{{ usageLabel }}</small>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <span v-if="usageLabel" class="ai-session-goal-usage">{{ usageLabel }}</span>
    <div class="ai-session-goal-actions">
      <button type="button" :disabled="disabled" :aria-label="canResume ? t('sessions.goal.resume') : t('sessions.goal.pause')" :title="canResume ? t('sessions.goal.resume') : t('sessions.goal.pause')" @click="$emit('command', canResume ? 'resume' : 'pause')">
        <Play v-if="canResume" :size="14" />
        <Pause v-else :size="14" />
      </button>
      <button type="button" class="ai-session-goal-clear" :disabled="disabled" :aria-label="t('sessions.goal.clear')" :title="t('sessions.goal.clear')" @click="$emit('command', 'clear')">
        <Trash2 :size="14" />
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Pause, Play, Target, Trash2 } from "@lucide/vue";
import type { AiSessionGoal } from "@task-handoff/protocol/ai-sessions";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

const props = withDefaults(defineProps<{
  goal?: AiSessionGoal | null;
  disabled?: boolean;
  tone?: "detail" | "board";
}>(), {
  disabled: false,
  tone: "detail",
});

defineEmits<{
  command: [argument: "pause" | "resume" | "clear"];
}>();

const { t, locale } = useI18n();

const canResume = computed(() => Boolean(props.goal) && props.goal?.status !== "active");

const statusLabel = computed(() => props.goal
  ? t(`sessions.goal.status.${props.goal.status}`)
  : "");

function formatNumber(value: number) {
  return value.toLocaleString(locale.value);
}

const durationLabel = computed(() => {
  const seconds = Math.max(0, Math.floor(props.goal?.timeUsedSeconds ?? 0));
  if (!seconds) return "";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return [
    hours ? t("sessions.goal.hours", { count: hours }) : "",
    minutes ? t("sessions.goal.minutes", { count: minutes }) : "",
    remainingSeconds ? t("sessions.goal.seconds", { count: remainingSeconds }) : "",
  ].filter(Boolean).join(" ");
});

const usageLabel = computed(() => {
  const goal = props.goal;
  if (!goal) return "";
  const tokens = goal.tokenBudget === null
    ? t("sessions.goal.tokenUsage", { used: formatNumber(goal.tokensUsed) })
    : t("sessions.goal.budgetUsage", {
      used: formatNumber(goal.tokensUsed),
      budget: formatNumber(goal.tokenBudget),
    });
  return [tokens, durationLabel.value].filter(Boolean).join(" · ");
});
</script>

<style scoped>
.ai-session-goal {
  --goal-border: var(--line-subtle);
  --goal-surface: var(--surface-raised);
  --goal-hover: var(--surface-subtle);
  --goal-text: var(--text);
  --goal-strong: var(--text-strong);
  --goal-muted: var(--text-muted);
  --goal-danger: var(--status-danger);
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 40px;
  border: 1px solid var(--goal-border);
  border-radius: var(--ai-session-goal-radius, 10px);
  background: var(--goal-surface);
  color: var(--goal-text);
  padding: 5px 10px;
}

.ai-session-goal[data-tone="board"] {
  --goal-border: var(--ai-board-column-border);
  --goal-surface: var(--ai-board-floating-bg);
  --goal-hover: var(--ai-board-card-bg);
  --goal-text: var(--ai-board-title);
  --goal-strong: var(--ai-board-title);
  --goal-muted: var(--ai-board-muted);
  --goal-danger: var(--ai-board-card-failed-border);
}

.ai-session-goal-icon {
  color: var(--status-info);
}

.ai-session-goal-label {
  flex: 0 0 auto;
  color: var(--goal-strong);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
}

.ai-session-goal-status {
  flex: 0 0 auto;
  color: var(--goal-muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
}

.ai-session-goal-status::before {
  content: "·";
  margin-right: 6px;
  color: var(--goal-muted);
  font-weight: 400;
}

.ai-session-goal-usage {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 38%;
  overflow: hidden;
  color: var(--goal-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-session-goal-objective {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  margin: 0;
  color: var(--goal-text);
  cursor: default;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-session-goal-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.ai-session-goal-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--goal-muted);
  cursor: pointer;
  padding: 0;
}

.ai-session-goal-actions button:hover {
  background: var(--goal-hover);
  color: var(--goal-strong);
}

.ai-session-goal-actions button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--focus-ring, var(--goal-strong));
}

.ai-session-goal-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ai-session-goal-actions .ai-session-goal-clear:hover {
  background: color-mix(in srgb, var(--goal-danger) 12%, transparent);
  color: var(--goal-danger);
}

.ai-session-goal[data-state="paused"] .ai-session-goal-icon,
.ai-session-goal[data-state="usageLimited"] .ai-session-goal-icon {
  color: var(--status-warning);
}

.ai-session-goal[data-state="blocked"] .ai-session-goal-icon,
.ai-session-goal[data-state="budgetLimited"] .ai-session-goal-icon {
  color: var(--status-danger);
}

.ai-session-goal[data-state="complete"] .ai-session-goal-icon {
  color: var(--status-success);
}

@media (max-width: 720px) {
  .ai-session-goal-usage {
    display: none;
  }
}

:global(.ai-session-goal-tooltip) {
  display: grid;
  max-width: min(360px, calc(100vw - 24px));
  gap: 6px;
}

:global(.ai-session-goal-tooltip p) {
  margin: 0;
  color: var(--text);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

:global(.ai-session-goal-tooltip small) {
  color: var(--text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
</style>
