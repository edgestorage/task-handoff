<template>
  <button v-if="error && !nodes.length" type="button" class="ai-session-turn-history-status ai-session-turn-history-retry" @click="$emit('retry')">
    <ChevronRight :size="15" />
    <span>{{ elapsedLabel }} · {{ t("sessions.timeline.loadFailed") }}</span>
  </button>
  <section
    v-else-if="nodes.length || loadable || loading"
    class="ai-session-turn-history"
  >
    <button type="button" class="ai-session-turn-history-summary" :aria-expanded="historyOpen" @click="toggleHistory">
      <ChevronRight :size="15" />
      <span>{{ elapsedLabel }}</span>
    </button>
    <Transition
      name="turn-history-disclosure"
      @before-enter="prepareDisclosureEnter"
      @enter="runDisclosureEnter"
      @after-enter="finishDisclosureEnter"
      @enter-cancelled="cancelDisclosureTransition"
      @before-leave="prepareDisclosureLeave"
      @leave="runDisclosureLeave"
      @after-leave="finishDisclosureLeave"
      @leave-cancelled="cancelDisclosureTransition"
    >
      <div v-if="historyOpen" class="ai-session-turn-history-disclosure">
        <div class="ai-session-turn-history-content">
          <div v-if="loading && !nodes.length" class="ai-session-turn-history-status" aria-busy="true">
            <LoaderCircle class="ai-session-turn-history-loading-icon" :size="15" aria-hidden="true" />
            <span>{{ t("sessions.timeline.loading") }}</span>
          </div>
          <template v-for="node in nodes" :key="node.id">
            <article
              v-if="node.type === 'message'"
              class="ai-session-turn-history-message"
              :class="{ 'ai-session-turn-history-message-user': node.message.type === 'user-message' }"
            >
              <MarkdownContent :content="node.message.text" :code-tools="markdownCodeTools" />
            </article>
            <AiSessionActivityGroup v-else :activities="node.activities" />
          </template>
        </div>
      </div>
    </Transition>
  </section>
  <div v-else class="ai-session-turn-history-status ai-session-turn-history-empty">
    <Timer :size="15" aria-hidden="true" />
    <span>{{ elapsedLabel }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronRight, LoaderCircle, Timer } from "@lucide/vue";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import { turnElapsedSeconds, type TimelineTurnNode } from "./timelineActivities";
import AiSessionActivityGroup from "./AiSessionActivityGroup.vue";
import {
  beginDisclosureTransition,
  cancelDisclosureTransition,
  finishDisclosureEnter,
  finishDisclosureLeave,
  prepareDisclosureEnter,
  prepareDisclosureLeave,
  runDisclosureEnter,
  runDisclosureLeave,
} from "./disclosureTransition";

const props = defineProps<{
  nodes: TimelineTurnNode[];
  loading?: boolean;
  loadable?: boolean;
  error?: string;
  startedAt?: string;
  endedAt?: string;
  active?: boolean;
}>();
const emit = defineEmits<{ load: []; retry: [] }>();
const { t } = useI18n();
const now = ref(Date.now());
const historyOpen = ref(false);
let elapsedTimer: ReturnType<typeof setInterval> | undefined;

function toggleHistory(event: MouseEvent) {
  beginDisclosureTransition(event.currentTarget as Element);
  historyOpen.value = !historyOpen.value;
  if (historyOpen.value && props.loadable) emit("load");
}

function syncElapsedTimer() {
  clearInterval(elapsedTimer);
  elapsedTimer = undefined;
  now.value = Date.now();
  if (props.active && props.startedAt && !props.endedAt) {
    elapsedTimer = setInterval(() => {
      now.value = Date.now();
    }, 1_000);
  }
}

const elapsedSeconds = computed(() => turnElapsedSeconds(
  props.startedAt,
  props.endedAt,
  props.active === true,
  now.value,
));
const elapsedLabel = computed(() => {
  const seconds = elapsedSeconds.value;
  if (seconds === undefined) return t("sessions.timeline.processedUnavailable");
  if (seconds < 60) return t("sessions.timeline.processedSeconds", { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("sessions.timeline.processedMinutes", { minutes, seconds: seconds % 60 });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("sessions.timeline.processedHours", { hours, minutes: minutes % 60, seconds: seconds % 60 });
  return t("sessions.timeline.processedDays", {
    days: Math.floor(hours / 24),
    hours: hours % 24,
    minutes: minutes % 60,
    seconds: seconds % 60,
  });
});
const markdownCodeTools = computed(() => ({
  copiedLabel: t("sessions.markdown.copied"),
  copyLabel: t("sessions.markdown.copy"),
  plainTextLabel: t("sessions.markdown.plainText"),
}));
onMounted(syncElapsedTimer);
onBeforeUnmount(() => clearInterval(elapsedTimer));
watch(() => [props.active, props.startedAt, props.endedAt], syncElapsedTimer);
</script>

<style scoped>
.ai-session-turn-history { min-width: 0; color: var(--text-muted); }
.ai-session-turn-history-status {
  display: flex;
  align-items: center;
  gap: 5px;
  width: fit-content;
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--text-muted);
  font: inherit;
  font-size: 14px;
  line-height: inherit;
}
.ai-session-turn-history-retry { cursor: pointer; }
.ai-session-turn-history-loading-icon { animation: ai-session-turn-history-spin 800ms linear infinite; }
.ai-session-turn-history-summary {
  display: flex;
  align-items: center;
  gap: 5px;
  width: fit-content;
  cursor: pointer;
  list-style: none;
  user-select: none;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 14px;
  font-weight: 400;
  text-align: left;
}
.ai-session-turn-history-summary svg { transition: transform 120ms ease; }
.ai-session-turn-history-summary[aria-expanded="true"] svg { transform: rotate(90deg); }
.ai-session-turn-history-disclosure { display: grid; padding-left: 7px; }
.ai-session-turn-history-content {
  display: grid;
  gap: 12px;
  padding: 12px 0 0 12px;
  border-left: 1px solid var(--line-subtle);
}
.ai-session-turn-history-message { color: var(--text); font-size: 14px; line-height: 1.55; }
.ai-session-turn-history-message-user {
  justify-self: end;
  width: fit-content;
  max-width: min(78%, 620px);
  border-radius: 14px;
  background: var(--ai-session-user-message-bg, var(--surface-hover));
  padding: 12px 14px;
}
.ai-session-turn-history-message :deep(.markdown-content),
.ai-session-turn-history-message :deep(.markdown-content > *) { max-width: 100%; overflow-wrap: anywhere; }
.ai-session-turn-history-message :deep(.markdown-content > :first-child) { margin-top: 0; }
.ai-session-turn-history-message :deep(.markdown-content > :last-child) { margin-bottom: 0; }
.turn-history-disclosure-enter-active,
.turn-history-disclosure-leave-active { overflow: hidden; transition: height 180ms ease, opacity 180ms ease; will-change: height; }
.turn-history-disclosure-enter-from,
.turn-history-disclosure-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .turn-history-disclosure-enter-active,
  .turn-history-disclosure-leave-active { transition-duration: 0ms; }
}
@keyframes ai-session-turn-history-spin { to { transform: rotate(360deg); } }
</style>
