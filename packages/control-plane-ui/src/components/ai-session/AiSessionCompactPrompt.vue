<template>
  <div class="ai-session-compact-prompt" :class="`ai-session-compact-prompt-${tone}`">
    <div
      ref="contentElement"
      class="ai-session-user-prompt-content"
      :class="{ expanded, 'has-overflow': hasOverflow }"
    >
      <MarkdownContent v-if="content" :content="content" :code-tools="codeTools" />
    </div>
    <footer class="ai-session-user-prompt-actions" :aria-label="t('sessions.timeline.turnActions')">
      <button
        v-if="hasOverflow"
        type="button"
        class="ai-session-user-prompt-toggle"
        :aria-expanded="expanded"
        @click="toggleExpanded"
      >
        <span>{{ expanded ? t("sessions.detail.collapsePrompt") : t("sessions.detail.expand") }}</span>
        <ChevronDown :size="13" :class="{ open: expanded }" />
      </button>
      <time
        class="ai-session-user-prompt-time"
        :datetime="timestamp"
        :title="formattedDateTime"
      >{{ formattedTime }}</time>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        class="ai-session-user-prompt-copy"
        :aria-label="copied ? t('sessions.markdown.copied') : t('sessions.markdown.copy')"
        :title="copied ? t('sessions.markdown.copied') : t('sessions.markdown.copy')"
        @click="copyContent"
      >
        <Check v-if="copied" :size="13" />
        <Copy v-else :size="13" />
      </Button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, ChevronDown, Copy } from "@lucide/vue";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import { Button } from "../ui/button";

const props = withDefaults(defineProps<{
  codeTools?: { copiedLabel: string; copyLabel: string; plainTextLabel: string };
  content: string;
  timestamp: string;
  tone?: "detail" | "board";
}>(), {
  codeTools: undefined,
  tone: "detail",
});

const { locale, t } = useI18n();
const contentElement = ref<HTMLElement>();
const copied = ref(false);
const expanded = ref(false);
const hasOverflow = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
let heightAnimation: Animation | undefined;
let resizeObserver: ResizeObserver | undefined;

const formattedTime = computed(() => formatTimestamp(props.timestamp, {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
}));
const formattedDateTime = computed(() => formatTimestamp(props.timestamp, {
  dateStyle: "medium",
  timeStyle: "medium",
}));

function formatTimestamp(value: string, options: Intl.DateTimeFormatOptions) {
  return value ? new Intl.DateTimeFormat(locale.value, options).format(new Date(value)) : "";
}

function updateOverflow() {
  const element = contentElement.value;
  if (!element || expanded.value) return;
  hasOverflow.value = element.scrollHeight > element.clientHeight + 1;
}

function collapsedPromptHeight(element: HTMLElement) {
  const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
  return Number.isFinite(lineHeight) ? lineHeight * 3 : element.getBoundingClientRect().height;
}

async function toggleExpanded() {
  const element = contentElement.value;
  if (!element) return;
  const opening = !expanded.value;
  const fromHeight = element.getBoundingClientRect().height;
  const toHeight = opening ? element.scrollHeight : collapsedPromptHeight(element);
  heightAnimation?.cancel();
  heightAnimation = undefined;
  if (!opening) element.style.maxHeight = "none";
  expanded.value = opening;
  await nextTick();
  if (contentElement.value !== element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    element.style.maxHeight = "";
    return;
  }
  const animation = element.animate(
    [{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
    { duration: 180, easing: "ease", fill: "both" },
  );
  heightAnimation = animation;
  void animation.finished.then(() => {
    if (heightAnimation !== animation) return;
    element.style.maxHeight = "";
    animation.cancel();
    heightAnimation = undefined;
  }).catch(() => undefined);
}

async function copyContent() {
  if (!props.content || !navigator.clipboard?.writeText) return;
  try {
    await navigator.clipboard.writeText(props.content);
  } catch {
    return;
  }
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = false;
  }, 1_500);
}

watch(() => props.content, () => {
  heightAnimation?.cancel();
  heightAnimation = undefined;
  if (contentElement.value) contentElement.value.style.maxHeight = "";
  expanded.value = false;
  hasOverflow.value = false;
  void nextTick(updateOverflow);
});

onMounted(() => {
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(updateOverflow);
    if (contentElement.value) resizeObserver.observe(contentElement.value);
  }
  updateOverflow();
});

onBeforeUnmount(() => {
  clearTimeout(copiedTimer);
  heightAnimation?.cancel();
  if (contentElement.value) contentElement.value.style.maxHeight = "";
  resizeObserver?.disconnect();
});
</script>

<style scoped>
.ai-session-compact-prompt {
  display: grid;
  gap: 7px;
  min-width: 0;
}

.ai-session-user-prompt-content {
  min-width: 0;
  max-height: calc(1.55em * 3);
  overflow: hidden;
  color: var(--text);
  font-size: 14px;
  line-height: 1.55;
  white-space: normal;
}

.ai-session-compact-prompt-board .ai-session-user-prompt-content {
  color: var(--ai-board-title);
}

.ai-session-user-prompt-content.expanded {
  max-height: none;
}

.ai-session-user-prompt-content.has-overflow:not(.expanded) {
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 12px), transparent 100%);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 12px), transparent 100%);
}

.ai-session-user-prompt-content :deep(.markdown-content),
.ai-session-user-prompt-content :deep(.markdown-content > *) {
  max-width: 100%;
  overflow-wrap: anywhere;
}

.ai-session-user-prompt-actions {
  display: flex;
  align-items: center;
  gap: 3px;
  min-height: 26px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 20px;
}

.ai-session-user-prompt-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 26px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 0;
}

.ai-session-user-prompt-toggle:hover,
.ai-session-user-prompt-toggle:focus-visible {
  color: var(--text);
  outline: none;
}

.ai-session-user-prompt-toggle svg {
  transition: transform 180ms ease;
}

.ai-session-user-prompt-toggle svg.open {
  transform: rotate(180deg);
}

.ai-session-user-prompt-time {
  padding-inline: 3px;
  white-space: nowrap;
}

.ai-session-user-prompt-copy {
  width: 26px;
  height: 26px;
  padding: 0;
  color: inherit;
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}

.ai-session-user-prompt-copy :deep(svg) {
  width: 13px;
  height: 13px;
}

.ai-session-compact-prompt:hover .ai-session-user-prompt-copy,
.ai-session-compact-prompt:focus-within .ai-session-user-prompt-copy {
  opacity: 1;
  pointer-events: auto;
}

@media (hover: none) {
  .ai-session-user-prompt-copy {
    opacity: 1;
    pointer-events: auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-session-user-prompt-toggle svg,
  .ai-session-user-prompt-copy {
    transition-duration: 0ms;
  }
}
</style>
