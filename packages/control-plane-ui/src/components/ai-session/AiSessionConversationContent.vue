<template>
  <div class="ai-session-conversation-stage" :data-state="detailState" :aria-busy="detailState === 'loading'">
    <Transition
      name="ai-session-message-fade"
      appear
      @before-enter="beginConversationTransition"
      @after-enter="finishConversationTransition"
      @enter-cancelled="finishConversationTransition"
    >
    <div :key="`session:${session.id}`" class="ai-session-conversation-layer">
    <div v-if="detailState !== 'ready'" class="ai-session-conversation-detail-state" :data-state="detailState">
      <div v-if="detailState !== 'error'" class="ai-session-conversation-detail-loading">
        <div class="ai-session-conversation-detail-skeleton" aria-hidden="true">
          <div class="ai-session-conversation-detail-skeleton-meta">
            <span class="is-dot" />
            <span class="is-meta" />
          </div>
          <div class="ai-session-conversation-detail-skeleton-body">
            <span class="is-wide" />
            <span class="is-medium" />
            <span class="is-long" />
            <span class="is-short" />
          </div>
          <div class="ai-session-conversation-detail-skeleton-activity">
            <span class="is-activity-icon" />
            <span class="is-activity" />
          </div>
        </div>
      </div>
      <div v-else class="ai-session-conversation-detail-state-label">
        <RotateCcw :size="16" aria-hidden="true" />
        <span>{{ t("sessions.detail.loadFailed") }}</span>
        <Button variant="outline" size="sm" @click="$emit('retryDetail')">
          {{ t("sessions.detail.retry") }}
        </Button>
      </div>
    </div>
    <div v-else class="ai-session-conversation-content-layer">
      <div v-if="mode === 'full'" class="ai-session-conversation-timeline-state">
        <AiSessionTimelineView
          v-if="aiSessionTurns(session).length"
          :busy="busy"
          :can-interrupt="canInterrupt"
          :can-resolve-approval="canResolveApproval"
          :approval-decisions="approvalDecisions"
          :instance-id="instanceId"
          :conversation-session-id="session.id"
          :file-links="fileLinks"
          :session="session"
          :turn-bodies-ready="turnBodiesReady"
          :turn-timelines="turnTimelines"
          @edit-queued-message="$emit('editQueuedMessage', $event)"
          @open-file="$emit('openFile', $event)"
          @steer-queued-message="$emit('steerQueuedMessage', $event)"
          @retry-queued-message="$emit('retryQueuedMessage', $event)"
          @remove-queued-message="$emit('removeQueuedMessage', $event)"
          @reorder-queued-messages="$emit('reorderQueuedMessages', $event)"
          @resolve-approval="$emit('resolveApproval', $event)"
          @sticky-user-message-change="$emit('stickyUserMessageChange', $event)"
          @continue-from-turn="$emit('continueFromTurn', $event)"
          @layout-will-change="$emit('layoutWillChange')"
          @layout-committed="$emit('layoutCommitted')"
          @load-turn-timeline="(turnId, force) => $emit('loadTurnTimeline', turnId, force)"
        />
        <span v-else>{{ t("sessions.timeline.noHistory") }}</span>
      </div>
      <AiSessionResult
        v-else
        :busy="busy"
        :can-interrupt="canInterrupt"
        :can-resolve-approval="canResolveApproval"
        :approval-decisions="approvalDecisions"
        :instance-id="instanceId"
        :file-links="fileLinks"
        :is-latest="promptIndex >= promptCount - 1"
        :response-content="detailState === 'ready' ? compactResponseContent : ''"
        :turn-started-at="selectedTurn?.startedAt"
        :turn-ended-at="turnElapsedEnd(selectedTurn)"
        :session="session"
        :activities="selectedTimeline.activities"
        :activity-nodes="selectedTimeline.activityNodes"
        :activity-history="selectedTimeline.history"
        :activity-history-status="selectedTurnState.status"
        :activity-history-error="selectedTurnState.error"
        :activity-interactive="activityInteractive"
        @layout-will-change="$emit('layoutWillChange')"
        @layout-committed="$emit('layoutCommitted')"
        @load-activity-history="$emit('loadTurnTimeline', selectedTurn?.id || '')"
        @retry-activity-history="$emit('loadTurnTimeline', selectedTurn?.id || '', true)"
        @edit-queued-message="$emit('editQueuedMessage', $event)"
        @open-file="$emit('openFile', $event)"
        @steer-queued-message="$emit('steerQueuedMessage', $event)"
        @retry-queued-message="$emit('retryQueuedMessage', $event)"
        @remove-queued-message="$emit('removeQueuedMessage', $event)"
        @reorder-queued-messages="$emit('reorderQueuedMessages', $event)"
        @resolve-approval="$emit('resolveApproval', $event)"
      >
        <template #turn-footer>
          <AiSessionTurnActions
            v-if="compactCompletedTurn && compactResponseContent"
            :busy="busy"
            :can-continue="compactCanContinue"
            :content="compactResponseContent"
            :timestamp="compactTurnTime"
            @continue="$emit('continueFromTurn', compactCompletedTurn.id)"
          />
        </template>
      </AiSessionResult>
    </div>
    </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { RotateCcw } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { AiSessionSummary } from "../../api/types";
import type { AiSessionTurnTimelineState } from "../../apps/control-plane/useAiSessionTimelineStore";
import { aiSessionTurns, displayAiSessionResponse } from "../../apps/control-plane/useInstanceSessions";
import { compactTimelineForTurn, turnElapsedEnd } from "./timelineActivities";
import AiSessionResult from "./AiSessionResult.vue";
import AiSessionTimelineView from "./AiSessionTimelineView.vue";
import AiSessionTurnActions from "./AiSessionTurnActions.vue";
import { Button } from "../ui/button";

type AiSessionDetailState = "loading" | "ready" | "error";

const props = withDefaults(defineProps<{
  activityInteractive?: boolean;
  busy?: boolean;
  canInterrupt?: boolean;
  canResolveApproval?: boolean;
  approvalDecisions?: Array<"allow" | "deny" | "skip">;
  fileLinks?: boolean;
  detailState?: AiSessionDetailState;
  instanceId: string;
  mode: "compact" | "full";
  promptCount: number;
  promptIndex: number;
  session: AiSessionSummary;
  selectedTurnState?: AiSessionTurnTimelineState;
  turnBodiesReady?: boolean;
  turnTimelines?: Record<string, AiSessionTurnTimelineState>;
}>(), {
  activityInteractive: true,
  busy: false,
  canInterrupt: false,
  canResolveApproval: false,
  approvalDecisions: () => ["allow", "deny", "skip"],
  fileLinks: false,
  detailState: "ready",
  selectedTurnState: () => ({ status: "ready", items: [] }),
  turnBodiesReady: true,
  turnTimelines: () => ({}),
});

const emit = defineEmits<{
  continueFromTurn: [turnId: string];
  editQueuedMessage: [payload: { queueId: string; message: string }];
  layoutCommitted: [];
  layoutWillChange: [];
  loadTurnTimeline: [turnId: string, force?: boolean];
  openFile: [href: string];
  removeQueuedMessage: [queueId: string];
  reorderQueuedMessages: [payload: { expectedRevision: number; queueIds: string[] }];
  resolveApproval: [decision: "allow" | "deny" | "skip"];
  retryQueuedMessage: [queueId: string];
  retryDetail: [];
  steerQueuedMessage: [queueId: string];
  stickyUserMessageChange: [message: { id: string; text: string } | undefined];
  transitioningChange: [transitioning: boolean];
}>();

const { t } = useI18n();
const selectedTurn = computed(() => aiSessionTurns(props.session)[props.promptIndex]);
const compactResponseContent = computed(() => displayAiSessionResponse(props.session, props.promptIndex, t));
const compactCompletedTurn = computed(() => selectedTurn.value?.status === "completed" ? selectedTurn.value : undefined);
const compactCanContinue = computed(() => Boolean(props.session.actions?.fork && compactCompletedTurn.value?.providerTurnId));
const compactTurnTime = computed(() => {
  const turn = compactCompletedTurn.value;
  return turn?.completedAt || turn?.updatedAt || turn?.startedAt || "";
});
const selectedTimeline = computed(() => compactTimelineForTurn(props.selectedTurnState.items, selectedTurn.value));
let activeConversationTransitions = 0;

function beginConversationTransition() {
  activeConversationTransitions += 1;
  if (activeConversationTransitions === 1) emit("transitioningChange", true);
}

function finishConversationTransition() {
  if (activeConversationTransitions <= 0) return;
  activeConversationTransitions -= 1;
  if (activeConversationTransitions === 0) emit("transitioningChange", false);
}
</script>

<style scoped>
.ai-session-conversation-stage {
  display: grid;
  min-width: 0;
}

.ai-session-conversation-layer {
  grid-area: 1 / 1;
  min-width: 0;
}

.ai-session-message-fade-enter-active,
.ai-session-message-fade-leave-active {
  transition: opacity 180ms ease;
}

.ai-session-message-fade-enter-from,
.ai-session-message-fade-leave-to {
  opacity: 0;
}

.ai-session-conversation-detail-state {
  align-content: start;
  color: var(--text-muted);
  display: grid;
  font-size: 12px;
  gap: 18px;
  min-height: clamp(150px, 24vh, 220px);
  padding: 16px 0 24px;
}

.ai-session-conversation-detail-state-label {
  align-items: center;
  display: flex;
  gap: 8px;
  min-height: 30px;
}

.ai-session-conversation-detail-loading {
  display: grid;
  gap: 18px;
}

.ai-session-conversation-detail-state-label > button {
  margin-left: 4px;
}

.ai-session-conversation-detail-skeleton {
  animation: ai-session-conversation-detail-reveal 120ms ease 250ms forwards;
  display: grid;
  gap: 20px;
  opacity: 0;
  width: min(820px, 88%);
}

.ai-session-conversation-detail-skeleton span {
  animation: ai-session-conversation-detail-pulse 1.2s ease-in-out infinite;
  background: var(--surface-hover);
  border-radius: 6px;
  display: block;
}

.ai-session-conversation-detail-skeleton-meta,
.ai-session-conversation-detail-skeleton-activity {
  align-items: center;
  display: flex;
  gap: 9px;
}

.ai-session-conversation-detail-skeleton-body {
  display: grid;
  gap: 10px;
}

.ai-session-conversation-detail-skeleton .is-dot {
  border-radius: 50%;
  height: 10px;
  width: 10px;
}

.ai-session-conversation-detail-skeleton .is-meta { height: 9px; width: 126px; }
.ai-session-conversation-detail-skeleton-body > span { height: 10px; }
.ai-session-conversation-detail-skeleton .is-wide { width: 96%; }
.ai-session-conversation-detail-skeleton .is-medium { width: 74%; }
.ai-session-conversation-detail-skeleton .is-long { width: 86%; }
.ai-session-conversation-detail-skeleton .is-short { width: 48%; }
.ai-session-conversation-detail-skeleton .is-activity-icon { height: 16px; width: 16px; }
.ai-session-conversation-detail-skeleton .is-activity { height: 9px; width: 184px; }

@keyframes ai-session-conversation-detail-reveal {
  to { opacity: 1; }
}

@keyframes ai-session-conversation-detail-pulse {
  0%, 100% { opacity: .38; }
  50% { opacity: .72; }
}

@media (prefers-reduced-motion: reduce) {
  .ai-session-message-fade-enter-active,
  .ai-session-message-fade-leave-active,
  .ai-session-conversation-detail-skeleton,
  .ai-session-conversation-detail-skeleton span {
    animation: none;
    transition: none;
  }

  .ai-session-conversation-detail-skeleton { opacity: 1; }
}

.ai-session-conversation-timeline-state {
  min-width: 0;
}

.ai-session-conversation-timeline-state > span {
  color: var(--text-muted);
  font-size: 12px;
}
</style>
