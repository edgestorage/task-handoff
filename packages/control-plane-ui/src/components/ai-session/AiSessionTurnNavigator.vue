<template>
  <span v-if="count > 1" class="ai-session-turn-navigator" :data-tone="tone" role="group" :aria-label="ariaLabel || t('sessions.composer.navigation')">
    <TooltipProvider :delay-duration="120">
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" :aria-label="previousLabel || t('sessions.actions.previousMessage', { agent: 'AI' })" :disabled="index <= 0" @click="$emit('previous')">
            <ChevronLeft :size="13" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" :side-offset="8">{{ previousLabel || t('sessions.actions.previousMessage', { agent: 'AI' }) }}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
    <small>{{ index + 1 }} / {{ count }}</small>
    <TooltipProvider :delay-duration="120">
      <Tooltip>
        <TooltipTrigger as-child>
          <button type="button" :aria-label="nextLabel || t('sessions.actions.nextMessage', { agent: 'AI' })" :disabled="index >= count - 1" @click="$emit('next')">
            <ChevronRight :size="13" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" :side-offset="8">{{ nextLabel || t('sessions.actions.nextMessage', { agent: 'AI' }) }}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </span>
</template>

<script setup lang="ts">
import { ChevronLeft, ChevronRight } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

const { t } = useI18n();

withDefaults(defineProps<{
  ariaLabel?: string;
  count: number;
  index: number;
  nextLabel?: string;
  previousLabel?: string;
  tone?: "board" | "panel";
}>(), {
  ariaLabel: undefined,
  nextLabel: undefined,
  previousLabel: undefined,
  tone: "panel",
});

defineEmits<{
  next: [];
  previous: [];
}>();
</script>

<style scoped>
.ai-session-turn-navigator {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  height: 26px;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid var(--line-subtle);
  border-radius: 6px;
  background: var(--surface-overlay);
  color: var(--text-muted);
}

.ai-session-turn-navigator[data-tone="board"] {
  border-color: var(--ai-board-floating-border);
  background: var(--ai-board-floating-bg);
  color: var(--ai-board-floating-text);
}

.ai-session-turn-navigator button {
  display: grid;
  width: 26px;
  height: 24px;
  flex: 0 0 auto;
  place-items: center;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.ai-session-turn-navigator small {
  display: grid;
  align-self: stretch;
  width: max-content;
  min-width: 42px;
  place-items: center;
  border-right: 1px solid var(--line-subtle);
  border-left: 1px solid var(--line-subtle);
  box-sizing: border-box;
  color: inherit;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  padding: 0 8px;
  text-align: center;
  white-space: nowrap;
}

.ai-session-turn-navigator[data-tone="board"] small {
  border-color: var(--ai-board-floating-border);
  color: var(--ai-board-muted);
}

.ai-session-turn-navigator[data-tone="panel"] button:not(:disabled):hover,
.ai-session-turn-navigator[data-tone="panel"] button:not(:disabled):focus-visible {
  background: var(--brand-accent-soft);
  color: var(--text);
  outline: none;
}

.ai-session-turn-navigator[data-tone="board"] button:not(:disabled):hover,
.ai-session-turn-navigator[data-tone="board"] button:not(:disabled):focus-visible {
  background: var(--ai-board-turn-hover-bg);
  color: var(--ai-board-floating-hover-text);
  outline: none;
}

.ai-session-turn-navigator button:disabled {
  cursor: default;
  opacity: 0.32;
}
</style>
