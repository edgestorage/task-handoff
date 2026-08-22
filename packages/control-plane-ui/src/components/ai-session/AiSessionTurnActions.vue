<template>
  <footer class="ai-session-turn-actions" :aria-label="t('sessions.timeline.turnActions')">
    <Button
      type="button"
      size="xs"
      variant="ghost"
      class="ai-session-turn-action"
      :aria-label="copied ? t('sessions.markdown.copied') : t('sessions.markdown.copy')"
      :title="copied ? t('sessions.markdown.copied') : t('sessions.markdown.copy')"
      @click="copyContent"
    >
      <Check v-if="copied" :size="13" />
      <Copy v-else :size="13" />
    </Button>
    <Button
      v-if="canContinue"
      type="button"
      size="xs"
      variant="ghost"
      class="ai-session-turn-action"
      :disabled="busy"
      :aria-label="t('sessions.actions.continueFromTurn')"
      :title="t('sessions.actions.continueFromTurn')"
      @click="$emit('continue')"
    >
      <Split :size="13" />
    </Button>
    <time
      v-if="timestamp"
      class="ai-session-turn-time"
      :datetime="timestamp"
      :title="formattedDateTime"
    >{{ formattedTime }}</time>
  </footer>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Copy, Split } from "@lucide/vue";
import { Button } from "../ui/button";

const props = withDefaults(defineProps<{
  busy?: boolean;
  canContinue?: boolean;
  content: string;
  timestamp?: string;
}>(), {
  busy: false,
  canContinue: false,
  timestamp: "",
});

defineEmits<{ continue: [] }>();

const { locale, t } = useI18n();
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
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

onBeforeUnmount(() => clearTimeout(copiedTimer));
</script>

<style scoped>
.ai-session-turn-actions {
  display: flex;
  min-height: 26px;
  align-items: center;
  gap: 2px;
  color: var(--text-muted);
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
}

:global(.ai-session-timeline-turn:hover .ai-session-turn-actions),
:global(.ai-session-timeline-turn:focus-within .ai-session-turn-actions),
:global(.ai-session-result:hover .ai-session-turn-actions),
:global(.ai-session-result:focus-within .ai-session-turn-actions) {
  opacity: 1;
  pointer-events: auto;
}

.ai-session-turn-action {
  width: 26px;
  height: 26px;
  padding: 0;
  color: inherit;
}

.ai-session-turn-action :deep(svg) {
  width: 13px;
  height: 13px;
}

.ai-session-turn-time {
  padding-inline: 6px;
  font-size: 13px;
  line-height: 20px;
  white-space: nowrap;
}

@media (hover: none) {
  .ai-session-turn-actions {
    opacity: 1;
    pointer-events: auto;
  }
}
</style>
