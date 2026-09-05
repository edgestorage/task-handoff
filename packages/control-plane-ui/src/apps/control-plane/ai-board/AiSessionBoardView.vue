<template>
  <section class="ai-board-view" :aria-label="t('sessions.board.label')">
    <div v-if="loading" class="ai-board-empty">{{ t("sessions.board.loading") }}</div>
    <div v-else-if="error" class="ai-board-empty error">{{ error }}</div>
    <template v-else>
      <div class="ai-board-toolbar">
        <div class="ai-board-filter-group">
          <span class="ai-board-layout-toggle" :aria-label="t('sessions.board.layout')">
            <button type="button" :aria-pressed="layoutMode === 'columns'" :title="t('sessions.board.columns')" @click="setLayoutMode('columns')">
              <Columns3 :size="14" />
            </button>
            <button type="button" :aria-pressed="layoutMode === 'grid'" :title="t('sessions.board.grid')" @click="setLayoutMode('grid')">
              <LayoutGrid :size="14" />
            </button>
          </span>
          <label class="ai-board-search">
            <Search :size="14" />
            <input :value="filter" :placeholder="t('sessions.board.search')" @input="emit('update:filter', ($event.target as HTMLInputElement).value)" />
          </label>
          <span class="ai-board-chips" :aria-label="t('sessions.board.counts')">
            <button
              v-for="filterOption in statusFilterOptions"
              :key="filterOption.key"
              type="button"
              :aria-pressed="visibleColumnKeys.has(filterOption.key)"
              :data-active="visibleColumnKeys.has(filterOption.key)"
              :data-tone="filterOption.tone"
              @click="toggleColumnVisibility(filterOption.key)"
            >
              {{ filterOption.count }} {{ filterOption.label }}
            </button>
            <strong data-tone="online">{{ t("sessions.board.instancesOnline", { count: summary.instancesOnline }) }}</strong>
          </span>
        </div>
        <div class="ai-board-toolbar-actions">
          <DropdownMenu v-if="layoutMode === 'grid'">
            <DropdownMenuTrigger as-child>
              <Button variant="outline" size="sm" class="ai-board-options-trigger" :aria-label="t('sessions.board.options')" :title="t('sessions.board.options')">
                <SlidersHorizontal :size="16" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent class="ai-board-options-menu" align="end" :side-offset="6">
              <DropdownMenuLabel class="ai-board-options-label">{{ t("sessions.board.sort") }}</DropdownMenuLabel>
              <DropdownMenuCheckboxItem class="ai-board-options-item option-item" :model-value="gridSortByStatus" @update:model-value="setGridSortByStatus(Boolean($event))">
                {{ t("sessions.board.sortByStatus") }}
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator class="ai-board-options-separator" />
              <DropdownMenuLabel class="ai-board-options-label">{{ t("sessions.board.group") }}</DropdownMenuLabel>
              <DropdownMenuRadioGroup :model-value="gridGroupBy" @update:model-value="setGridGroupBy($event as AiBoardGridGroupBy)">
                <DropdownMenuRadioItem class="ai-board-options-item option-item" value="none">{{ t("sessions.board.noGrouping") }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem class="ai-board-options-item option-item" value="path">{{ t("sessions.board.groupPath") }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem class="ai-board-options-item option-item" value="instance">{{ t("sessions.board.groupInstance") }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem class="ai-board-options-item option-item" value="node">{{ t("sessions.board.groupNode") }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem class="ai-board-options-item option-item" value="agent">{{ t("sessions.board.groupAgent") }}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <small>{{ t("sessions.board.boundTotal", { visible: layoutVisibleCards.length, total: totalBoundSessions }) }}</small>
        </div>
      </div>

      <ScrollArea v-if="layoutMode === 'columns'" class="ai-board-columns-scroll">
        <div class="ai-board-columns" :style="boardColumnGridStyle">
          <section v-for="column in boardColumns" :key="column.key" class="ai-board-column" :data-tone="column.tone">
            <div class="ai-board-column-head-mask">
              <header class="ai-board-column-head">
                <span>
                  <strong>{{ column.title }}</strong>
                  <small>{{ column.description }}</small>
                </span>
                <b>{{ column.cards.length }}</b>
              </header>
            </div>

            <div class="ai-board-column-body-content">
              <AiSessionCard
                v-for="card in column.cards"
                :key="card.key"
                :approval-busy-key="approvalBusyKey"
                :bound-triggers="boundTriggers"
                :can-resolve-approval="canResolveApproval"
                :card="card"
                :instance-display-name="instanceDisplayName"
                :is-trigger-bound="isTriggerBound"
                :prompt-count="promptCount(card.session)"
                :prompt-index="promptIndexFor(card)"
                :selected="selectedCardKey === card.key"
                :show-workspace="true"
                :short-hash="shortHash"
                :stopping-app-session-key="stoppingAppSessionKey"
                :forking-session-key="forkingSessionKey"
                :trigger-action-key="triggerActionKey"
                :trigger-busy-key="triggerBusyKey"
                :trigger-templates="triggerTemplates"
                @next-prompt="nextPrompt"
                @open-ai-session-app="openCardApp"
                @previous-prompt="previousPrompt"
                @resolve-approval="(instance, session, decision) => emit('resolveApproval', instance, session, decision)"
                @select-card="selectCard"
                @select-instance="emit('selectInstance', $event)"
                @stop-app-session="stopCardAppSession"
                @fork-session="forkCardSession"
                @toggle-trigger="toggleTrigger"
                @story-assigned="onStoryAssigned"
                @story-assign-failed="onStoryAssignFailed"
              />

              <div v-if="!column.cards.length" class="ai-board-column-empty">
                {{ column.empty }}
              </div>
            </div>
          </section>
        </div>
      </ScrollArea>

      <ScrollArea v-else class="ai-board-grid-scroll">
        <div class="ai-board-grid">
          <template v-for="group in gridGroups" :key="group.key">
            <div v-if="gridGroupBy !== 'none'" class="ai-board-grid-group-label">
              <span v-if="gridGroupBy === 'path'" class="ai-board-grid-group-workspace">
                <TooltipProvider :delay-duration="120">
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <b>{{ aiSessionBasename(group.label) || group.label }}</b>
                    </TooltipTrigger>
                    <TooltipContent class="ai-session-path-tooltip" side="top" :side-offset="8">{{ group.label }}</TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </span>
              <span v-else>{{ group.label }}</span>
              <strong>{{ group.cards.length }}</strong>
            </div>
            <AiSessionCard
              v-for="card in group.cards"
              :key="card.key"
              :approval-busy-key="approvalBusyKey"
              :bound-triggers="boundTriggers"
              :can-resolve-approval="canResolveApproval"
              :card="card"
              :instance-display-name="instanceDisplayName"
              :is-trigger-bound="isTriggerBound"
              :prompt-count="promptCount(card.session)"
              :prompt-index="promptIndexFor(card)"
              :selected="selectedCardKey === card.key"
              :show-workspace="gridGroupBy !== 'path'"
              :short-hash="shortHash"
              :stopping-app-session-key="stoppingAppSessionKey"
              :forking-session-key="forkingSessionKey"
              :trigger-action-key="triggerActionKey"
              :trigger-busy-key="triggerBusyKey"
              :trigger-templates="triggerTemplates"
              @next-prompt="nextPrompt"
              @open-ai-session-app="openCardApp"
              @previous-prompt="previousPrompt"
              @resolve-approval="(instance, session, decision) => emit('resolveApproval', instance, session, decision)"
              @select-card="selectCard"
              @select-instance="emit('selectInstance', $event)"
              @stop-app-session="stopCardAppSession"
              @fork-session="forkCardSession"
              @toggle-trigger="toggleTrigger"
              @story-assigned="onStoryAssigned"
              @story-assign-failed="onStoryAssignFailed"
            />
          </template>

          <div v-if="!layoutVisibleCards.length" class="ai-board-grid-empty">
            {{ t("sessions.board.noMatches") }}
          </div>
        </div>
      </ScrollArea>

      <Transition name="ai-board-floating-dock-fade">
        <AiSessionFloatingDock
          ref="floatingDockEl"
          v-if="selectedCard"
          v-model:collapsed="detailCollapsed"
          :busy="aiSessionActionBusy"
          :can-interrupt="canInterrupt(selectedCard.session)"
          :can-resolve-approval="canResolveApproval(selectedCard.session)"
          :card="selectedCard"
          :conversation-session="selectedCardConversationSession || selectedCard.session"
          :detail-state="selectedCardContentState"
          :attachments="messageAttachments"
          :draft="messageDraft"
          :editing-label="queueComposerEdit ? t('sessions.composer.editingQueuedMessage') : undefined"
          :mention-bindings="messageMentionBindings"
          :mention-context="mentionContext"
          :mention-trigger="mentionTrigger"
          :command-trigger="commandTrigger"
          :session-busy="selectedCard.session.status === 'running' || selectedCard.session.status === 'waiting'"
          :instance-display-name="instanceDisplayName"
          :prompt-count="promptCount(selectedCard.session)"
          :prompt-index="promptIndexFor(selectedCard)"
          :timeline-mode="effectiveTimelineViewMode"
          :selected-turn-state="selectedTurnTimelineState"
          :turn-bodies-ready="selectedCardTurnsReady"
          :turn-timelines="conversationTurnTimelines"
          @latest-prompt="backToLatestPrompt(selectedCard)"
          @next-prompt="nextPrompt(selectedCard)"
          @open-ai-session-app="openCardApp"
          @previous-prompt="previousPrompt(selectedCard)"
          @edit-queued-message="editSelectedQueuedMessage"
          @remove-queued-message="removeSelectedQueuedMessage"
          @reorder-queued-messages="reorderSelectedQueuedMessages"
          @resolve-approval="resolveSelectedApproval"
          @retry-queued-message="retrySelectedQueuedMessage"
          @retry-detail="loadSelectedCardSessionDetail"
          @load-turn-timeline="loadTurnTimeline"
          @continue-from-turn="forkCardSession(selectedCard, 'current', $event)"
          @run="runSelectedSessionAction"
          @command="executeSelectedSessionCommand"
          @cancel-edit="cancelQueueComposerEdit"
          @steer="steerMessageDraft"
          @steer-queued-message="steerSelectedQueuedMessage"
          @update:attachments="messageAttachments = $event"
          @update:draft="messageDraft = $event"
          @update:mention-bindings="messageMentionBindings = $event"
        />
      </Transition>
      <AlertDialog :open="Boolean(pendingBusyFork)" @update:open="(open) => !open && (pendingBusyFork = undefined)">
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{{ t("sessions.actions.forkBusyTitle") }}</AlertDialogTitle>
            <AlertDialogDescription>{{ t("sessions.actions.forkBusyDescription") }}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel>
            <AlertDialogAction @click="confirmBusyFork">{{ t("sessions.actions.forkConfirm") }}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { compareNaturalText, compareTechnicalIdentifiers } from "../../../i18n/presentation";
import type { SupportedLocale } from "../../../i18n/locale";
import { translateApiError } from "../../../i18n/apiError";
import { waitForAiSessionProjection } from "../ai-session-projection";
import { useEventListener } from "@vueuse/core";
import { Columns3, LayoutGrid, Search, SlidersHorizontal } from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import { closeAiSession, editAiSessionQueuedMessage, forkAiSession, interruptAiSession, markAiSessionRead, openAiSessionApp, removeAiSessionQueuedMessage, reorderAiSessionQueuedMessages, resolveAiSessionApproval, retryAiSessionQueuedMessage, sendAiSessionMessage, steerAiSessionQueuedMessage, uploadAiSessionAttachment, useControlPlaneSettingsQuery } from "../../../api/queries";
import { controlPlaneQueryKeys } from "../../../api/queryKeys.ts";
import { executeAiSessionCommand } from "../../../api/ai-session-commands";
import type { AiSessionCommandInput, AiSessionPermissionMode } from "@task-handoff/protocol/ai-sessions";
import { isAiSessionApprovalPending } from "@task-handoff/control-plane-client";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions, NodeLocalFolder } from "../../../api/types";
import type { AiSessionComposerAttachment } from "../../../components/ai-session/AiSessionComposer.vue";
import { uploadAiSessionComposerAttachment } from "../../../components/ai-session/attachmentUpload";
import { referencesForBindings, type AiSessionMentionBinding } from "../../../components/ai-session/mentions";
import { desktopRuntimePathAccess } from "../../../components/ai-session/useAiSessionMentions";
import { Button } from "../../../components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import { showControlPlaneToast, showDelayedControlPlaneLoadingToast } from "../useControlPlaneToasts";
import { useAiSessionTimelinePresentation } from "../useAiSessionTimelinePresentation";
import { useAiSessionTimelineViewMode } from "../useAiSessionTimelineViewMode";
import { useAiSessionConversationProjection } from "../useAiSessionConversationProjection";
import { useAiSessionMessageDeltaDemand, useAiSessionTimelineDemand } from "../useAiSessionEventDemand";
import { aiSessionMessageText, clearAiSessionDraft, loadAiSessionDraftPayload, persistAiSessionDraftPayload } from "../useAiSessionDraft";
import {
  aiSessionAppTab,
  aiSessionAppNavigationTarget,
  aiSessionBasename,
  aiSessionStableSortKey,
  aiSessionTurns,
  appDisplayName,
  compareAiSessionsByLastUserMessage,
  displayAiSessionMessage,
  displayAiSessionTitle,
  sessionDisplayName,
} from "../useInstanceSessions";
import AiSessionCard from "./AiSessionCard.vue";
import AiSessionFloatingDock from "./AiSessionFloatingDock.vue";
import type { AiBoardCard, AiBoardColumnKey } from "./aiBoardTypes";
import { useAiBoardTriggers } from "./useAiBoardTriggers";
import { nodeLocalFolderDisplayName } from "../nodePath";
import { createBrowserUuid } from "../../../lib/random-id";

const AI_BOARD_VISIBLE_COLUMNS_STORAGE_KEY = "task-handoff.control-plane.ai-board.visible-columns";
const AI_BOARD_LAYOUT_STORAGE_KEY = "task-handoff.control-plane.ai-board.layout";
const AI_BOARD_GRID_GROUP_BY_STORAGE_KEY = "task-handoff.control-plane.ai-board.grid-group-by";
const AI_BOARD_GRID_SORT_BY_STATUS_STORAGE_KEY = "task-handoff.control-plane.ai-board.grid-sort-by-status";
const DEFAULT_VISIBLE_COLUMN_KEYS: AiBoardColumnKey[] = ["running", "waiting", "idle-open", "problem"];
type AiBoardLayoutMode = "columns" | "grid";
type AiBoardGridGroupBy = "none" | "path" | "instance" | "node" | "agent";
type AiBoardGridGroup = {
  cards: AiBoardCard[];
  key: string;
  label: string;
};

const props = defineProps<{
  error?: string;
  filter: string;
  approvalBusyKey?: string;
  instanceDisplayName: (instance: InstanceBoardItem) => string;
  instances: InstanceWithAiSessions[];
  loading: boolean;
  nodeLocalFoldersByNodeId: Record<string, NodeLocalFolder[]>;
}>();

const emit = defineEmits<{
  openAiSessionApp: [instance: InstanceWithAiSessions, session?: AiSessionSummary];
  resolveApproval: [instance: InstanceWithAiSessions, session: AiSessionSummary, decision: "allow" | "deny" | "skip"];
  selectInstance: [instanceId: string];
  "update:filter": [value: string];
}>();
const { locale, t } = useI18n();

const promptIndexes = ref<Record<string, { index: number; count: number }>>({});
let promptSelectionRevision = 0;
const visibleColumnKeys = ref(loadVisibleColumnKeys());
const layoutMode = ref<AiBoardLayoutMode>(loadLayoutMode());
const gridGroupBy = ref<AiBoardGridGroupBy>(loadGridGroupBy());
const gridSortByStatus = ref(loadGridSortByStatus());
const selectedCardKey = ref("");
const detailCollapsed = ref(false);
const messageDraft = ref("");
const messageAttachments = ref<AiSessionComposerAttachment[]>([]);
const messageMentionBindings = ref<AiSessionMentionBinding[]>([]);
const floatingDockEl = ref<InstanceType<typeof AiSessionFloatingDock>>();
const queueComposerEdit = ref<{
  queueId: string;
  originalMessage: string;
  previousDraft: string;
  previousAttachments: AiSessionComposerAttachment[];
  previousMentionBindings: AiSessionMentionBinding[];
}>();
const aiSessionActionBusy = ref(false);
const stoppingAppSessionKey = ref("");
const forkingSessionKey = ref("");
const forkRequestIds = new Map<string, string>();
const pendingBusyFork = ref<{ card: AiBoardCard; mode: "current" | "managed-worktree"; throughTurnId?: string }>();
const queryClient = useQueryClient();
const controlPlaneSettings = useControlPlaneSettingsQuery();
const mentionTrigger = computed(() => controlPlaneSettings.data.value?.mentionTrigger || "@");
const commandTrigger = computed(() => controlPlaneSettings.data.value?.commandTrigger || "/");
const mentionContext = computed(() => {
  const card = selectedCard.value;
  if (!card?.session.cwd) return undefined;
  return {
    instanceId: card.instance.id,
    sessionId: card.session.id,
    provider: card.session.agent,
    cwd: card.session.cwd,
    runtimeType: card.instance.runtime?.type,
    runtimePathAccess: desktopRuntimePathAccess(card.instance),
  };
});
const {
  boundTriggers,
  isTriggerBound,
  shortHash,
  toggleTrigger,
  triggerActionKey,
  triggerBusyKey,
  triggerTemplates,
} = useAiBoardTriggers();

type StoryTarget = {
  nodeId: string;
  instanceId: string;
  sessionId: string;
  storyId?: string | null;
};

function onStoryAssigned(_card: AiBoardCard, _target: StoryTarget) {
  showControlPlaneToast(t("sessions.actions.storyAssigned"), "success");
  void queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.instanceBoard });
}

function onStoryAssignFailed(_card: AiBoardCard, _target: StoryTarget, error: unknown) {
  showControlPlaneToast(translateApiError(error, t, t("sessions.actions.storyAssignFailed")));
}

const allCards = computed<AiBoardCard[]>(() => {
  const cards: AiBoardCard[] = [];
  for (const instance of props.instances) {
    for (const session of instance.aiSessions?.sessions || []) {
      const appTab = aiSessionAppTab(instance, session);
      cards.push({
        appTab: appTab || { key: "ai-sessions", label: t("sessions.title"), status: session.status, kind: "ai" },
        instance,
        key: `${instance.id}:${session.id}`,
        session,
      });
    }
  }
  return cards;
});

const visibleCards = computed(() => {
  const term = props.filter.trim().toLowerCase();
  if (!term) {
    return allCards.value;
  }
  return allCards.value.filter((card) => {
    const haystack = [
      props.instanceDisplayName(card.instance),
      card.instance.project?.name,
      card.instance.node?.name,
      card.session.agent,
      card.session.status,
      card.session.phase,
      card.session.cwd,
      displayAiSessionTitle(card.session, promptIndexFor(card), t),
      displayAiSessionMessage(card.session, promptIndexFor(card), t),
      sessionDisplayName(card.appTab, t),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(term);
  });
});

const totalBoundSessions = computed(() => allCards.value.length);
const selectedCard = computed(() => allCards.value.find((card) => card.key === selectedCardKey.value));
useAiSessionMessageDeltaDemand(computed(() => ({ instanceIds: props.instances.map((instance) => instance.id) })));
useAiSessionTimelineDemand(computed(() => selectedCard.value ? {
  instanceId: selectedCard.value.instance.id,
  sessionId: selectedCard.value.session.id,
} : undefined));
const {
  allTurnsReady: selectedCardTurnsReady,
  conversation: selectedCardConversationSession,
  loadAllTurns: loadAllSelectedCardTurns,
  hasCurrentTurn: hasCurrentSelectedCardTurn,
  hasRenderableTurn: hasRenderableSelectedCardTurn,
  loadTurn: loadSelectedCardTurn,
  refresh: loadSelectedCardSessionDetail,
  state: selectedCardSessionDetailState,
  turnIndexKey: selectedCardTurnIndexKey,
} = useAiSessionConversationProjection({
  instanceId: () => selectedCard.value?.instance.id || "",
  summary: () => selectedCard.value?.session,
});
const { viewMode: timelineViewMode } = useAiSessionTimelineViewMode();
const {
  conversationTurnTimelines,
  loadSelectedTurnTimeline,
  loadTurnTimeline,
  selectedTurn: selectedTimelineTurn,
  selectedTurnState: selectedTurnTimelineState,
  supportsTimeline: supportsAiSessionTimeline,
} = useAiSessionTimelinePresentation({
  instance: () => selectedCard.value?.instance,
  promptIndex: () => selectedCard.value ? promptIndexFor(selectedCard.value) : 0,
  session: selectedCardConversationSession,
});
const effectiveTimelineViewMode = computed(() => supportsAiSessionTimeline.value ? timelineViewMode.value : "compact");
const selectedCardContentState = computed(() => {
  if (selectedCardSessionDetailState.value !== "ready" || effectiveTimelineViewMode.value === "full") {
    return selectedCardSessionDetailState.value;
  }
  const card = selectedCard.value;
  const conversation = selectedCardConversationSession.value;
  if (!card || !conversation) return "loading";
  const turn = aiSessionTurns(conversation)[promptIndexFor(card)];
  return !turn || hasRenderableSelectedCardTurn(turn.id) ? "ready" : "loading";
});
watch(
  () => selectedTimelineTurn.value ? `${selectedCard.value?.key || ""}:${selectedTimelineTurn.value.id}:${selectedTimelineTurn.value.status}:${selectedCardTurnIndexKey.value}` : "",
  () => {
    if (selectedTimelineTurn.value) void loadSelectedCardTurn(selectedTimelineTurn.value.id);
    void loadSelectedTurnTimeline();
  },
  { immediate: true },
);
watch(
  [effectiveTimelineViewMode, selectedCardTurnIndexKey],
  ([mode]) => { if (mode === "full") void loadAllSelectedCardTurns(); },
  { immediate: true },
);
const layoutVisibleCards = computed(() => visibleCards.value
  .filter((card) => visibleColumnKeys.value.has(cardColumnKey(card)))
  .sort((left, right) => compareAiBoardCards(left, right, layoutMode.value === "grid" && gridSortByStatus.value)));
const summary = computed(() => ({
  idleOpen: allCards.value.filter((card) => cardColumnKey(card) === "idle-open").length,
  instancesOnline: props.instances.filter((instance) => instance.connectionStatus === "online").length,
  problem: allCards.value.filter((card) => cardColumnKey(card) === "problem").length,
  running: allCards.value.filter((card) => cardColumnKey(card) === "running").length,
  waiting: allCards.value.filter((card) => cardColumnKey(card) === "waiting").length,
}));

const statusFilterOptions = computed<Array<{ count: number; key: AiBoardColumnKey; label: string; tone: string }>>(() => [
  { count: summary.value.running, key: "running", label: t("sessions.board.running"), tone: "active" },
  { count: summary.value.waiting, key: "waiting", label: t("sessions.board.waitingApproval"), tone: "waiting" },
  { count: summary.value.idleOpen, key: "idle-open", label: t("sessions.board.idleOpen"), tone: "idle" },
  { count: summary.value.problem, key: "problem", label: t("sessions.board.problem"), tone: "problem" },
]);

const boardColumns = computed(() => {
  const columns: Array<{
    cards: AiBoardCard[];
    description: string;
    empty: string;
    key: AiBoardColumnKey;
    title: string;
    tone: string;
  }> = [
    {
      cards: [],
      description: t("sessions.board.runningDescription"),
      empty: t("sessions.board.noRunning"),
      key: "running",
      title: t("sessions.board.running"),
      tone: "active",
    },
    {
      cards: [],
      description: t("sessions.board.waitingDescription"),
      empty: t("sessions.board.noWaiting"),
      key: "waiting",
      title: t("sessions.board.waiting"),
      tone: "waiting",
    },
    {
      cards: [],
      description: t("sessions.board.idleDescription"),
      empty: t("sessions.board.noIdle"),
      key: "idle-open",
      title: t("sessions.board.idleOpenTitle"),
      tone: "idle",
    },
    {
      cards: [],
      description: t("sessions.board.problemDescription"),
      empty: t("sessions.board.noProblem"),
      key: "problem",
      title: t("sessions.board.problem"),
      tone: "problem",
    },
  ];
  const byKey = new Map(columns.map((column) => [column.key, column]));
  for (const card of layoutVisibleCards.value) {
    byKey.get(cardColumnKey(card))?.cards.push(card);
  }
  return columns.filter((column) => visibleColumnKeys.value.has(column.key));
});

const gridGroups = computed<AiBoardGridGroup[]>(() => {
  if (gridGroupBy.value === "none") {
    return [{ key: "__all__", label: t("sessions.board.all"), cards: layoutVisibleCards.value }];
  }
  const groups = new Map<string, AiBoardGridGroup>();
  for (const card of layoutVisibleCards.value) {
    const { key, label } = aiBoardCardGroup(card, gridGroupBy.value);
    const current = groups.get(key) || { key, label, cards: [] };
    current.cards.push(card);
    groups.set(key, current);
  }
  return [...groups.values()];
});

const visibleColumnKeysSignature = computed(() => Array.from(visibleColumnKeys.value).sort().join(":"));
const boardColumnGridStyle = computed(() => ({
  "--ai-board-visible-column-count": String(Math.max(boardColumns.value.length, 1)),
}));

function cardColumnKey(card: AiBoardCard): AiBoardColumnKey {
  const status = card.session.status;
  if (status === "waiting") {
    return "waiting";
  }
  if (status === "failed") {
    return "problem";
  }
  if (status === "running") {
    return "running";
  }
  return "idle-open";
}

function compareAiBoardCards(left: AiBoardCard, right: AiBoardCard, sortByStatus: boolean) {
  const sessionDelta = compareAiSessionsByLastUserMessage(left.session, right.session, sortByStatus);
  if (sessionDelta) {
    return sessionDelta;
  }
  const instanceDelta = compareNaturalText(props.instanceDisplayName(left.instance), props.instanceDisplayName(right.instance), locale.value as SupportedLocale)
    || compareTechnicalIdentifiers(left.instance.id, right.instance.id);
  return instanceDelta || compareTechnicalIdentifiers(aiSessionStableSortKey(left.session), aiSessionStableSortKey(right.session));
}

function aiBoardCardPath(card: AiBoardCard) {
  const path = card.session.cwd?.trim();
  const folders = props.nodeLocalFoldersByNodeId[card.instance.nodeId] || [];
  const normalizedPath = normalizeFolderPath(path);
  const folder = (card.session.cwdFolderId
    ? folders.find((candidate) => candidate.id === card.session.cwdFolderId)
    : undefined)
    || folders.find((candidate) => normalizeFolderPath(candidate.path) === normalizedPath);
  return {
    key: normalizedPath || "__unknown_path__",
    label: folder ? nodeLocalFolderDisplayName(folder) : path || t("sessions.board.unknownPath"),
  };
}

function normalizeFolderPath(value?: string) {
  const path = value?.trim() || "";
  if (/^[A-Za-z]:[\\/]/u.test(path)) return path.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
  return path.replace(/\/+$/u, "");
}

function aiBoardCardGroup(card: AiBoardCard, groupBy: Exclude<AiBoardGridGroupBy, "none">) {
  if (groupBy === "instance") {
    return { key: card.instance.id, label: props.instanceDisplayName(card.instance) };
  }
  if (groupBy === "node") {
    return { key: card.instance.nodeId || "__unknown_node__", label: card.instance.node?.name || card.instance.nodeId || t("sessions.board.unknownNode") };
  }
  if (groupBy === "agent") {
    return { key: card.session.agent, label: appDisplayName(card.session.agent, t) };
  }
  return aiBoardCardPath(card);
}

function toggleColumnVisibility(key: AiBoardColumnKey) {
  const next = new Set(visibleColumnKeys.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  visibleColumnKeys.value = next;
  saveVisibleColumnKeys(next);
}

function loadVisibleColumnKeys() {
  if (typeof window === "undefined") {
    return new Set(DEFAULT_VISIBLE_COLUMN_KEYS);
  }
  try {
    const stored = window.localStorage?.getItem(AI_BOARD_VISIBLE_COLUMNS_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : undefined;
    if (!Array.isArray(parsed)) {
      return new Set(DEFAULT_VISIBLE_COLUMN_KEYS);
    }
    const valid = parsed.filter((key): key is AiBoardColumnKey => DEFAULT_VISIBLE_COLUMN_KEYS.includes(key));
    return valid.length ? new Set(valid) : new Set(DEFAULT_VISIBLE_COLUMN_KEYS);
  } catch {
    return new Set(DEFAULT_VISIBLE_COLUMN_KEYS);
  }
}

function saveVisibleColumnKeys(keys: Set<AiBoardColumnKey>) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage?.setItem(
      AI_BOARD_VISIBLE_COLUMNS_STORAGE_KEY,
      JSON.stringify(DEFAULT_VISIBLE_COLUMN_KEYS.filter((key) => keys.has(key))),
    );
  } catch {
    // Storage can be unavailable in restricted browser contexts; the current selection still applies.
  }
}

function loadLayoutMode(): AiBoardLayoutMode {
  if (typeof window === "undefined") {
    return "columns";
  }
  try {
    return window.localStorage?.getItem(AI_BOARD_LAYOUT_STORAGE_KEY) === "grid" ? "grid" : "columns";
  } catch {
    return "columns";
  }
}

function setLayoutMode(mode: AiBoardLayoutMode) {
  layoutMode.value = mode;
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage?.setItem(AI_BOARD_LAYOUT_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable in restricted browser contexts; the current selection still applies.
  }
}

function loadGridGroupBy(): AiBoardGridGroupBy {
  if (typeof window === "undefined") {
    return "none";
  }
  try {
    const stored = window.localStorage?.getItem(AI_BOARD_GRID_GROUP_BY_STORAGE_KEY);
    return stored === "path" || stored === "instance" || stored === "node" || stored === "agent" ? stored : "none";
  } catch {
    return "none";
  }
}

function setGridGroupBy(value: AiBoardGridGroupBy) {
  gridGroupBy.value = value;
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage?.setItem(AI_BOARD_GRID_GROUP_BY_STORAGE_KEY, value);
  } catch {
    // Storage can be unavailable in restricted browser contexts; the current grouping still applies.
  }
}

function loadGridSortByStatus() {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    return window.localStorage?.getItem(AI_BOARD_GRID_SORT_BY_STATUS_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function setGridSortByStatus(value: boolean) {
  gridSortByStatus.value = value;
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage?.setItem(AI_BOARD_GRID_SORT_BY_STATUS_STORAGE_KEY, String(value));
  } catch {
    // Storage can be unavailable in restricted browser contexts; the current sorting still applies.
  }
}

function promptCount(session: AiSessionSummary) {
  return session.turnCount ?? aiSessionTurns(session).length;
}

function promptIndexFor(card: AiBoardCard) {
  const count = promptCount(card.session);
  if (!count) {
    return 0;
  }
  const saved = promptIndexes.value[card.key];
  if (!saved) {
    return count - 1;
  }
  const wasFollowingLatest = saved.index >= saved.count - 1;
  if (wasFollowingLatest && count !== saved.count) {
    return count - 1;
  }
  return Math.min(Math.max(saved.index, 0), count - 1);
}

async function setPromptIndex(card: AiBoardCard, index: number) {
  const count = promptCount(card.session);
  if (!count) {
    return;
  }
  const targetIndex = Math.min(Math.max(index, 0), count - 1);
  const conversation = selectedCard.value?.key === card.key ? selectedCardConversationSession.value : undefined;
  const targetTurn = conversation ? aiSessionTurns(conversation)[targetIndex] : undefined;
  if (targetTurn && !hasCurrentSelectedCardTurn(targetTurn.id)) {
    const requestRevision = ++promptSelectionRevision;
    const loaded = await loadSelectedCardTurn(targetTurn.id);
    if (!loaded || requestRevision !== promptSelectionRevision || selectedCard.value?.key !== card.key) return;
  } else {
    promptSelectionRevision += 1;
  }
  promptIndexes.value = {
    ...promptIndexes.value,
    [card.key]: { index: targetIndex, count },
  };
}

function previousPrompt(card: AiBoardCard) {
  void setPromptIndex(card, promptIndexFor(card) - 1);
}

function nextPrompt(card: AiBoardCard) {
  void setPromptIndex(card, promptIndexFor(card) + 1);
}

function backToLatestPrompt(card: AiBoardCard) {
  void setPromptIndex(card, promptCount(card.session) - 1);
}

function canResolveApproval(session: AiSessionSummary) {
  return isAiSessionApprovalPending(session);
}

function canInterrupt(session: AiSessionSummary) {
  return Boolean(session.actions?.interrupt);
}

function selectCard(key: string) {
  if (selectedCardKey.value === key && detailCollapsed.value) {
    detailCollapsed.value = false;
  }
  selectedCardKey.value = key;
}

function clearSelectedCard() {
  queueComposerEdit.value = undefined;
  selectedCardKey.value = "";
  messageDraft.value = "";
  messageAttachments.value = [];
}

function closeBoardOverlays(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : undefined;
  if (!target) {
    return;
  }
  if (target.closest(".ai-board-card") || target.closest(".ai-board-floating-dock") || target.closest("[data-ai-session-composer-overlay]")) {
    return;
  }
  clearSelectedCard();
}

async function refreshBoard() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.instanceBoard }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-ai-sessions"] }),
  ]);
}

async function runSelectedSessionAction(permissionMode?: AiSessionPermissionMode) {
  const card = selectedCard.value;
  if (!card || aiSessionActionBusy.value || (!messageDraft.value.trim() && !messageAttachments.value.length && !canInterrupt(card.session))) {
    return;
  }
  if (queueComposerEdit.value) {
    await saveSelectedQueuedMessage();
    return;
  }
  if (messageDraft.value.trim() || messageAttachments.value.length) {
    await sendSelectedSessionMessage(permissionMode);
    return;
  }
  await interruptSelectedSession();
}

async function uploadMessageAttachments(instanceId: string, sessionId: string) {
  return Promise.all(messageAttachments.value.map(async (attachment) => {
    return uploadAiSessionComposerAttachment(attachment, (onProgress) => {
      if (!attachment.dataUrl) throw new Error(t("sessions.panel.attachmentUnavailable", { name: attachment.name }));
      return uploadAiSessionAttachment({
        instanceId,
        sessionId,
        kind: attachment.kind,
        name: attachment.name,
        mime: attachment.mime,
        data: attachment.dataUrl,
      }, onProgress);
    });
  }));
}

async function sendSelectedSessionMessage(permissionMode?: AiSessionPermissionMode) {
  const card = selectedCard.value;
  const message = messageDraft.value.trim();
  if (!card || (!message && !messageAttachments.value.length) || aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    const attachments = await uploadMessageAttachments(card.instance.id, card.session.id);
    await sendAiSessionMessage(card.instance.id, card.session.id, aiSessionMessageText(message), undefined, attachments, referencesForBindings(messageDraft.value, messageMentionBindings.value), permissionMode);
    clearAiSessionDraft(card.session.id);
    messageDraft.value = "";
    messageMentionBindings.value = [];
    messageAttachments.value = [];
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.sendFailed")));
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function executeSelectedSessionCommand(input: AiSessionCommandInput) {
  const card = selectedCard.value;
  if (!card || aiSessionActionBusy.value) return;
  aiSessionActionBusy.value = true;
  try {
    const result = await executeAiSessionCommand(card.instance.id, card.session.id, input);
    clearAiSessionDraft(card.session.id);
    messageDraft.value = "";
    messageMentionBindings.value = [];
    if (input.command === "goal" && !input.argument) showControlPlaneToast(result.value || t("sessions.panel.noGoal"));
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.commandFailed")));
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function steerMessageDraft() {
  const card = selectedCard.value;
  const message = messageDraft.value.trim();
  if (!card || (!message && !messageAttachments.value.length) || aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    const attachments = await uploadMessageAttachments(card.instance.id, card.session.id);
    await sendAiSessionMessage(card.instance.id, card.session.id, aiSessionMessageText(message), "steer", attachments, referencesForBindings(messageDraft.value, messageMentionBindings.value));
    clearAiSessionDraft(card.session.id);
    messageDraft.value = "";
    messageMentionBindings.value = [];
    messageAttachments.value = [];
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.steerFailed")));
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function interruptSelectedSession() {
  const card = selectedCard.value;
  if (!card || !canInterrupt(card.session) || aiSessionActionBusy.value || messageDraft.value.trim() || messageAttachments.value.length) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    await interruptAiSession(card.instance.id, card.session.id);
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.stopFailed")));
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function resolveSelectedApproval(decision: "allow" | "deny" | "skip") {
  const card = selectedCard.value;
  if (!card || !canResolveApproval(card.session) || aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    await resolveAiSessionApproval(card.instance.id, card.session.id, decision);
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.approvalFailed")));
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function steerSelectedQueuedMessage(queueId: string) {
  await runSelectedQueueAction((card) => steerAiSessionQueuedMessage(card.instance.id, card.session.id, queueId), t("sessions.panel.steerQueuedFailed"));
}

async function retrySelectedQueuedMessage(queueId: string) {
  await runSelectedQueueAction((card) => retryAiSessionQueuedMessage(card.instance.id, card.session.id, queueId), t("sessions.panel.retryQueuedFailed"));
}

async function removeSelectedQueuedMessage(queueId: string) {
  await runSelectedQueueAction((card) => removeAiSessionQueuedMessage(card.instance.id, card.session.id, queueId), t("sessions.panel.removeQueuedFailed"));
}

function editSelectedQueuedMessage(payload: { queueId: string; message: string }) {
  const previous = queueComposerEdit.value;
  queueComposerEdit.value = {
    queueId: payload.queueId,
    originalMessage: payload.message,
    previousDraft: previous?.previousDraft ?? messageDraft.value,
    previousAttachments: previous?.previousAttachments ?? messageAttachments.value,
    previousMentionBindings: previous?.previousMentionBindings ?? messageMentionBindings.value,
  };
  messageDraft.value = payload.message;
  messageAttachments.value = [];
  messageMentionBindings.value = [];
  detailCollapsed.value = false;
  void nextTick(() => floatingDockEl.value?.focusComposer());
}

function cancelQueueComposerEdit() {
  const edit = queueComposerEdit.value;
  if (!edit) return;
  queueComposerEdit.value = undefined;
  messageDraft.value = edit.previousDraft;
  messageAttachments.value = edit.previousAttachments;
  messageMentionBindings.value = edit.previousMentionBindings;
}

async function saveSelectedQueuedMessage() {
  const card = selectedCard.value;
  const edit = queueComposerEdit.value;
  const message = messageDraft.value.trim();
  if (!card || !edit || !message || aiSessionActionBusy.value) return;
  if (message === edit.originalMessage.trim()) {
    cancelQueueComposerEdit();
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    const queueRevision = selectedCardConversationSession.value?.queue.revision ?? card.session.queue.revision;
    await editAiSessionQueuedMessage(card.instance.id, card.session.id, edit.queueId, queueRevision, message);
    cancelQueueComposerEdit();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.editQueuedFailed")));
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function reorderSelectedQueuedMessages(payload: { expectedRevision: number; queueIds: string[] }) {
  await runSelectedQueueAction((card) => reorderAiSessionQueuedMessages(card.instance.id, card.session.id, payload.expectedRevision, payload.queueIds), t("sessions.panel.reorderQueuedFailed"));
}

async function stopCardAppSession(card: AiBoardCard) {
  if (stoppingAppSessionKey.value) return;
  stoppingAppSessionKey.value = card.key;
  const loadingToast = showDelayedControlPlaneLoadingToast(t("sessions.actions.closingSession"));
  try {
    await closeAiSession(card.instance.id, card.session.id, createBrowserUuid());
    if (selectedCardKey.value === card.key) {
      clearSelectedCard();
    }
  } catch (error) {
    loadingToast.dismiss();
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.closeSessionFailed")));
    await refreshBoard();
  } finally {
    loadingToast.dismiss();
    stoppingAppSessionKey.value = "";
  }
}

async function forkCardSession(card: AiBoardCard, mode: "current" | "managed-worktree" = "current", throughTurnId?: string) {
  if (!throughTurnId && (card.session.status === "running" || card.session.status === "waiting")) {
    pendingBusyFork.value = { card, mode, throughTurnId };
    return;
  }
  await performCardFork(card, mode, throughTurnId);
}

function confirmBusyFork() {
  const pending = pendingBusyFork.value;
  pendingBusyFork.value = undefined;
  if (pending) void performCardFork(pending.card, pending.mode, pending.throughTurnId);
}

async function performCardFork(card: AiBoardCard, mode: "current" | "managed-worktree", throughTurnId?: string) {
  if (forkingSessionKey.value || card.session.actions?.fork !== true) return;
  forkingSessionKey.value = card.key;
  const requestKey = `${card.key}:${mode}:${throughTurnId || "latest"}`;
  const clientRequestId = forkRequestIds.get(requestKey) || createBrowserUuid();
  forkRequestIds.set(requestKey, clientRequestId);
  const loadingToast = showDelayedControlPlaneLoadingToast(t("sessions.actions.forking"));
  try {
    const result = await forkAiSession(card.instance.id, card.session.id, { clientRequestId, ...(throughTurnId ? { throughTurnId } : {}), workspace: { mode } });
    const forkedCard = await waitForAiSessionProjection(() => allCards.value.find(
      (candidate) => candidate.instance.id === card.instance.id
        && candidate.session.id === result.aiSessionId
        && candidate.session.providerSessionId === result.providerSessionId,
    ));
    if (!forkedCard) throw new Error(t("sessions.panel.forkProjectionPending"));
    selectCard(forkedCard.key);
    forkRequestIds.delete(requestKey);
  } catch (error) {
    loadingToast.dismiss();
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.forkFailed")));
  } finally {
    loadingToast.dismiss();
    forkingSessionKey.value = "";
  }
}

async function openCardApp(instance: InstanceWithAiSessions, session?: AiSessionSummary) {
  if (!session) return;
  if (session.appSessionId) {
    emit("openAiSessionApp", instance, session);
    return;
  }
  try {
    emit("openAiSessionApp", instance, session);
    const result = await openAiSessionApp(instance.id, session.id, createBrowserUuid());
    emit("openAiSessionApp", instance, aiSessionAppNavigationTarget(session, result));
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.openAppFailed")));
    await refreshBoard();
  }
}

async function runSelectedQueueAction(action: (card: AiBoardCard) => Promise<unknown>, message: string) {
  const card = selectedCard.value;
  if (!card || aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    await action(card);
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, message));
  } finally {
    aiSessionActionBusy.value = false;
  }
}

function openSelectedAiSessionApp() {
  const card = selectedCard.value;
  if (card) {
    emit("openAiSessionApp", card.instance, card.session);
  }
}

watch(selectedCard, (card) => {
  if (!card && selectedCardKey.value) {
    clearSelectedCard();
  }
});

watch(visibleColumnKeysSignature, () => {
  const card = selectedCard.value;
  if (card && !visibleColumnKeys.value.has(cardColumnKey(card))) {
    clearSelectedCard();
  }
});

useEventListener(document, "click", closeBoardOverlays, { capture: true });

watch(() => selectedCard.value?.session.id, (sessionId) => {
  queueComposerEdit.value = undefined;
  const draft = sessionId ? loadAiSessionDraftPayload(sessionId) : { value: "", bindings: [] };
  messageDraft.value = draft.value;
  messageMentionBindings.value = draft.bindings;
}, { immediate: true });

watch(() => ({
  key: selectedCard.value?.key,
  unread: selectedCard.value?.session.unread,
  updatedAt: selectedCard.value?.session.updatedAt,
}), (current, previous) => {
  const card = selectedCard.value;
  if (!card || detailCollapsed.value || !current.unread) return;
  if (current.key !== previous?.key || !previous.unread || current.updatedAt !== previous.updatedAt) {
    void markAiSessionRead(card.instance.id, card.session.id, card.session.updatedAt).catch(() => undefined);
  }
});

watch(detailCollapsed, (collapsed, previous) => {
  const card = selectedCard.value;
  if (previous && !collapsed && card?.session.unread) {
    void markAiSessionRead(card.instance.id, card.session.id, card.session.updatedAt).catch(() => undefined);
  }
});

watch([() => selectedCard.value?.session.id, messageDraft, messageMentionBindings], ([sessionId, draft, bindings]) => {
  if (sessionId && !queueComposerEdit.value) {
    persistAiSessionDraftPayload(sessionId, draft, bindings);
  }
}, { deep: true });
</script>

<style scoped>
.ai-board-view {
  display: grid;
  position: relative;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 10px;
  min-height: 0;
  overflow: hidden;
  background: var(--ai-board-background);
  padding: 10px;
}

.ai-board-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 0 0 2px;
}

.ai-board-toolbar-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 8px;
}

.ai-board-toolbar-actions > small {
  flex: 0 0 auto;
  color: var(--ai-board-muted);
  font-size: 12px;
}

.ai-board-options-trigger {
  width: 30px;
  height: 30px;
  min-height: 0;
  border-color: var(--ai-board-control-border);
  border-radius: 7px;
  background: var(--ai-board-control-bg);
  color: var(--ai-board-muted);
  padding: 0;
}

.ai-board-options-trigger:hover,
.ai-board-options-trigger:focus-visible,
.ai-board-options-trigger[data-state="open"] {
  border-color: var(--ai-board-active-border);
  color: var(--ai-board-title);
}

.ai-board-options-menu {
  display: grid;
  width: 184px;
  gap: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-inset);
  box-shadow: var(--shadow-popover);
  padding: 5px;
}

.ai-board-options-label {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
  line-height: 1;
  padding: 7px 8px 5px;
}

.ai-board-options-separator {
  margin: 4px -5px;
  background: var(--surface-active);
}

.ai-board-options-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 30px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--control-plane-menu-text);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  padding: 0 8px 0 28px;
  text-align: left;
}

.ai-board-options-item:hover,
.ai-board-options-item:focus-visible,
.ai-board-options-item[data-highlighted] {
  background: var(--surface-active);
  color: var(--control-plane-menu-hover-text);
  outline: none;
}

.ai-board-options-item :deep(.absolute) {
  left: 8px;
  width: 12px;
  height: 12px;
}

.ai-board-options-item :deep(svg) {
  width: 9px;
  height: 9px;
}

.ai-board-filter-group,
.ai-board-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
  gap: 6px;
}

.ai-board-layout-toggle {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  height: 30px;
  overflow: hidden;
  border: 1px solid var(--ai-board-control-border);
  border-radius: 7px;
  background: var(--ai-board-control-bg);
}

.ai-board-layout-toggle button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 32px;
  min-width: 0;
  border: 0;
  border-right: 1px solid var(--ai-board-control-border);
  background: transparent;
  color: var(--ai-board-muted);
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  font-weight: 800;
  padding: 0;
  white-space: nowrap;
}

.ai-board-layout-toggle button:last-child {
  border-right: 0;
}

.ai-board-layout-toggle button[aria-pressed="true"] {
  background: var(--ai-board-chip-bg);
  color: var(--ai-board-active-text);
}

.ai-board-layout-toggle button:hover {
  color: var(--ai-board-title);
}

.ai-board-layout-toggle button:focus-visible {
  position: relative;
  z-index: 1;
  outline: 2px solid var(--ai-board-active-border);
  outline-offset: -2px;
}

.ai-board-search {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  width: min(260px, 30vw);
  min-width: 170px;
  height: 30px;
  border: 1px solid var(--ai-board-control-border);
  border-radius: 7px;
  background: var(--ai-board-control-bg);
  color: var(--ai-board-muted);
  padding: 0 9px;
}

.ai-board-search input {
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--ai-board-input-text);
  font-size: 12px;
  outline: none;
}

.ai-board-search input::placeholder {
  color: var(--ai-board-placeholder);
}

.ai-board-chips button,
.ai-board-chips strong {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  border: 1px solid var(--ai-board-chip-border);
  border-radius: 999px;
  background: var(--ai-board-chip-bg);
  color: var(--ai-board-chip-text);
  font-size: 11px;
  font-weight: 800;
  padding: 0 7px;
  white-space: nowrap;
}

.ai-board-chips button {
  cursor: pointer;
  font-family: inherit;
}

.ai-board-chips button[data-active="false"] {
  opacity: 0.45;
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}

.ai-board-chips button:hover {
  opacity: 0.82;
}

.ai-board-chips button:focus-visible {
  outline: 2px solid var(--ai-board-active-border);
  outline-offset: 2px;
}

.ai-board-chips button[data-active="true"]:hover {
  opacity: 1;
}

.ai-board-chips button:active {
  transform: translateY(1px);
}

.ai-board-chips button[data-tone="active"],
.ai-board-chips strong[data-tone="active"] {
  border-color: var(--ai-board-active-border);
  color: var(--ai-board-active-text);
}

.ai-board-chips button[data-tone="waiting"],
.ai-board-chips strong[data-tone="waiting"] {
  border-color: var(--ai-board-waiting-border);
  color: var(--ai-board-waiting-text);
}

.ai-board-chips button[data-tone="problem"],
.ai-board-chips strong[data-tone="problem"] {
  border-color: var(--ai-board-stale-border);
  color: var(--ai-board-stale-text);
}

.ai-board-chips strong[data-tone="online"] {
  border-color: var(--ai-board-online-border);
  color: var(--ai-board-online-text);
}

.ai-board-columns-scroll {
  min-width: 0;
  min-height: 0;
}

.ai-board-grid-scroll {
  min-width: 0;
  min-height: 0;
}

.ai-board-columns {
  display: grid;
  grid-template-columns: repeat(var(--ai-board-visible-column-count), minmax(0, 1fr));
  gap: 12px;
  width: 100%;
  min-width: 0;
  min-height: 100%;
}

.ai-board-column {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: visible;
  border-radius: 8px;
  background: var(--ai-board-column-bg);
}

.ai-board-column-head-mask {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--workspace-bg);
}

.ai-board-column-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  border: 1px solid var(--ai-board-column-border);
  border-radius: 8px 8px 0 0;
  background: var(--ai-board-column-head-bg);
  padding: 10px;
}

.ai-board-column[data-tone="waiting"] .ai-board-column-head {
  border-top-color: var(--ai-board-column-waiting-border);
  border-right-color: var(--ai-board-column-waiting-border);
  border-left-color: var(--ai-board-column-waiting-border);
  background: linear-gradient(var(--ai-board-waiting-head-bg), var(--ai-board-waiting-head-bg)), var(--ai-board-column-head-bg);
}

.ai-board-column[data-tone="problem"] .ai-board-column-head {
  border-top-color: var(--ai-board-column-problem-border);
  border-right-color: var(--ai-board-column-problem-border);
  border-left-color: var(--ai-board-column-problem-border);
  background: linear-gradient(var(--ai-board-problem-head-bg), var(--ai-board-problem-head-bg)), var(--ai-board-column-head-bg);
}

.ai-board-column-head span {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.ai-board-column-head strong,
.ai-board-column-head small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ai-board-column-head strong {
  color: var(--ai-board-title);
  font-size: 13px;
  font-weight: 850;
  line-height: 1.2;
  white-space: nowrap;
}

.ai-board-column-head small {
  display: -webkit-box;
  color: var(--ai-board-muted);
  font-size: 11px;
  line-height: 1.28;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.ai-board-column-head b {
  display: grid;
  min-width: 24px;
  height: 22px;
  place-items: center;
  border-radius: 999px;
  background: var(--ai-board-column-count-bg);
  color: var(--ai-board-chip-text);
  font-size: 11px;
}

.ai-board-column[data-tone="waiting"] .ai-board-column-head b {
  background: var(--ai-board-column-waiting-count-bg);
  color: var(--ai-board-waiting-text);
}

.ai-board-column[data-tone="problem"] .ai-board-column-head b {
  background: var(--ai-board-column-problem-count-bg);
  color: var(--ai-board-stale-text);
}

.ai-board-column-body-content {
  display: flex;
  position: relative;
  z-index: 1;
  flex: 1 0 auto;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
  border: solid var(--ai-board-column-border);
  border-width: 0 1px 1px;
  border-radius: 0 0 8px 8px;
  padding: 8px 10px 190px;
}

.ai-board-column[data-tone="waiting"] .ai-board-column-body-content {
  border-color: var(--ai-board-column-waiting-border);
}

.ai-board-column[data-tone="problem"] .ai-board-column-body-content {
  border-color: var(--ai-board-column-problem-border);
}

.ai-board-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  align-content: start;
  gap: 10px;
  min-width: 0;
  min-height: 100%;
  padding: 0 0 190px;
}

.ai-board-grid-group-label {
  display: flex;
  grid-column: 1 / -1;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  border-bottom: 1px solid var(--ai-board-column-border);
  color: var(--ai-board-title);
  font-size: 12px;
  font-weight: 800;
  padding: 8px 2px 6px;
}

.ai-board-grid-group-label span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-board-grid-group-workspace {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
}

.ai-board-grid-group-workspace b {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--ai-board-title);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-board-grid-group-label strong {
  flex: 0 0 auto;
  color: var(--ai-board-muted);
  font-size: 11px;
}

:global(.ai-session-path-tooltip) {
  max-width: min(480px, calc(100vw - 24px));
  overflow-wrap: anywhere;
  border: 1px solid var(--line-strong);
  background: var(--surface-overlay) !important;
  box-shadow: var(--shadow-popover);
  color: var(--text) !important;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 11px;
  font-weight: 450;
  line-height: 1.4;
  padding: 6px 9px;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
}

.ai-board-empty {
  display: grid;
  place-items: center;
  min-height: 260px;
  border: 1px dashed var(--ai-board-empty-border);
  border-radius: 8px;
  background: var(--ai-board-empty-bg);
  color: var(--ai-board-empty-text);
  font-size: 13px;
  padding: 28px;
  text-align: center;
}

.ai-board-empty.error {
  color: var(--ai-board-empty-error);
}

.ai-board-column-empty {
  box-sizing: border-box;
  display: grid;
  width: 100%;
  min-height: 120px;
  place-items: center;
  border: 1px dashed var(--ai-board-empty-border);
  border-radius: 8px;
  color: var(--ai-board-column-empty-text);
  font-size: 12px;
  text-align: center;
}

.ai-board-grid-empty {
  box-sizing: border-box;
  display: grid;
  min-height: 180px;
  place-items: center;
  border: 1px dashed var(--ai-board-empty-border);
  border-radius: 8px;
  color: var(--ai-board-column-empty-text);
  font-size: 12px;
  text-align: center;
}

.ai-board-floating-dock-fade-enter-active,
.ai-board-floating-dock-fade-leave-active {
  transition: opacity 100ms ease;
}

.ai-board-floating-dock-fade-enter-from,
.ai-board-floating-dock-fade-leave-to {
  opacity: 0;
}

@media (max-width: 780px) {
  .ai-board-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .ai-board-search {
    width: 100%;
  }

  .ai-board-columns {
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
  }

  .ai-board-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
