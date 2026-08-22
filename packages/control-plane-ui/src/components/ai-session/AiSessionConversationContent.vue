<template>
  <div v-if="mode === 'full'" class="ai-session-conversation-timeline-state">
    <AiSessionTimelineView
      v-if="aiSessionTurns(session).length"
      :busy="busy"
      :can-interrupt="canInterrupt"
      :can-resolve-approval="canResolveApproval"
      :instance-id="instanceId"
      :conversation-session-id="session.id"
      :file-links="fileLinks"
      :session="session"
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
    :instance-id="instanceId"
    :file-links="fileLinks"
    :is-latest="promptIndex >= promptCount - 1"
    :response-content="compactResponseContent"
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
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { AiSessionSummary } from "../../api/types";
import type { AiSessionTurnTimelineState } from "../../apps/control-plane/useAiSessionTimelineStore";
import { aiSessionTurns, displayAiSessionResponse } from "../../apps/control-plane/useInstanceSessions";
import { compactTimelineForTurn, turnElapsedEnd } from "./timelineActivities";
import AiSessionResult from "./AiSessionResult.vue";
import AiSessionTimelineView from "./AiSessionTimelineView.vue";
import AiSessionTurnActions from "./AiSessionTurnActions.vue";

const props = withDefaults(defineProps<{
  activityInteractive?: boolean;
  busy?: boolean;
  canInterrupt?: boolean;
  canResolveApproval?: boolean;
  fileLinks?: boolean;
  instanceId: string;
  mode: "compact" | "full";
  promptCount: number;
  promptIndex: number;
  session: AiSessionSummary;
  selectedTurnState?: AiSessionTurnTimelineState;
  turnTimelines?: Record<string, AiSessionTurnTimelineState>;
}>(), {
  activityInteractive: true,
  busy: false,
  canInterrupt: false,
  canResolveApproval: false,
  fileLinks: false,
  selectedTurnState: () => ({ status: "ready", items: [] }),
  turnTimelines: () => ({}),
});

defineEmits<{
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
  steerQueuedMessage: [queueId: string];
  stickyUserMessageChange: [message: { id: string; text: string } | undefined];
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
</script>

<style scoped>
.ai-session-conversation-timeline-state {
  min-width: 0;
}

.ai-session-conversation-timeline-state > span {
  color: var(--text-muted);
  font-size: 12px;
}
</style>
