<template>
  <section
    v-if="visible"
    class="ai-session-tool-activity"
    :class="[
      `ai-session-tool-activity-${tone}`,
      { 'ai-session-tool-activity-running': status === 'running' },
    ]"
    :aria-label="statusText"
    :style="{
      '--tool-activity-duration': `${shimmerDuration}s`,
      '--tool-activity-sweep-stop': shimmerSweepStop,
    }"
  >
    <button
      v-if="interactive"
      type="button"
      class="ai-session-tool-activity-trigger"
      :aria-expanded="expanded"
      @click="toggleExpanded"
    >
      <ChevronRight :size="15" :class="{ open: expanded }" />
      <span ref="activityTextEl" :data-status-text="statusText">{{ statusText }}</span>
    </button>
    <span v-else ref="activityTextEl" :data-status-text="statusText">{{ statusText }}</span>
    <div v-if="interactive && expanded" class="ai-session-tool-activity-expanded">
      <span v-if="loading">{{ t("sessions.timeline.loading") }}</span>
      <span v-else-if="error" role="alert">{{ error }}</span>
      <template v-else-if="displayNodes.length">
        <template v-for="node in displayNodes" :key="node.id">
          <article
            v-if="node.type === 'message'"
            class="ai-session-tool-activity-message"
            :class="{ 'ai-session-tool-activity-message-user': node.message.type === 'user-message' }"
          >
            <MarkdownContent :content="node.message.text" :code-tools="markdownCodeTools" />
          </article>
          <AiSessionActivityGroup v-else :activities="node.activities" open :summary-visible="false" />
        </template>
      </template>
      <span v-else>{{ t("sessions.timeline.noActivities") }}</span>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronRight } from "@lucide/vue";
import type { AiSessionTimelineActivity } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionLifecycle, AiSessionPhase, AiSessionTool } from "../../api/types";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import AiSessionActivityGroup from "./AiSessionActivityGroup.vue";
import type { TimelineTurnNode } from "./timelineActivities";

const props = withDefaults(defineProps<{
  currentTool?: AiSessionTool;
  phase?: AiSessionPhase;
  status?: AiSessionLifecycle;
  summary?: string;
  toolCallsSinceLastMessage?: number;
  tone?: "detail" | "board";
  activities?: AiSessionTimelineActivity[];
  nodes?: TimelineTurnNode[];
  error?: string;
  interactive?: boolean;
  loading?: boolean;
}>(), {
  currentTool: undefined,
  phase: "unknown",
  status: "idle",
  summary: undefined,
  toolCallsSinceLastMessage: 0,
  tone: "detail",
  activities: () => [],
  nodes: () => [],
  error: "",
  interactive: false,
  loading: false,
});
const { t } = useI18n();
const markdownCodeTools = computed(() => ({
  copiedLabel: t("sessions.markdown.copied"),
  copyLabel: t("sessions.markdown.copy"),
  plainTextLabel: t("sessions.markdown.plainText"),
}));
const displayNodes = computed<TimelineTurnNode[]>(() => props.nodes.length
  ? props.nodes
  : props.activities.length
    ? [{ id: `activities:${props.activities[0].id}`, type: "activities", activities: props.activities }]
    : []);

const count = computed(() => Math.max(0, props.toolCallsSinceLastMessage));
const visible = computed(() => props.status === "running" || props.status === "waiting");
const expanded = ref(false);
const shimmerDuration = ref(2.2);
const shimmerSweepStop = ref("50%");
const activityTextEl = ref<HTMLElement>();
let resizeObserver: ResizeObserver | undefined;

function updateShimmerDuration() {
  const width = activityTextEl.value?.clientWidth || 0;
  if (!width) return;
  const sweepSeconds = (width + 144) / 200;
  const totalSeconds = sweepSeconds + 1.5;
  shimmerDuration.value = totalSeconds;
  shimmerSweepStop.value = `${(sweepSeconds / totalSeconds) * 100}%`;
}

watch(activityTextEl, (element) => {
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  if (!element) return;
  updateShimmerDuration();
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(updateShimmerDuration);
    resizeObserver.observe(element);
  }
}, { flush: "post" });

onBeforeUnmount(() => resizeObserver?.disconnect());
function toggleExpanded() {
  expanded.value = !expanded.value;
}
const statusText = computed(() => {
  if (props.phase === "approval") {
    return props.summary ? `${t("sessions.status.waitingApproval")} · ${props.summary}` : t("sessions.activity.waitingApproval");
  }
  if (props.currentTool?.name) {
    return props.currentTool.inputPreview
      ? `${props.currentTool.name} · ${props.currentTool.inputPreview}`
      : props.currentTool.name;
  }
  if (props.phase === "responding") {
    return count.value > 0
      ? t("sessions.activity.respondingTools", { count: count.value })
      : t("sessions.activity.responding");
  }
  if (props.phase === "editing") {
    return t("sessions.activity.editing");
  }
  if (props.status === "waiting") {
    return t("sessions.activity.waiting");
  }
  return count.value > 0
    ? t("sessions.activity.thinkingTools", { count: count.value })
    : t("sessions.activity.thinking");
});
</script>

<style scoped>
.ai-session-tool-activity {
  --tool-activity-color: var(--text-muted);
  --tool-activity-highlight: var(--text-strong);
  display: flex;
  align-items: center;
  min-width: 0;
  flex-wrap: wrap;
}

.ai-session-tool-activity > span,
.ai-session-tool-activity-trigger > span {
  position: relative;
  display: block;
  width: fit-content;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-session-tool-activity-trigger {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 400;
  line-height: 1.45;
  cursor: pointer;
  text-align: left;
}
.ai-session-tool-activity-trigger > span { font-weight: 400; }
.ai-session-tool-activity-trigger > svg { flex: 0 0 auto; color: var(--text-muted); transition: transform 120ms ease; }
.ai-session-tool-activity-trigger > svg.open { transform: rotate(90deg); }
.ai-session-tool-activity-expanded { display: grid; flex: 0 0 100%; gap: 6px; min-width: 0; margin-top: 10px; padding-left: 20px; }
.ai-session-tool-activity-expanded > span { color: var(--text-muted); font-size: 12px; }
.ai-session-tool-activity-message { min-width: 0; color: var(--text); font-size: 14px; line-height: 1.55; }
.ai-session-tool-activity-message-user {
  justify-self: end;
  margin-left: auto;
  width: fit-content;
  max-width: min(78%, 620px);
  border-radius: 14px;
  background: var(--surface-hover);
  padding: 12px 14px;
}
.ai-session-tool-activity-message :deep(.markdown-content),
.ai-session-tool-activity-message :deep(.markdown-content > *) { max-width: 100%; overflow-wrap: anywhere; }

.ai-session-tool-activity-detail {
  font-size: 14px;
  padding: 0;
}

.ai-session-tool-activity-board {
  --tool-activity-color: var(--ai-board-muted);
  --tool-activity-highlight: var(--ai-board-title);
  font-size: 14px;
  margin-top: -12px;
  padding: 0;
}

.ai-session-tool-activity-board > span {
  color: var(--ai-board-muted);
}

.ai-session-tool-activity-running > span::after,
.ai-session-tool-activity-running .ai-session-tool-activity-trigger > span::after {
  position: absolute;
  inset: 0;
  color: var(--tool-activity-highlight);
  content: attr(data-status-text);
  pointer-events: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  mask-image: linear-gradient(90deg, transparent, #000 50%, transparent);
  mask-position: -72px 0;
  mask-repeat: no-repeat;
  mask-size: 72px 100%;
  animation: tool-activity-shimmer var(--tool-activity-duration, 2.2s) infinite;
  animation-timing-function: linear(0, 1 var(--tool-activity-sweep-stop, 50%), 1);
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 50%, transparent);
  -webkit-mask-position: -72px 0;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-size: 72px 100%;
}

@keyframes tool-activity-shimmer {
  from {
    mask-position: -72px 0;
    -webkit-mask-position: -72px 0;
  }

  to {
    mask-position: calc(100% + 72px) 0;
    -webkit-mask-position: calc(100% + 72px) 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .ai-session-tool-activity-running > span::after {
    animation: none;
    content: none;
  }

  .ai-session-tool-activity-running > span {
    color: var(--tool-activity-color);
  }
}
</style>
