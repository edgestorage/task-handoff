<template>
  <div class="story-decisions">
    <div class="story-decisions-heading">
      <div><h3>{{ t("stories.decisions.title") }}</h3><span>{{ decisions.length }}</span></div>
    </div>
    <div v-if="loading" class="story-decision-state" role="status">{{ t("stories.decisions.loading") }}</div>
    <div v-else-if="loadError" class="story-decision-state story-decision-error" role="alert">{{ loadError }}</div>
    <div v-else-if="!decisions.length" class="story-decision-state story-decision-empty-state">{{ t("stories.decisions.empty") }}</div>
    <template v-else>
      <article v-for="decision in visibleDecisions" :key="decision.id" class="story-decision-row" :data-decision-id="decision.id">
        <div class="story-decision-copy">
          <button
            type="button"
            class="story-decision-question"
            :disabled="!sessionOpenable(decision)"
            :title="t(sessionOpenable(decision) ? 'stories.decisions.openSession' : 'stories.decisions.sessionUnavailable')"
            @click="openSession(decision)"
          >
            <span class="story-decision-question-text">{{ decision.question }}</span>
            <ExternalLink class="story-decision-question-icon" :size="12" aria-hidden="true" />
          </button>
          <small v-if="decision.context" class="story-decision-context">{{ t("stories.decisions.context") }}: {{ decision.context }}</small>
          <small v-if="decisionMeta(decision)" class="story-decision-meta">{{ decisionMeta(decision) }}</small>
        </div>
        <span class="story-decision-status" :data-status="decision.status">{{ statusLabel(decision.status) }}</span>
        <div v-if="decision.status === 'pending'" class="story-decision-actions">
          <StoryDecisionAnswer
            :key="decision.id"
            :decision="decision"
            :disabled="disabled"
            :busy="busyId === decision.id"
            @submit="(input) => submit(decision, input)"
            @cancel="cancel(decision)"
          />
          <div v-if="actionError?.decisionId === decision.id" class="story-decision-action-error" role="alert">{{ actionError.message }}</div>
          <div v-if="resumePendingId === decision.id" class="story-decision-resume" role="alert">
            <span>{{ t("stories.decisions.resumePending") }}</span>
            <Button size="sm" variant="outline" :disabled="disabled || busyId === decision.id" @click="retry(decision)">{{ t("stories.decisions.retry") }}</Button>
          </div>
        </div>
      </article>
      <section v-if="historyDecisions.length" class="story-decision-history">
        <button type="button" class="story-decision-history-summary" :aria-expanded="historyOpen" @click="toggleHistory">
          <ChevronRight :size="15" aria-hidden="true" />
          <span>{{ t("stories.decisions.historyCount", { count: historyDecisions.length }) }}</span>
        </button>
        <Transition
          name="decision-history-disclosure"
          @before-enter="prepareDisclosureEnter"
          @enter="runDisclosureEnter"
          @after-enter="finishDisclosureEnter"
          @enter-cancelled="cancelDisclosureTransition"
          @before-leave="prepareDisclosureLeave"
          @leave="runDisclosureLeave"
          @after-leave="finishDisclosureLeave"
          @leave-cancelled="cancelDisclosureTransition"
        >
          <div v-if="historyOpen" class="story-decision-history-disclosure">
            <div class="story-decision-history-content">
              <article v-for="decision in historyDecisions" :key="decision.id" class="story-decision-row story-decision-row-history" :data-decision-id="decision.id">
                <div class="story-decision-copy">
                  <button
                    type="button"
                    class="story-decision-question"
                    :disabled="!sessionOpenable(decision)"
                    :title="t(sessionOpenable(decision) ? 'stories.decisions.openSession' : 'stories.decisions.sessionUnavailable')"
                    @click="openSession(decision)"
                  >
                    <span class="story-decision-question-text">{{ decision.question }}</span>
                    <ExternalLink class="story-decision-question-icon" :size="12" aria-hidden="true" />
                  </button>
                  <small v-if="decision.context" class="story-decision-context">{{ t("stories.decisions.context") }}: {{ decision.context }}</small>
                  <small v-if="decisionMeta(decision)" class="story-decision-meta">{{ decisionMeta(decision) }}</small>
                </div>
                <span class="story-decision-status" :data-status="decision.status">{{ statusLabel(decision.status) }}</span>
              </article>
            </div>
          </div>
        </Transition>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery } from "@tanstack/vue-query";
import { ChevronRight, ExternalLink } from "@lucide/vue";
import type { Story, StoryDecision } from "@task-handoff/protocol/stories";
import type { InstanceWithAiSessions } from "../../../api/types";
import { storyDecisionsQueryOptions } from "../../../api/queries.ts";
import { Button } from "../../../components/ui/button";
import {
  beginDisclosureTransition,
  cancelDisclosureTransition,
  finishDisclosureEnter,
  finishDisclosureLeave,
  prepareDisclosureEnter,
  prepareDisclosureLeave,
  runDisclosureEnter,
  runDisclosureLeave,
} from "../../../components/ai-session/disclosureTransition.ts";
import { splitStoryDecisions, storyDecisionMeta } from "./storyDecisionPresentation.ts";
import { storyDecisionSessionInstance } from "./storyDecisionSession.ts";
import { useStoryDecisionActions } from "./useStoryDecisionActions.ts";
import StoryDecisionAnswer from "./StoryDecisionAnswer.vue";

const props = defineProps<{ story: Story; disabled?: boolean; instances: InstanceWithAiSessions[] }>();
const emit = defineEmits<{ "open-session": [instanceId: string, sessionId: string] }>();
const { t } = useI18n();

const decisions = ref<StoryDecision[]>([]);
const loadError = ref("");
const historyOpen = ref(false);

// 审批中心、左树和面板共用同一个决策查询：查询键与快照语义都来自 storyDecisionsQueryOptions。
const query = useQuery(storyDecisionsQueryOptions(() => props.story.id, () => props.story.ownerNodeId));
const loading = computed(() => query.isPending.value);
watch(() => query.data.value, (data) => { if (data) decisions.value = data.decisions; }, { immediate: true });
watch(() => query.error.value, (cause) => { loadError.value = cause ? (cause instanceof Error ? cause.message : String(cause)) : ""; });

// 提交、重试与取消和会话内提示共用同一套状态机，写回同一个决策快照。
const { actionError, busyId, resumePendingId, submit, retry, cancel, reset } = useStoryDecisionActions(() => props.story.id, () => props.story.ownerNodeId);
watch(() => props.story.id, () => {
  historyOpen.value = false;
  reset();
});

const visibleDecisions = computed(() => splitStoryDecisions(decisions.value).visible);
const historyDecisions = computed(() => splitStoryDecisions(decisions.value).history);

function statusLabel(status: StoryDecision["status"]) {
  if (status === "pending") return t("stories.decisions.pending");
  if (status === "decided") return t("stories.decisions.decided");
  if (status === "cancelled") return t("stories.decisions.cancelled");
  return t("stories.decisions.expired");
}
function decisionMeta(decision: StoryDecision) { return storyDecisionMeta(decision, t); }
// 决策的会话必须已在实例快照里，并且实例在线时才能进入；否则入口保持禁用并给出说明。
function sessionOpenable(decision: StoryDecision) {
  const instance = storyDecisionSessionInstance(props.instances, decision);
  return Boolean(instance && instance.connectionStatus === "online");
}
function openSession(decision: StoryDecision) {
  const instance = storyDecisionSessionInstance(props.instances, decision);
  if (!instance || instance.connectionStatus !== "online") return;
  emit("open-session", instance.id, decision.sessionId);
}
function toggleHistory(event: MouseEvent) {
  if (historyOpen.value) beginDisclosureTransition(event.currentTarget as Element);
  historyOpen.value = !historyOpen.value;
}
</script>

<style scoped>
.story-decisions { background:var(--surface-raised); }
.story-decisions-heading { display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:38px; border-bottom:1px solid var(--line); color:var(--text-muted); font-size:12px; padding:4px 12px; }
.story-decisions-heading > div { display:flex; align-items:baseline; gap:7px; }
.story-decisions-heading h3 { margin:0; color:var(--text-strong); font-size:13px; font-weight:500; }
.story-decisions-heading span { color:var(--text-muted); font-size:12px; }
.story-decision-state { display:flex; min-height:38px; align-items:center; gap:8px; color:var(--text-muted); font-size:12px; padding:11px 12px; }
.story-decision-empty-state { justify-content:center; min-height:64px; padding:16px 12px; }
.story-decision-error { color:var(--status-danger); }
.story-decision-row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:baseline; column-gap:8px; row-gap:8px; border-top:1px solid var(--line); padding:10px 12px; }
.story-decisions-heading + .story-decision-row { border-top:0; }
.story-decision-copy { grid-column:1; grid-row:1; display:grid; gap:4px; min-width:0; }
.story-decision-status { width:fit-content; border:1px solid var(--line); border-radius:999px; background:var(--surface-raised); color:var(--text-muted); font-size:12px; font-weight:500; line-height:16px; padding:1px 7px; }
.story-decision-status[data-status="pending"] { border-color:color-mix(in srgb,var(--status-warning) 34%,var(--line)); background:var(--status-warning-bg); color:var(--status-warning); }
.story-decision-status[data-status="decided"] { border-color:color-mix(in srgb,var(--status-success) 34%,var(--line)); background:var(--status-success-bg); color:var(--status-success); }
.story-decision-question { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:start; gap:6px; margin:0; border:0; background:transparent; color:var(--text-strong); cursor:pointer; font-family:inherit; font-size:13px; font-weight:500; line-height:1.5; overflow-wrap:anywhere; padding:0; text-align:left; white-space:pre-wrap; }
.story-decision-question:not(:disabled):hover .story-decision-question-text { text-decoration:underline; }
.story-decision-question:focus-visible { border-radius:4px; outline:2px solid var(--focus-ring); outline-offset:2px; }
.story-decision-question:disabled { cursor:default; }
.story-decision-question-icon { margin-top:4px; color:var(--text-muted); }
.story-decision-question:disabled .story-decision-question-icon { opacity:.4; }
.story-decision-context { color:var(--text-muted); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
.story-decision-meta { display:-webkit-box; overflow:hidden; -webkit-box-orient:vertical; -webkit-line-clamp:2; color:var(--text-muted); font-size:12px; line-height:1.5; overflow-wrap:anywhere; }
.story-decision-actions { grid-column:1 / -1; display:grid; gap:8px; min-width:0; }
.story-decision-resume { display:flex; align-items:center; justify-content:space-between; gap:8px; color:var(--status-warning, var(--text-muted)); font-size:12px; }
.story-decision-action-error { color:var(--status-danger); font-size:12px; }
.story-decision-history { border-top:1px solid var(--line); }
.story-decision-history-summary { display:flex; width:100%; align-items:center; gap:5px; border:0; background:transparent; color:var(--text-muted); cursor:pointer; font:inherit; font-size:12px; padding:10px 12px; text-align:left; }
.story-decision-history-summary:hover { background:var(--surface-hover); color:var(--text-strong); }
.story-decision-history-summary:focus-visible { outline:2px solid var(--focus-ring); outline-offset:-2px; }
.story-decision-history-summary svg { flex:0 0 auto; transition:transform 120ms ease; }
.story-decision-history-summary[aria-expanded="true"] svg { transform:rotate(90deg); }
.story-decision-history-content { margin-left:12px; border-left:1px solid var(--line-subtle); }
.story-decision-row-history .story-decision-question { color:var(--text); }
.decision-history-disclosure-enter-active,.decision-history-disclosure-leave-active { overflow:hidden; transition:height 180ms ease,opacity 180ms ease; will-change:height; }
.decision-history-disclosure-enter-from,.decision-history-disclosure-leave-to { opacity:0; }
@media (prefers-reduced-motion: reduce) {
  .decision-history-disclosure-enter-active,.decision-history-disclosure-leave-active { transition-duration:0ms; }
  .story-decision-history-summary svg { transition-duration:0ms; }
}
</style>
