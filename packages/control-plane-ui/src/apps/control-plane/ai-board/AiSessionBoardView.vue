<template>
  <section class="ai-board-view" aria-label="AI session board">
    <div v-if="loading" class="ai-board-empty">Loading AI sessions...</div>
    <div v-else-if="error" class="ai-board-empty error">{{ error }}</div>
    <template v-else>
      <div class="ai-board-toolbar">
        <div class="ai-board-filter-group">
          <span class="ai-board-layout-toggle" aria-label="AI board layout">
            <button type="button" :aria-pressed="layoutMode === 'columns'" title="Column layout" @click="setLayoutMode('columns')">
              <Columns3 :size="14" />
            </button>
            <button type="button" :aria-pressed="layoutMode === 'grid'" title="Grid layout" @click="setLayoutMode('grid')">
              <LayoutGrid :size="14" />
            </button>
          </span>
          <label class="ai-board-search">
            <Search :size="14" />
            <input :value="filter" placeholder="Search AI sessions" @input="emit('update:filter', ($event.target as HTMLInputElement).value)" />
          </label>
          <span class="ai-board-chips" aria-label="AI session counts">
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
            <strong data-tone="online">{{ summary.instancesOnline }} Instances online</strong>
          </span>
        </div>
        <small>{{ layoutVisibleCards.length }} bound sessions · {{ totalBoundSessions }} total</small>
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
                :expanded-kind="expandedPreview?.key === card.key ? expandedPreview.kind : undefined"
                :instance-display-name="instanceDisplayName"
                :is-trigger-bound="isTriggerBound"
                :prompt-count="promptCount(card.session)"
                :prompt-index="promptIndexFor(card)"
                :selected="selectedCardKey === card.key"
                :short-hash="shortHash"
                :stopping-app-session-key="stoppingAppSessionKey"
                :trigger-action-key="triggerActionKey"
                :trigger-busy-key="triggerBusyKey"
                :trigger-button-title="triggerButtonTitle"
                :trigger-templates="triggerTemplates"
                @collapse-expanded-preview="collapseExpandedPreview"
                @expand-message="expandMessage"
                @expand-prompt="expandPrompt"
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
          <AiSessionCard
            v-for="card in layoutVisibleCards"
            :key="card.key"
            :approval-busy-key="approvalBusyKey"
            :bound-triggers="boundTriggers"
            :can-resolve-approval="canResolveApproval"
            :card="card"
            :expanded-kind="expandedPreview?.key === card.key ? expandedPreview.kind : undefined"
            :instance-display-name="instanceDisplayName"
            :is-trigger-bound="isTriggerBound"
            :prompt-count="promptCount(card.session)"
            :prompt-index="promptIndexFor(card)"
            :selected="selectedCardKey === card.key"
            :short-hash="shortHash"
            :stopping-app-session-key="stoppingAppSessionKey"
            :trigger-action-key="triggerActionKey"
            :trigger-busy-key="triggerBusyKey"
            :trigger-button-title="triggerButtonTitle"
            :trigger-templates="triggerTemplates"
            @collapse-expanded-preview="collapseExpandedPreview"
            @expand-message="expandMessage"
            @expand-prompt="expandPrompt"
            @next-prompt="nextPrompt"
            @open-ai-session-app="(instance, session) => emit('openAiSessionApp', instance, session)"
            @previous-prompt="previousPrompt"
            @resolve-approval="(instance, session, decision) => emit('resolveApproval', instance, session, decision)"
            @select-card="selectCard"
            @select-instance="emit('selectInstance', $event)"
            @stop-app-session="stopCardAppSession"
            @toggle-trigger="toggleTrigger"
          />

          <div v-if="!layoutVisibleCards.length" class="ai-board-grid-empty">
            No matching AI sessions
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
          :instance-display-name="instanceDisplayName"
          :prompt-index="promptIndexFor(selectedCard)"
          @add-context="openSelectedAiSessionApp"
          @open-ai-session-app="(instance, session) => emit('openAiSessionApp', instance, session)"
          @remove-queued-message="removeSelectedQueuedMessage"
          @resolve-approval="resolveSelectedApproval"
          @retry-queued-message="retrySelectedQueuedMessage"
          @run="runSelectedSessionAction"
          @steer="steerMessageDraft"
          @steer-queued-message="steerSelectedQueuedMessage"
          @update:attachments="messageAttachments = $event"
          @update:draft="messageDraft = $event"
        />
      </Transition>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { Columns3, LayoutGrid, Search } from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import { interruptAiSession, removeAiSessionQueuedMessage, resolveAiSessionApproval, retryAiSessionQueuedMessage, sendAiSessionMessage, steerAiSessionQueuedMessage, stopAppSession, uploadAiSessionAttachment } from "../../../api/queries";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions } from "../../../api/types";
import type { AiSessionComposerAttachment } from "../../../components/ai-session/AiSessionComposer.vue";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import {
  aiSessionAppTab,
  aiSessionPriority,
  aiSessionStableSortKey,
  aiSessionUserPrompts,
  appDisplayName,
  displayAiSessionMessage,
  displayAiSessionTitle,
  sortedAiSessions,
  sessionDisplayName,
} from "../useInstanceSessions";
import AiSessionCard from "./AiSessionCard.vue";
import AiSessionFloatingDock from "./AiSessionFloatingDock.vue";
import type { AiBoardCard, AiBoardColumnKey } from "./aiBoardTypes";
import { useAiBoardTriggers } from "./useAiBoardTriggers";

const AI_BOARD_VISIBLE_COLUMNS_STORAGE_KEY = "task-handoff.control-plane.ai-board.visible-columns";
const AI_BOARD_LAYOUT_STORAGE_KEY = "task-handoff.control-plane.ai-board.layout";
const DEFAULT_VISIBLE_COLUMN_KEYS: AiBoardColumnKey[] = ["running", "waiting", "idle-open", "problem"];
type AiBoardLayoutMode = "columns" | "grid";

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

const promptIndexes = ref<Record<string, { index: number; count: number }>>({});
const expandedPreview = ref<{ key: string; kind: "prompt" | "message" }>();
const visibleColumnKeys = ref(loadVisibleColumnKeys());
const layoutMode = ref<AiBoardLayoutMode>(loadLayoutMode());
const selectedCardKey = ref("");
const detailCollapsed = ref(false);
const messageDraft = ref("");
const messageAttachments = ref<AiSessionComposerAttachment[]>([]);
const aiSessionActionBusy = ref(false);
const stoppingAppSessionKey = ref("");
const queryClient = useQueryClient();
const {
  boundTriggers,
  isTriggerBound,
  shortHash,
  toggleTrigger,
  triggerActionKey,
  triggerBusyKey,
  triggerButtonTitle,
  triggerTemplates,
} = useAiBoardTriggers();

const allCards = computed<AiBoardCard[]>(() => {
  const cards: AiBoardCard[] = [];
  for (const instance of props.instances) {
    for (const session of sortedAiSessions(instance.aiSessions?.sessions)) {
      const appTab = aiSessionAppTab(instance, session);
      cards.push({
        appTab: appTab || { key: "ai-sessions", label: "AI Sessions", status: session.status, kind: "ai" },
        instance,
        key: `${instance.id}:${session.id}`,
        session,
      });
    }
  }
  return cards.sort((a, b) => {
    const priorityDelta = aiSessionPriority(b.session) - aiSessionPriority(a.session);
    if (priorityDelta) {
      return priorityDelta;
    }
    const instanceDelta = props.instanceDisplayName(a.instance).localeCompare(props.instanceDisplayName(b.instance)) || a.instance.id.localeCompare(b.instance.id);
    return instanceDelta || aiSessionStableSortKey(a.session).localeCompare(aiSessionStableSortKey(b.session));
  });
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
      displayAiSessionTitle(card.session, promptIndexFor(card)),
      displayAiSessionMessage(card.session, promptIndexFor(card)),
      sessionDisplayName(card.appTab),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(term);
  });
});

const totalBoundSessions = computed(() => allCards.value.length);
const selectedCard = computed(() => allCards.value.find((card) => card.key === selectedCardKey.value));
const layoutVisibleCards = computed(() => visibleCards.value.filter((card) => visibleColumnKeys.value.has(cardColumnKey(card))));
const summary = computed(() => ({
  idleOpen: allCards.value.filter((card) => cardColumnKey(card) === "idle-open").length,
  instancesOnline: props.instances.filter((instance) => instance.connectionStatus === "online").length,
  problem: allCards.value.filter((card) => cardColumnKey(card) === "problem").length,
  running: allCards.value.filter((card) => cardColumnKey(card) === "running").length,
  waiting: allCards.value.filter((card) => cardColumnKey(card) === "waiting").length,
}));

const statusFilterOptions = computed<Array<{ count: number; key: AiBoardColumnKey; label: string; tone: string }>>(() => [
  { count: summary.value.running, key: "running", label: "Running", tone: "active" },
  { count: summary.value.waiting, key: "waiting", label: "Waiting approval", tone: "waiting" },
  { count: summary.value.idleOpen, key: "idle-open", label: "Idle with shell open", tone: "idle" },
  { count: summary.value.problem, key: "problem", label: "Problem", tone: "problem" },
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
      description: "正在执行、思考、调用工具或编辑文件",
      empty: "No running AI sessions",
      key: "running",
      title: "Running",
      tone: "active",
    },
    {
      cards: [],
      description: "等审批或等用户输入，优先处理",
      empty: "No sessions waiting",
      key: "waiting",
      title: "Waiting",
      tone: "waiting",
    },
    {
      cards: [],
      description: "AI 空闲，但 app session 仍打开",
      empty: "No idle open sessions",
      key: "idle-open",
      title: "Idle / Open",
      tone: "idle",
    },
    {
      cards: [],
      description: "失败但 app session 仍存在",
      empty: "No problem sessions",
      key: "problem",
      title: "Problem",
      tone: "problem",
    },
  ];
  const byKey = new Map(columns.map((column) => [column.key, column]));
  for (const card of visibleCards.value) {
    byKey.get(cardColumnKey(card))?.cards.push(card);
  }
  return columns.filter((column) => visibleColumnKeys.value.has(column.key));
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

function promptCount(session: AiSessionSummary) {
  return aiSessionUserPrompts(session).length;
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
    [card.key]: { index: (index + count) % count, count },
  };
}

function previousPrompt(card: AiBoardCard) {
  setPromptIndex(card, promptIndexFor(card) - 1);
}

function nextPrompt(card: AiBoardCard) {
  setPromptIndex(card, promptIndexFor(card) + 1);
}

function canResolveApproval(session: AiSessionSummary) {
  return session.status === "waiting" && session.phase === "approval" && Boolean(session.actions?.approval);
}

function canInterrupt(session: AiSessionSummary) {
  return Boolean(session.actions?.interrupt);
}

function selectCard(key: string) {
  selectedCardKey.value = key;
  expandedPreview.value = undefined;
}

function toggleExpandedPreview(key: string, kind: "prompt" | "message") {
  const current = expandedPreview.value;
  expandedPreview.value = current?.key === key && current.kind === kind ? undefined : { key, kind };
}

function expandPrompt(key: string) {
  toggleExpandedPreview(key, "prompt");
}

function expandMessage(key: string) {
  toggleExpandedPreview(key, "message");
}

function collapseExpandedPreview() {
  expandedPreview.value = undefined;
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
  if (!target.closest(".ai-board-expanded-preview") && !target.closest("[data-ai-preview-trigger]")) {
    expandedPreview.value = undefined;
  }
  if (target.closest(".ai-board-card") || target.closest(".ai-board-floating-dock")) {
    return;
  }
  clearSelectedCard();
}

async function refreshBoard() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["instance-board"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-ai-sessions"] }),
  ]);
}

async function runSelectedSessionAction() {
  const card = selectedCard.value;
  if (!card || aiSessionActionBusy.value || (!messageDraft.value.trim() && !messageAttachments.value.length && !canInterrupt(card.session))) {
    return;
  }
  if (messageDraft.value.trim() || messageAttachments.value.length) {
    await sendSelectedSessionMessage();
    return;
  }
  await interruptSelectedSession();
}

async function uploadMessageAttachments(instanceId: string, sessionId: string) {
  return Promise.all(messageAttachments.value.map((attachment) => uploadAiSessionAttachment({
    instanceId,
    sessionId,
    kind: "image",
    name: attachment.name,
    mime: attachment.mime,
    data: attachment.dataUrl,
  })));
}

async function sendSelectedSessionMessage() {
  const card = selectedCard.value;
  const message = messageDraft.value.trim();
  if (!card || (!message && !messageAttachments.value.length) || aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    const attachments = await uploadMessageAttachments(card.instance.id, card.session.id);
    await sendAiSessionMessage(card.instance.id, card.session.id, message || "请查看附件图片。", undefined, attachments.map((attachment) => ({ id: attachment.id, kind: attachment.kind })));
    messageDraft.value = "";
    messageAttachments.value = [];
    await refreshBoard();
  } catch (error) {
    showControlPlaneToast(error instanceof Error ? error.message : "Failed to send message.");
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
    await sendAiSessionMessage(card.instance.id, card.session.id, message || "请查看附件图片。", "steer", attachments.map((attachment) => ({ id: attachment.id, kind: attachment.kind })));
    messageDraft.value = "";
    messageAttachments.value = [];
    await refreshBoard();
  } catch (error) {
    showControlPlaneToast(error instanceof Error ? error.message : "Failed to steer message.");
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
    showControlPlaneToast(error instanceof Error ? error.message : "Failed to stop AI session.");
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
    showControlPlaneToast(error instanceof Error ? error.message : "Failed to resolve approval.");
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function steerSelectedQueuedMessage(queueId: string) {
  await runSelectedQueueAction((card) => steerAiSessionQueuedMessage(card.instance.id, card.session.id, queueId), "Failed to steer queued message.");
}

async function retrySelectedQueuedMessage(queueId: string) {
  await runSelectedQueueAction((card) => retryAiSessionQueuedMessage(card.instance.id, card.session.id, queueId), "Failed to retry queued message.");
}

async function removeSelectedQueuedMessage(queueId: string) {
  await runSelectedQueueAction((card) => removeAiSessionQueuedMessage(card.instance.id, card.session.id, queueId), "Failed to remove queued message.");
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
    showControlPlaneToast(error instanceof Error ? error.message : "Failed to close app session.");
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
    showControlPlaneToast(error instanceof Error ? error.message : message);
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

.ai-board-toolbar > small {
  flex: 0 0 auto;
  color: var(--ai-board-muted);
  font-size: 12px;
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
