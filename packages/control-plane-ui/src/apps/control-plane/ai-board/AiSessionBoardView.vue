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
            <header class="ai-board-column-head">
              <span>
                <strong>{{ column.title }}</strong>
                <small>{{ column.description }}</small>
              </span>
              <b>{{ column.cards.length }}</b>
            </header>

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
                :trigger-action-key="triggerActionKey"
                :trigger-busy-key="triggerBusyKey"
                :trigger-button-title="triggerButtonTitle"
                :trigger-templates="triggerTemplates"
                @next-prompt="nextPrompt"
                @open-ai-session-app="(instance, session) => emit('openAiSessionApp', instance, session)"
                @previous-prompt="previousPrompt"
                @resolve-approval="(instance, session, decision) => emit('resolveApproval', instance, session, decision)"
                @select-card="selectCard"
                @select-instance="emit('selectInstance', $event)"
                @stop-app-session="stopCardAppSession"
                @toggle-trigger="toggleTrigger"
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
              :trigger-action-key="triggerActionKey"
              :trigger-busy-key="triggerBusyKey"
              :trigger-button-title="triggerButtonTitle"
              :trigger-templates="triggerTemplates"
              @next-prompt="nextPrompt"
              @open-ai-session-app="(instance, session) => emit('openAiSessionApp', instance, session)"
              @previous-prompt="previousPrompt"
              @resolve-approval="(instance, session, decision) => emit('resolveApproval', instance, session, decision)"
              @select-card="selectCard"
              @select-instance="emit('selectInstance', $event)"
              @stop-app-session="stopCardAppSession"
              @toggle-trigger="toggleTrigger"
            />
          </template>

          <div v-if="!layoutVisibleCards.length" class="ai-board-grid-empty">
            {{ t("sessions.board.noMatches") }}
          </div>
        </div>
      </ScrollArea>

      <Transition name="ai-board-floating-dock-fade">
        <AiSessionFloatingDock
          v-if="selectedCard"
          v-model:collapsed="detailCollapsed"
          :busy="aiSessionActionBusy"
          :can-interrupt="canInterrupt(selectedCard.session)"
          :can-resolve-approval="canResolveApproval(selectedCard.session)"
          :card="selectedCard"
          :attachments="messageAttachments"
          :draft="messageDraft"
          :mention-bindings="messageMentionBindings"
          :mention-context="mentionContext"
          :mention-trigger="mentionTrigger"
          :command-trigger="commandTrigger"
          :session-busy="selectedCard.session.status === 'running' || selectedCard.session.status === 'waiting'"
          :instance-display-name="instanceDisplayName"
          :prompt-count="promptCount(selectedCard.session)"
          :prompt-index="promptIndexFor(selectedCard)"
          @next-prompt="nextPrompt(selectedCard)"
          @open-ai-session-app="(instance, session) => emit('openAiSessionApp', instance, session)"
          @previous-prompt="previousPrompt(selectedCard)"
          @remove-queued-message="removeSelectedQueuedMessage"
          @resolve-approval="resolveSelectedApproval"
          @retry-queued-message="retrySelectedQueuedMessage"
          @run="runSelectedSessionAction"
          @command="executeSelectedSessionCommand"
          @steer="steerMessageDraft"
          @steer-queued-message="steerSelectedQueuedMessage"
          @update:attachments="messageAttachments = $event"
          @update:draft="messageDraft = $event"
          @update:mention-bindings="messageMentionBindings = $event"
        />
      </Transition>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { compareNaturalText, compareTechnicalIdentifiers } from "../../../i18n/presentation";
import type { SupportedLocale } from "../../../i18n/locale";
import { translateApiError } from "../../../i18n/apiError";
import { useEventListener } from "@vueuse/core";
import { Columns3, LayoutGrid, Search, SlidersHorizontal } from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import { interruptAiSession, markAiSessionRead, removeAiSessionQueuedMessage, resolveAiSessionApproval, retryAiSessionQueuedMessage, sendAiSessionMessage, steerAiSessionQueuedMessage, stopAppSession, uploadAiSessionAttachment, useControlPlaneSettingsQuery } from "../../../api/queries";
import { controlPlaneQueryKeys } from "../../../api/queryKeys.ts";
import { executeAiSessionCommand } from "../../../api/ai-session-commands";
import type { AiSessionCommandInput, AiSessionPermissionMode } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions } from "../../../api/types";
import type { AiSessionComposerAttachment } from "../../../components/ai-session/AiSessionComposer.vue";
import { referencesForBindings, type AiSessionMentionBinding } from "../../../components/ai-session/mentions";
import { desktopRuntimePathAccess } from "../../../components/ai-session/useAiSessionMentions";
import { Button } from "../../../components/ui/button";
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
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { aiSessionMessageText, clearAiSessionDraft, loadAiSessionDraftPayload, persistAiSessionDraftPayload } from "../useAiSessionDraft";
import {
  aiSessionAppTab,
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
}>();

const emit = defineEmits<{
  openAiSessionApp: [instance: InstanceWithAiSessions, session?: AiSessionSummary];
  resolveApproval: [instance: InstanceWithAiSessions, session: AiSessionSummary, decision: "allow" | "deny" | "skip"];
  selectInstance: [instanceId: string];
  "update:filter": [value: string];
}>();
const { locale, t } = useI18n();

const promptIndexes = ref<Record<string, { index: number; count: number }>>({});
const visibleColumnKeys = ref(loadVisibleColumnKeys());
const layoutMode = ref<AiBoardLayoutMode>(loadLayoutMode());
const gridGroupBy = ref<AiBoardGridGroupBy>(loadGridGroupBy());
const gridSortByStatus = ref(loadGridSortByStatus());
const selectedCardKey = ref("");
const detailCollapsed = ref(false);
const messageDraft = ref("");
const messageAttachments = ref<AiSessionComposerAttachment[]>([]);
const messageMentionBindings = ref<AiSessionMentionBinding[]>([]);
const aiSessionActionBusy = ref(false);
const stoppingAppSessionKey = ref("");
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
  triggerButtonTitle,
  triggerTemplates,
} = useAiBoardTriggers(t);

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
  return { key: path || "__unknown_path__", label: path || t("sessions.board.unknownPath") };
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
  return aiSessionTurns(session).length;
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

function setPromptIndex(card: AiBoardCard, index: number) {
  const count = promptCount(card.session);
  if (!count) {
    return;
  }
  promptIndexes.value = {
    ...promptIndexes.value,
    [card.key]: { index: Math.min(Math.max(index, 0), count - 1), count },
  };
}

function previousPrompt(card: AiBoardCard) {
  setPromptIndex(card, promptIndexFor(card) - 1);
}

function nextPrompt(card: AiBoardCard) {
  setPromptIndex(card, promptIndexFor(card) + 1);
}

function canResolveApproval(session: AiSessionSummary) {
  return session.status === "waiting" && session.phase === "approval";
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
  if (messageDraft.value.trim() || messageAttachments.value.length) {
    await sendSelectedSessionMessage(permissionMode);
    return;
  }
  await interruptSelectedSession();
}

async function uploadMessageAttachments(instanceId: string, sessionId: string) {
  return Promise.all(messageAttachments.value.map(async (attachment) => {
    if (attachment.source.type === "runtime-path") {
      return { id: attachment.id, kind: attachment.kind, name: attachment.name, mime: attachment.mime, size: attachment.size, source: attachment.source };
    }
    if (!attachment.dataUrl) throw new Error(t("sessions.panel.attachmentUnavailable", { name: attachment.name }));
    const uploaded = await uploadAiSessionAttachment({ instanceId, sessionId, kind: attachment.kind, name: attachment.name, mime: attachment.mime, data: attachment.dataUrl });
    return { id: uploaded.id, kind: uploaded.kind, source: { type: "upload-ref" as const } };
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
    await refreshBoard();
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
    await refreshBoard();
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
    await refreshBoard();
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
    await refreshBoard();
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
    await refreshBoard();
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

async function stopCardAppSession(card: AiBoardCard) {
  const sessionId = appSessionIdFor(card);
  if (!sessionId || stoppingAppSessionKey.value) {
    return;
  }
  stoppingAppSessionKey.value = card.key;
  try {
    await stopAppSession(card.instance.id, sessionId);
    await refreshBoard();
    if (selectedCardKey.value === card.key) {
      clearSelectedCard();
    }
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("sessions.panel.closeAppFailed")));
    await refreshBoard();
  } finally {
    stoppingAppSessionKey.value = "";
  }
}

function appSessionIdFor(card: AiBoardCard) {
  return typeof card.appTab.source?.id === "string" ? card.appTab.source.id : card.appTab.key;
}

async function runSelectedQueueAction(action: (card: AiBoardCard) => Promise<unknown>, message: string) {
  const card = selectedCard.value;
  if (!card || aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    await action(card);
    await refreshBoard();
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
  if (sessionId) {
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
  min-width: 0;
  min-height: 0;
  overflow: visible;
  border: 1px solid var(--ai-board-column-border);
  border-radius: 8px;
  background: var(--ai-board-column-bg);
}

.ai-board-column[data-tone="waiting"] {
  border-color: var(--ai-board-column-waiting-border);
}

.ai-board-column[data-tone="problem"] {
  border-color: var(--ai-board-column-problem-border);
}

.ai-board-column-head {
  display: flex;
  position: sticky;
  top: 0;
  z-index: 3;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
  border-bottom: 1px solid var(--ai-board-column-border);
  border-radius: 7px 7px 0 0;
  background: var(--ai-board-column-head-bg);
  padding: 10px;
}

.ai-board-column[data-tone="waiting"] .ai-board-column-head {
  background: var(--ai-board-waiting-head-bg);
}

.ai-board-column[data-tone="problem"] .ai-board-column-head {
  background: var(--ai-board-problem-head-bg);
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
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 100%;
  padding: 8px 10px 190px;
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
