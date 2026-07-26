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
    <span ref="activityTextEl" :data-status-text="statusText">{{ statusText }}</span>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AiSessionLifecycle, AiSessionPhase, AiSessionTool } from "../../api/types";

const props = withDefaults(defineProps<{
  currentTool?: AiSessionTool;
  phase?: AiSessionPhase;
  status?: AiSessionLifecycle;
  summary?: string;
  toolCallsSinceLastMessage?: number;
  tone?: "detail" | "board";
}>(), {
  currentTool: undefined,
  phase: "unknown",
  status: "idle",
  summary: undefined,
  toolCallsSinceLastMessage: 0,
  tone: "detail",
});
const { t } = useI18n();

const count = computed(() => Math.max(0, props.toolCallsSinceLastMessage));
const visible = computed(() => props.status === "running" || props.status === "waiting");
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
    return t("sessions.activity.responding");
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
}

.ai-session-tool-activity > span {
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

.ai-session-tool-activity-running > span::after {
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
