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
      <DropdownMenu v-model:open="pickerOpen">
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="ai-session-turn-navigator__index"
            :aria-label="pickerLabel"
            data-testid="ai-session-turn-picker-trigger"
          >
            <small>{{ index + 1 }} / {{ count }}</small>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent class="ai-session-turn-menu" align="center" :collision-padding="12" :side-offset="6">
          <div class="ai-session-turn-menu__search">
            <div class="ai-session-turn-menu__search-field">
              <Search :size="13" aria-hidden="true" />
              <Input
                v-model="turnQuery"
                class="ai-session-turn-menu__search-input"
                :placeholder="t('sessions.panel.searchTurns')"
                :aria-label="t('sessions.panel.searchTurns')"
                @keydown="handleSearchKeydown"
              />
            </div>
          </div>
          <ScrollArea ref="turnScrollEl" type="auto" :horizontal="false" class="ai-session-turn-menu__scroll">
            <p v-if="!filteredMenuItems.length" class="ai-session-turn-menu__empty">{{ t('sessions.panel.noMatchingTurns') }}</p>
            <div v-else class="ai-session-turn-menu__list" role="list">
              <DropdownMenuItem
                v-for="entry in filteredMenuItems"
                :key="entry.item.id"
                class="ai-session-turn-menu__item"
                :data-current="entry.index === index ? 'true' : undefined"
                :aria-current="entry.index === index ? 'true' : undefined"
                @select="$emit('select', entry.index)"
              >
                <span class="ai-session-turn-menu__number" aria-hidden="true">{{ entry.index + 1 }}</span>
                <span class="ai-session-turn-menu__copy">
                  <span class="ai-session-turn-menu__title">{{ entry.item.label }}</span>
                  <span v-if="entry.item.subtitle" class="ai-session-turn-menu__subtitle">{{ entry.item.subtitle }}</span>
                </span>
                <Check v-if="entry.index === index" :size="14" aria-hidden="true" />
              </DropdownMenuItem>
            </div>
          </ScrollArea>
        </DropdownMenuContent>
      </DropdownMenu>
      <button type="button" :aria-label="nextLabel || t('sessions.actions.nextMessage', { agent: 'AI' })" :disabled="index >= count - 1" @click="$emit('next')">
        <ChevronRight :size="13" />
      </button>
    </span>
    <button
      v-if="stableLatest || latestVisible"
      ref="latestEl"
      type="button"
      class="ai-session-turn-navigator__latest"
      :aria-label="latestText"
      :disabled="!latestVisible"
      :title="tone === 'panel' ? latestText : undefined"
      @click="$emit('latest')"
    >
      <SkipForward :size="13" />
      <span>{{ latestText }}</span>
    </button>
  </span>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Check, ChevronLeft, ChevronRight, Search, SkipForward } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";

const { t } = useI18n();

const props = withDefaults(defineProps<{
  ariaLabel?: string;
  count: number;
  index: number;
  items?: Array<{ id: string; label: string; subtitle?: string }>;
  latestLabel?: string;
  nextLabel?: string;
  previousLabel?: string;
  stableLatest?: boolean;
  tone?: "board" | "panel";
}>(), {
  ariaLabel: undefined,
  items: () => [],
  latestLabel: undefined,
  nextLabel: undefined,
  previousLabel: undefined,
  stableLatest: false,
  tone: "panel",
});

const emit = defineEmits<{
  latest: [];
  next: [];
  open: [];
  previous: [];
  select: [index: number];
}>();

const latestVisible = computed(() => props.count > 1 && props.index < props.count - 1);
const pickerOpen = ref(false);
const turnQuery = ref("");
const menuItems = computed(() => Array.from({ length: props.count }, (_, index) => (
  props.items[index] || { id: `turn-position-${index + 1}`, label: "" }
)));
const filteredMenuItems = computed(() => {
  const query = turnQuery.value.trim().toLocaleLowerCase();
  return menuItems.value
    .map((item, index) => ({ index, item }))
    .filter(({ item }) => !query || [item.label, item.subtitle]
      .some((value) => value?.toLocaleLowerCase().includes(query)));
});
const pickerLabel = computed(() => t("sessions.panel.chooseTurn", {
  count: props.count,
  index: props.index + 1,
}));
const latestText = computed(() => props.latestLabel || t("sessions.panel.backLatestTurn"));
const latestEl = ref<HTMLButtonElement>();
const turnScrollEl = ref<{ $el?: HTMLElement }>();
const latestWidth = ref(0);
let selectedScrollTimers: number[] = [];
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
watch(pickerOpen, (open) => {
  clearSelectedScrollTimers();
  if (!open) return;
  turnQuery.value = "";
  emit("open");
  void nextTick(scheduleSelectedScroll);
});
watch(turnQuery, () => void nextTick(() => {
  if (turnQuery.value.trim()) scrollMenuToTop();
  else scrollSelectedIntoView(0);
}));

function handleSearchKeydown(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.key === "Escape") {
    event.preventDefault();
    pickerOpen.value = false;
  }
}

function scrollViewport() {
  return turnScrollEl.value?.$el?.querySelector<HTMLElement>("[data-task-handoff-scroll-viewport]");
}

function scrollMenuToTop() {
  const viewport = scrollViewport();
  if (viewport) viewport.scrollTop = 0;
}

function clearSelectedScrollTimers() {
  for (const timer of selectedScrollTimers) window.clearTimeout(timer);
  selectedScrollTimers = [];
}

function scheduleSelectedScroll() {
  clearSelectedScrollTimers();
  for (const delay of [0, 48, 160, 320]) {
    selectedScrollTimers.push(window.setTimeout(() => scrollSelectedIntoView(0), delay));
  }
}

function scrollSelectedIntoView(attempt: number) {
  const viewport = scrollViewport();
  const selected = viewport?.querySelector<HTMLElement>('[data-current="true"]');
  const viewportRect = viewport?.getBoundingClientRect();
  const selectedRect = selected?.getBoundingClientRect();
  if (!viewport || !selected || !viewportRect || !selectedRect || !viewportRect.height || !selectedRect.height) {
    if (attempt < 4) window.setTimeout(() => scrollSelectedIntoView(attempt + 1), 16);
    return;
  }
  const padding = 4;
  const selectedTop = selectedRect.top - viewportRect.top + viewport.scrollTop;
  const selectedBottom = selectedTop + selectedRect.height;
  if (selectedTop < viewport.scrollTop + padding) {
    viewport.scrollTop = selectedTop - padding;
  } else if (selectedBottom > viewport.scrollTop + viewport.clientHeight - padding) {
    viewport.scrollTop = selectedBottom - viewport.clientHeight + padding;
  }
}

onBeforeUnmount(() => {
  latestResizeObserver?.disconnect();
  clearSelectedScrollTimers();
});
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

.ai-session-turn-navigator[data-tone="panel"] {
  height: 26px;
  gap: 2px;
  padding: 1px;
  background: var(--surface-subtle);
  transform: none;
}

.ai-session-turn-navigator__controls {
  display: inline-flex;
  align-items: center;
  height: 24px;
}

.ai-session-turn-navigator[data-tone="panel"] .ai-session-turn-navigator__controls {
  height: 22px;
  gap: 1px;
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

.ai-session-turn-navigator button.ai-session-turn-navigator__index {
  width: auto;
  min-width: 42px;
  grid-auto-flow: column;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  transition: color 120ms ease;
}

.ai-session-turn-navigator button.ai-session-turn-navigator__index:hover,
.ai-session-turn-navigator button.ai-session-turn-navigator__index:focus-visible {
  color: var(--text);
  outline: none;
}

.ai-session-turn-navigator[data-tone="board"] button.ai-session-turn-navigator__index:hover,
.ai-session-turn-navigator[data-tone="board"] button.ai-session-turn-navigator__index:focus-visible {
  color: var(--ai-board-title);
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

.ai-session-turn-navigator[data-tone="panel"] button {
  width: 24px;
  height: 22px;
  border-radius: 4px;
}

.ai-session-turn-navigator[data-tone="panel"] button.ai-session-turn-navigator__index {
  width: auto;
  min-width: 34px;
  padding: 0 3px;
}

.ai-session-turn-navigator[data-tone="panel"] button.ai-session-turn-navigator__latest {
  width: 24px;
  min-width: 24px;
  height: 22px;
  margin-left: 1px;
  padding: 0;
  border-left-color: var(--line-subtle);
  border-radius: 0 4px 4px 0;
  background: transparent;
  color: inherit;
}

.ai-session-turn-navigator[data-tone="panel"] .ai-session-turn-navigator__latest span {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
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

.ai-session-turn-navigator button.ai-session-turn-navigator__index small {
  min-width: 0;
  border: 0;
  padding: 0;
}

.ai-session-turn-navigator[data-tone="panel"] small {
  min-width: 34px;
  border: 0;
  padding: 0 4px;
  font-size: 11px;
}

.ai-session-turn-navigator[data-tone="panel"] button.ai-session-turn-navigator__index small {
  min-width: 0;
  padding: 0;
}

.ai-session-turn-navigator[data-tone="board"] small {
  border-color: var(--ai-board-floating-border);
  color: var(--ai-board-muted);
}

.ai-session-turn-navigator[data-tone="board"] button.ai-session-turn-navigator__index {
  border-color: var(--ai-board-floating-border);
}

.ai-session-turn-navigator[data-tone="panel"] button:not(:disabled):not(.ai-session-turn-navigator__index):hover,
.ai-session-turn-navigator[data-tone="panel"] button:not(:disabled):not(.ai-session-turn-navigator__index):focus-visible {
  background: var(--brand-accent-soft);
  color: var(--text);
  outline: none;
}

.ai-session-turn-navigator[data-tone="board"] button:not(:disabled):not(.ai-session-turn-navigator__index):hover,
.ai-session-turn-navigator[data-tone="board"] button:not(:disabled):not(.ai-session-turn-navigator__index):focus-visible {
  background: var(--ai-board-turn-hover-bg);
  color: var(--ai-board-floating-hover-text);
  outline: none;
}

.ai-session-turn-navigator button:disabled {
  cursor: default;
  opacity: 0.32;
}

:global(.ai-session-turn-menu) {
  width: min(320px, var(--reka-dropdown-menu-content-available-width, calc(100vw - 24px)));
  max-height: min(420px, var(--reka-dropdown-menu-content-available-height, calc(100vh - 24px)));
  overflow: hidden;
  border-color: var(--line-strong);
  border-radius: 8px;
  background: var(--surface-overlay);
  box-shadow: var(--shadow-popover);
  padding: 5px;
}

:global(.ai-session-turn-menu__search) {
  margin-bottom: 4px;
  border-bottom: 1px solid var(--line-subtle);
  padding: 0 4px 6px;
}

:global(.ai-session-turn-menu__search-field) {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  color: var(--text-muted);
  padding: 0 3px;
}

:global(.ai-session-turn-menu__search-field > svg) {
  display: block;
  flex: 0 0 auto;
}

:global(.ai-session-turn-menu__search-field .ai-session-turn-menu__search-input) {
  flex: 1;
  height: 30px;
  min-width: 0;
  width: auto;
  border: 0;
  background: transparent;
  font-size: 12px;
  padding: 0 2px;
  box-shadow: none;
}

:global(.ai-session-turn-menu__search-field .ai-session-turn-menu__search-input:focus-visible) {
  box-shadow: none;
}

:global(.ai-session-turn-menu__scroll) {
  height: min(360px, max(140px, calc(var(--reka-dropdown-menu-content-available-height, calc(100vh - 24px)) - 50px)));
  min-height: 0;
}

:global(.ai-session-turn-menu__empty) {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  padding: 16px 8px;
  text-align: center;
}

:global(.ai-session-turn-menu__scroll [data-task-handoff-scroll-viewport]) {
  padding-right: 4px;
}

:global(.ai-session-turn-menu__list) {
  display: grid;
  gap: 1px;
}

:global(.ai-session-turn-menu__item) {
  display: grid;
  min-height: 36px;
  grid-template-columns: 24px minmax(0, 1fr) 16px;
  align-items: center;
  gap: 8px;
  border-radius: 6px;
  color: var(--text);
  padding: 3px 7px;
}

:global(.ai-session-turn-menu__item[data-current="true"]) {
  background: var(--brand-accent-soft);
  color: var(--text);
}

:global(.ai-session-turn-menu__item:hover),
:global(.ai-session-turn-menu__item[data-highlighted]) {
  background: var(--surface-hover);
}

:global(.ai-session-turn-menu__item[data-current="true"]:hover),
:global(.ai-session-turn-menu__item[data-current="true"][data-highlighted]) {
  background: var(--brand-accent-soft);
}

:global(.ai-session-turn-menu__number) {
  color: var(--text-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  text-align: center;
}

:global(.ai-session-turn-menu__copy) {
  display: grid;
  min-width: 0;
  gap: 1px;
}

:global(.ai-session-turn-menu__title),
:global(.ai-session-turn-menu__subtitle) {
  min-width: 0;
  overflow: hidden;
  font-size: 12px;
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.ai-session-turn-menu__title) {
  font-weight: 500;
}

:global(.ai-session-turn-menu__subtitle) {
  color: var(--text-muted);
  font-weight: 400;
}

:global(.ai-session-turn-menu__item > svg) {
  color: var(--brand-accent);
}
</style>
