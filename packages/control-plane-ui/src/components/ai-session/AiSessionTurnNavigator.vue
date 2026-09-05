<template>
  <span
    v-if="count > 1"
    class="ai-session-turn-navigator"
    :data-tone="tone"
    :style="navigatorStyle"
    role="group"
    :aria-label="ariaLabel || t('sessions.composer.navigation')"
  >
    <span class="ai-session-turn-navigator__controls">
      <button type="button" :aria-label="previousLabel || t('sessions.actions.previousMessage', { agent: 'AI' })" :disabled="index <= 0" @click="$emit('previous')">
        <ChevronLeft :size="13" />
      </button>
      <small>{{ index + 1 }} / {{ count }}</small>
      <button type="button" :aria-label="nextLabel || t('sessions.actions.nextMessage', { agent: 'AI' })" :disabled="index >= count - 1" @click="$emit('next')">
        <ChevronRight :size="13" />
      </button>
    </span>
    <button
      v-if="latestVisible"
      ref="latestEl"
      type="button"
      class="ai-session-turn-navigator__latest"
      :aria-label="latestText"
      @click="$emit('latest')"
    >
      <SkipForward :size="13" />
      <span>{{ latestText }}</span>
    </button>
  </span>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ChevronLeft, ChevronRight, SkipForward } from "@lucide/vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const props = withDefaults(defineProps<{
  ariaLabel?: string;
  count: number;
  index: number;
  latestLabel?: string;
  nextLabel?: string;
  previousLabel?: string;
  tone?: "board" | "panel";
}>(), {
  ariaLabel: undefined,
  latestLabel: undefined,
  nextLabel: undefined,
  previousLabel: undefined,
  tone: "panel",
});

const latestVisible = computed(() => props.count > 1 && props.index < props.count - 1);
const latestText = computed(() => props.latestLabel || t("sessions.panel.backLatestTurn"));
const latestEl = ref<HTMLButtonElement>();
const latestWidth = ref(0);
const navigatorStyle = computed(() => ({
  "--ai-session-turn-latest-offset": latestVisible.value ? `${latestWidth.value / 2}px` : "0px",
}));
let latestResizeObserver: ResizeObserver | undefined;

function observeLatestWidth() {
  latestResizeObserver?.disconnect();
  latestResizeObserver = undefined;
  if (latestEl.value && typeof ResizeObserver !== "undefined") {
    latestResizeObserver = new ResizeObserver(() => {
      latestWidth.value = latestEl.value?.getBoundingClientRect().width || 0;
    });
    latestResizeObserver.observe(latestEl.value);
  }
  latestWidth.value = latestEl.value?.getBoundingClientRect().width || 0;
}

watch([latestVisible, latestText], () => void nextTick(observeLatestWidth), { immediate: true });

onBeforeUnmount(() => latestResizeObserver?.disconnect());

defineEmits<{
  latest: [];
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
  transform: translateX(calc(-50% + var(--ai-session-turn-latest-offset, 0px)));
}

.ai-session-turn-navigator[data-tone="board"] {
  border-color: var(--ai-board-floating-border);
  background: var(--ai-board-floating-bg);
  color: var(--ai-board-floating-text);
}

.ai-session-turn-navigator__controls {
  display: inline-flex;
  align-items: center;
  height: 24px;
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

.ai-session-turn-navigator button.ai-session-turn-navigator__latest {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: max-content;
  min-width: max-content;
  height: 24px;
  gap: 4px;
  border: 0;
  border-left: 1px solid var(--line-subtle);
  border-radius: 0;
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
  padding: 0 8px;
  font-size: 12px;
  white-space: nowrap;
}

.ai-session-turn-navigator[data-tone="board"] button.ai-session-turn-navigator__latest {
  border-left-color: var(--ai-board-floating-border);
  background: var(--ai-board-turn-hover-bg);
  color: var(--ai-board-active-text, var(--brand-accent));
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
