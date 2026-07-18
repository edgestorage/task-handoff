<template>
  <div class="session-ai-panel" :style="workspaceStyle">
    <div class="session-ai-workspace">
      <aside class="session-ai-sidebar">
        <div class="session-ai-sidebar-head">
          <div class="session-ai-sidebar-actions">
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <button type="button" class="session-ai-filter-trigger">
                  <Filter :size="14" />
                  <span>{{ selectedStatusFilter.label }}</span>
                  <strong>{{ selectedStatusFilter.count }}</strong>
                  <ChevronDown :size="14" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent class="session-ai-filter-menu" align="end" :side-offset="6">
                <DropdownMenuLabel class="session-ai-filter-label">Status</DropdownMenuLabel>
                <DropdownMenuItem
                  v-for="option in statusFilterOptions"
                  :key="option.key"
                  class="session-ai-filter-item"
                  :data-selected="sessionStatusFilter === option.key ? 'true' : undefined"
                  @select="sessionStatusFilter = option.key"
                >
                  <Check v-if="sessionStatusFilter === option.key" :size="13" />
                  <span v-else class="session-ai-filter-check-spacer" />
                  <span>{{ option.label }}</span>
                  <strong>{{ option.count }}</strong>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="outline" size="sm" class="session-ai-options-trigger" aria-label="AI session list options" title="AI session list options">
                  <SlidersHorizontal :size="16" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent class="session-ai-options-menu" align="end" :side-offset="6">
                <DropdownMenuLabel class="session-ai-options-label">View</DropdownMenuLabel>
                <DropdownMenuCheckboxItem class="session-ai-options-item option-item" :model-value="groupSessionsByPath" @update:model-value="(value) => groupSessionsByPath = Boolean(value)">
                  Group by path
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem class="session-ai-options-item option-item" :model-value="sortSessionsByStatus" @update:model-value="(value) => sortSessionsByStatus = Boolean(value)">
                  Sort by status
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <ScrollArea class="session-ai-list">
          <div class="session-ai-list-content">
            <section
              v-for="group in displayedSessionGroups"
              :key="group.key"
              class="session-ai-path-group"
            >
              <button
                v-if="groupSessionsByPath"
                type="button"
                class="session-ai-path-group-head"
                :aria-expanded="!collapsedPathGroups[group.key]"
                :title="group.key"
                @click="togglePathGroup(group.key)"
              >
                <Folder class="session-ai-path-group-icon" :size="15" />
                <span class="session-ai-path-group-text">
                  <span class="session-ai-path-group-title">{{ group.label }}</span>
                  <small v-if="group.parentLabel">{{ group.parentLabel }}</small>
                </span>
                <ChevronRight class="session-ai-path-group-chevron" :class="{ open: !collapsedPathGroups[group.key] }" :size="15" />
                <strong>{{ group.sessions.length }}</strong>
              </button>
              <template v-if="!groupSessionsByPath || !collapsedPathGroups[group.key]">
                <article
                  v-for="session in group.sessions"
                  :key="session.id"
                  class="session-ai-row"
                  :data-state="session.status"
                  :data-selected="selectedSession?.id === session.id"
                >
                <div
                  class="session-ai-select"
                  role="button"
                  tabindex="0"
                  @click="selectSession(session.id)"
                  @keydown.enter.prevent="selectSession(session.id)"
                  @keydown.space.prevent="selectSession(session.id)"
                >
                  <div class="session-ai-state">
                    <span class="session-ai-dot" />
                    <strong>{{ aiSessionAppDisplayName(aiSessionAppTab(instance, session), session.agent) }}</strong>
                  </div>
                  <div class="session-ai-preview-field session-ai-preview-field-user">
                    <MarkdownContent class="session-ai-question" :content="displayAiSessionTitle(session, promptIndexFor(session))" />
                  </div>
                  <div class="session-ai-preview-field session-ai-preview-field-assistant">
                    <AiSessionStreamingMarkdown
                      class="session-ai-message"
                      :content="displayAiSessionMessage(session, promptIndexFor(session))"
                      :instance-id="instance.id"
                      :is-latest="promptIndexFor(session) >= promptCount(session) - 1"
                      :session-id="session.id"
                    />
                  </div>
                  <span v-if="promptCount(session) > 1" class="session-ai-turn-nav">
                    <button type="button" :aria-label="`Previous user message for ${session.agent}`" :disabled="promptIndexFor(session) <= 0" @click.stop="previousPrompt(session)">
                      <ChevronLeft :size="13" />
                    </button>
                    <small>{{ promptIndexFor(session) + 1 }} / {{ promptCount(session) }}</small>
                    <button type="button" :aria-label="`Next user message for ${session.agent}`" :disabled="promptIndexFor(session) >= promptCount(session) - 1" @click.stop="nextPrompt(session)">
                      <ChevronRight :size="13" />
                    </button>
                  </span>
                </div>
                <AiSessionToolActivity
                  v-if="!canResolveApproval(session)"
                  class="session-ai-card-activity"
                  :current-tool="session.currentTool"
                  :phase="session.phase"
                  :status="session.status"
                  :summary="session.summary"
                  :tool-calls-since-last-message="session.toolCallsSinceLastMessage"
                />
                <div v-if="canResolveApproval(session)" class="session-ai-card-approval-actions">
                  <button type="button" :disabled="aiSessionActionBusy" title="Allow" @click.stop="resolveApproval(session, 'allow')">
                    <Check :size="13" />
                    <span>Allow</span>
                  </button>
                  <button type="button" :disabled="aiSessionActionBusy" title="Skip" @click.stop="resolveApproval(session, 'skip')">
                    <Ban :size="13" />
                    <span>Skip</span>
                  </button>
                  <button type="button" :disabled="aiSessionActionBusy" title="Deny" @click.stop="resolveApproval(session, 'deny')">
                    <X :size="13" />
                    <span>Deny</span>
                  </button>
                </div>
                <div class="session-ai-card-tools" aria-label="AI session card controls">
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <button type="button" class="session-ai-trigger-button" :data-bound="boundTriggers(session).length ? 'true' : undefined" :title="triggerButtonTitle(session)" @click.stop>
                        <Zap :size="13" />
                        <small v-if="boundTriggers(session).length">{{ boundTriggers(session).length }}</small>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent class="session-ai-trigger-menu" align="end" :side-offset="6" @click.stop>
                      <div class="session-ai-trigger-search" @click.stop @keydown.stop>
                        <input v-model="triggerSearch" type="search" placeholder="Search triggers" aria-label="Search triggers" />
                      </div>
                      <DropdownMenuItem v-if="!triggerTemplates.length" class="session-ai-trigger-menu-empty" disabled>No trigger templates</DropdownMenuItem>
                      <DropdownMenuItem v-else-if="!filteredTriggerTemplates.length" class="session-ai-trigger-menu-empty" disabled>No matching triggers</DropdownMenuItem>
                      <template v-else>
                        <DropdownMenuItem
                          v-for="trigger in filteredTriggerTemplates"
                          :key="`${session.id}:${trigger.configHash}`"
                          class="session-ai-trigger-menu-item"
                          :disabled="triggerBusyKey === triggerActionKey(session, trigger.configHash)"
                          @select="toggleTrigger(session, trigger.configHash)"
                        >
                          <Check v-if="isTriggerBound(session, trigger.configHash)" :size="13" />
                          <Zap v-else :size="13" />
                          <span>
                            <strong>{{ trigger.config.name }}</strong>
                            <small>{{ trigger.config.source.type }} · {{ shortHash(trigger.configHash) }}</small>
                          </span>
                          <small>{{ isTriggerBound(session, trigger.configHash) ? "Remove" : "Add" }}</small>
                        </DropdownMenuItem>
                      </template>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <button
                    v-if="aiSessionAppTab(instance, session)"
                    type="button"
                    class="session-ai-open"
                    :aria-label="`Open app session for ${session.agent}`"
                    title="Open app session"
                    @click="$emit('openAiSessionApp', instance, session)"
                  >
                    <ExternalLink :size="14" />
                  </button>
                </div>
                </article>
              </template>
            </section>
            <p v-if="!sortedSessions.length" class="session-ai-empty session-ai-filter-empty">No AI sessions match this status.</p>
          </div>
        </ScrollArea>
      </aside>
      <button
        type="button"
        class="session-ai-sidebar-resize-handle"
        aria-label="Resize AI session list"
        title="Resize AI session list"
        @pointerdown="startSidebarResize"
      />
      <section v-if="selectedSession" ref="detailEl" class="session-ai-detail" :class="{ 'is-scrolled': detailScrolled }">
        <ScrollArea class="session-ai-detail-scroll">
          <section class="session-ai-detail-content">
          <div ref="detailActionsEl" class="session-ai-detail-fixed-actions session-ai-detail-head-actions">
            <AiSessionTurnNavigator
              :count="promptCount(selectedSession)"
              :index="promptIndexFor(selectedSession)"
              :previous-label="`Previous user message for ${selectedSession.agent}`"
              :next-label="`Next user message for ${selectedSession.agent}`"
              @previous="previousPrompt(selectedSession)"
              @next="nextPrompt(selectedSession)"
            />
            <TooltipProvider :delay-duration="120">
              <Tooltip>
                <TooltipTrigger as-child>
                  <button type="button" title="Session details" aria-label="Session details">
                    <CircleHelp :size="15" />
                  </button>
                </TooltipTrigger>
                <TooltipContent class="session-ai-info-tooltip" align="end" side="bottom" :side-offset="8">
                  <dl>
                    <div>
                      <dt>Workspace</dt>
                      <dd>{{ selectedSession.cwd || "Unknown" }}</dd>
                    </div>
                    <div>
                      <dt>Session</dt>
                      <dd>{{ selectedSession.providerSessionId || selectedSession.id }}</dd>
                    </div>
                    <div>
                      <dt>App Binding</dt>
                      <dd>{{ selectedSession.appSessionId || "Not bound" }}</dd>
                    </div>
                  </dl>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <button
              v-if="aiSessionAppTab(instance, selectedSession)"
              type="button"
              title="Open app session"
              aria-label="Open app session"
              @click="$emit('openAiSessionApp', instance, selectedSession)"
            >
              <ExternalLink :size="15" />
            </button>
          </div>
          <header ref="detailHeaderEl">
            <div>
              <span>{{ aiSessionAppDisplayName(aiSessionAppTab(instance, selectedSession), selectedSession.agent) }}</span>
              <strong>{{ aiSessionStatusLabel(selectedSession) }}</strong>
            </div>
            <section class="session-ai-detail-block session-ai-detail-block-user">
              <div
                ref="promptContentEl"
                class="session-ai-detail-prompt-content"
                :class="{ expanded: promptExpanded }"
              >
                <MarkdownContent :content="displayAiSessionTitle(selectedSession, promptIndexFor(selectedSession))" />
              </div>
              <button
                v-if="promptHasOverflow"
                type="button"
                class="session-ai-detail-prompt-toggle"
                :aria-expanded="promptExpanded"
                @click="promptExpanded = !promptExpanded"
              >
                <span>{{ promptExpanded ? "收起" : "展开" }}</span>
                <ChevronDown :size="13" :class="{ open: promptExpanded }" />
              </button>
            </section>
          </header>
          <div
            v-if="detailScrolled && detailHeaderPlaceholderHeight > 0"
            class="session-ai-detail-head-placeholder"
            :style="{ height: `${detailHeaderPlaceholderHeight}px` }"
            aria-hidden="true"
          />
          <AiSessionResult
            :busy="aiSessionActionBusy"
            :can-interrupt="canInterrupt(selectedSession)"
            :can-resolve-approval="canResolveApproval(selectedSession)"
            :instance-id="instance.id"
            :is-latest="promptIndexFor(selectedSession) >= promptCount(selectedSession) - 1"
            :response-content="displayAiSessionResponse(selectedSession, promptIndexFor(selectedSession))"
            :session="selectedSession"
            @steer-queued-message="steerQueuedMessage(selectedSession.id, $event)"
            @retry-queued-message="retryQueuedMessage(selectedSession.id, $event)"
            @remove-queued-message="removeQueuedMessage(selectedSession.id, $event)"
            @resolve-approval="resolveSelectedApproval"
          />
          </section>
        </ScrollArea>
        <Button
          v-if="!isFollowingLatest"
          class="session-ai-follow-latest"
          size="icon"
          variant="secondary"
          aria-label="Back to latest"
          title="Back to latest"
          @click="followLatest"
        >
          <ArrowDown :size="16" />
        </Button>
        <div class="session-ai-compose-gradient" aria-hidden="true" />
        <AiSessionComposer
          ref="composerEl"
          v-model="messageDraft"
          v-model:attachments="messageAttachments"
          class="session-ai-compose"
          :busy="aiSessionActionBusy"
          :can-interrupt="canInterrupt(selectedSession)"
          @run="runSelectedSessionAction"
          @steer="steerMessageDraft"
        />
      </section>
      <p v-else class="session-ai-empty session-ai-detail-empty">No AI session selected.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type CSSProperties } from "vue";
import { ArrowDown, Ban, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, ExternalLink, Filter, Folder, SlidersHorizontal, X, Zap } from "@lucide/vue";
import { useQueryClient } from "@tanstack/vue-query";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import { bindAiSessionTrigger, interruptAiSession, removeAiSessionQueuedMessage, resolveAiSessionApproval, retryAiSessionQueuedMessage, sendAiSessionMessage, steerAiSessionQueuedMessage, unbindAiSessionTrigger, uploadAiSessionAttachment, useControlPlaneTriggersQuery } from "../../../api/queries";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions, TriggerConfig, TriggerDeployment, TriggerRuntimeState } from "../../../api/types";
import AiSessionComposer, { type AiSessionComposerAttachment } from "../../../components/ai-session/AiSessionComposer.vue";
import AiSessionResult from "../../../components/ai-session/AiSessionResult.vue";
import AiSessionTurnNavigator from "../../../components/ai-session/AiSessionTurnNavigator.vue";
import { Button } from "../../../components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { clearAiSessionDraft, loadAiSessionDraft, persistAiSessionDraft } from "../useAiSessionDraft";
import { createStreamingScrollFollow, type ScrollViewport } from "../../../lib/streaming-scroll-follow";
import {
  aiSessionAppDisplayName,
  aiSessionAppTab,
  aiSessionLastUserMessageTime,
  aiSessionStatusLabel,
  aiSessionTurns,
  displayAiSessionMessage,
  displayAiSessionResponse,
  displayAiSessionTitle,
  sortedAiSessionsByLastUserMessage,
  type SessionTab,
} from "../useInstanceSessions";

type SessionStatusFilter = "all" | "active" | "waiting" | "idle" | "problem";
type AiSessionPathGroup = {
  key: string;
  label: string;
  parentLabel: string;
  sessions: AiSessionSummary[];
};

const GROUP_BY_PATH_STORAGE_KEY = "task-handoff.control-plane.ai-sessions-group-by-path";
const SORT_BY_STATUS_STORAGE_KEY = "task-handoff.control-plane.ai-sessions-sort-by-status";
const SIDEBAR_WIDTH_STORAGE_KEY = "task-handoff.control-plane.ai-sessions-sidebar-width";
const SIDEBAR_WIDTH_DEFAULT = 360;
const SIDEBAR_WIDTH_MIN = 320;
const SIDEBAR_WIDTH_MAX = 520;

function storedGroupByPath() {
  return window.localStorage?.getItem(GROUP_BY_PATH_STORAGE_KEY) !== "false";
}

function storedSortByStatus() {
  return window.localStorage?.getItem(SORT_BY_STATUS_STORAGE_KEY) !== "false";
}

function clampSidebarWidth(value: number) {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
}

function storedSidebarWidth() {
  const stored = window.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
  const value = stored ? Number(stored) : Number.NaN;
  return Number.isFinite(value) ? clampSidebarWidth(value) : SIDEBAR_WIDTH_DEFAULT;
}

const props = defineProps<{
  activeSession: SessionTab;
  instance: InstanceWithAiSessions;
  selectedAiSession: (instance: InstanceBoardItem, sessions?: AiSessionSummary[]) => AiSessionSummary | undefined;
}>();

const visibleAiSessions = computed(() => props.instance.aiSessions?.sessions || []);
const sessionStatusFilter = ref<SessionStatusFilter>("all");
const groupSessionsByPath = ref(storedGroupByPath());
const sortSessionsByStatus = ref(storedSortByStatus());
const statusFilterOptions = computed(() => {
  const sessions = visibleAiSessions.value;
  return [
    { key: "all", label: "All statuses", count: sessions.length },
    { key: "active", label: "Active", count: sessions.filter((session) => sessionStatusGroup(session) === "active").length },
    { key: "waiting", label: "Waiting", count: sessions.filter((session) => sessionStatusGroup(session) === "waiting").length },
    { key: "idle", label: "Idle", count: sessions.filter((session) => sessionStatusGroup(session) === "idle").length },
    { key: "problem", label: "Problem", count: sessions.filter((session) => sessionStatusGroup(session) === "problem").length },
  ] satisfies Array<{ key: SessionStatusFilter; label: string; count: number }>;
});
const selectedStatusFilter = computed(() => statusFilterOptions.value.find((option) => option.key === sessionStatusFilter.value) || statusFilterOptions.value[0]);
const filteredSessions = computed(() => {
  if (sessionStatusFilter.value === "all") {
    return visibleAiSessions.value;
  }
  return visibleAiSessions.value.filter((session) => sessionStatusGroup(session) === sessionStatusFilter.value);
});
const sortedSessions = computed(() => sortedAiSessionsByLastUserMessage(filteredSessions.value, sortSessionsByStatus.value));
const displayedSessionGroups = computed<AiSessionPathGroup[]>(() => groupSessionsByPath.value ? groupAiSessionsByPath(sortedSessions.value) : [{
  key: "all",
  label: "",
  parentLabel: "",
  sessions: sortedSessions.value,
}]);
const selectedSession = computed(() => props.selectedAiSession(props.instance, filteredSessions.value));
const queryClient = useQueryClient();
const promptIndexes = ref<Record<string, { index: number; count: number }>>({});
const collapsedPathGroups = reactive<Record<string, boolean>>({});
const messageDraft = ref("");
const messageAttachments = ref<AiSessionComposerAttachment[]>([]);
const detailEl = ref<HTMLElement>();
const composerEl = ref<InstanceType<typeof AiSessionComposer>>();
const detailScrolled = ref(false);
const detailHeaderEl = ref<HTMLElement>();
const detailActionsEl = ref<HTMLElement>();
const detailHeaderPlaceholderHeight = ref(0);
const promptContentEl = ref<HTMLElement>();
const promptHasOverflow = ref(false);
const promptExpanded = ref(false);
let composerResizeObserver: ResizeObserver | undefined;
let detailActionsResizeObserver: ResizeObserver | undefined;
let detailScrollViewport: HTMLElement | undefined;
let detailScrollLayoutRevision = 0;
let detailScrollLayoutPending = false;
let promptResizeObserver: ResizeObserver | undefined;
let streamingResizeObserver: ResizeObserver | undefined;
let scrollFollow: ReturnType<typeof createStreamingScrollFollow> | undefined;
const isFollowingLatest = ref(true);
let sidebarResizeCleanup: (() => void) | undefined;
const aiSessionActionBusy = ref(false);
const triggerBusyKey = ref("");
const triggerSearch = ref("");
const triggers = useControlPlaneTriggersQuery();
const triggerTemplates = computed(() => triggers.data.value?.triggers || []);
const filteredTriggerTemplates = computed(() => {
  const query = triggerSearch.value.trim().toLowerCase();
  if (!query) {
    return triggerTemplates.value;
  }
  return triggerTemplates.value.filter((trigger) => {
    const searchable = [
      trigger.config.name,
      trigger.config.source.type,
      trigger.configHash,
    ].join(" ").toLowerCase();
    return searchable.includes(query);
  });
});
const sidebarWidth = ref(storedSidebarWidth());
const workspaceStyle = computed(
  () =>
    ({
      "--session-ai-sidebar-width": `${sidebarWidth.value}px`,
    }) as CSSProperties,
);

function sessionStatusGroup(session: AiSessionSummary): Exclude<SessionStatusFilter, "all"> {
  const status = session.status as string;
  if (status === "waiting") {
    return "waiting";
  }
  if (status === "failed") {
    return "problem";
  }
  if (status === "running") {
    return "active";
  }
  return "idle";
}

function groupAiSessionsByPath(sessions: AiSessionSummary[]) {
  const groups = new Map<string, AiSessionSummary[]>();
  for (const session of sessions) {
    const path = aiSessionPath(session);
    groups.set(path, [...(groups.get(path) || []), session]);
  }
  return [...groups.entries()]
    .map(([label, groupSessions]) => ({
      key: label,
      ...aiSessionPathLabel(label),
      sessions: groupSessions,
    }))
    .sort((a, b) => {
      const messageTimeDelta = groupLastUserMessageTime(b.sessions) - groupLastUserMessageTime(a.sessions);
      return messageTimeDelta || a.key.localeCompare(b.key);
    });
}

function aiSessionPath(session: AiSessionSummary) {
  return session.cwd?.trim() || "Unknown path";
}

function aiSessionPathLabel(path: string) {
  if (path === "Unknown path") {
    return { label: path, parentLabel: "" };
  }
  const normalized = path.replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return { label: normalized || path, parentLabel: "" };
  }
  return {
    label: normalized.slice(index + 1) || normalized,
    parentLabel: normalized.slice(0, index),
  };
}

function groupLastUserMessageTime(sessions: AiSessionSummary[]) {
  return Math.max(0, ...sessions.map(aiSessionLastUserMessageTime));
}

watch(
  displayedSessionGroups,
  (groups) => {
    const activeKeys = new Set(groups.map((group) => group.key));
    for (const key of Object.keys(collapsedPathGroups)) {
      if (!activeKeys.has(key)) {
        delete collapsedPathGroups[key];
      }
    }
  },
  { immediate: true },
);

watch(groupSessionsByPath, (value) => {
  window.localStorage?.setItem(GROUP_BY_PATH_STORAGE_KEY, String(value));
});

watch(sortSessionsByStatus, (value) => {
  window.localStorage?.setItem(SORT_BY_STATUS_STORAGE_KEY, String(value));
});

function togglePathGroup(key: string) {
  collapsedPathGroups[key] = !collapsedPathGroups[key];
}

function stopSidebarResize() {
  sidebarResizeCleanup?.();
  sidebarResizeCleanup = undefined;
  document.body.classList.remove("session-ai-sidebar-resizing");
}

function startSidebarResize(event: PointerEvent) {
  event.preventDefault();
  event.stopPropagation();
  stopSidebarResize();
  const startX = event.clientX;
  const startWidth = sidebarWidth.value;
  document.body.classList.add("session-ai-sidebar-resizing");
  const handlePointerMove = (moveEvent: PointerEvent) => {
    sidebarWidth.value = clampSidebarWidth(startWidth + moveEvent.clientX - startX);
  };
  const handlePointerUp = () => {
    window.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth.value));
    stopSidebarResize();
  };
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp, { once: true });
  window.addEventListener("pointercancel", handlePointerUp, { once: true });
  sidebarResizeCleanup = () => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
  };
}

function promptCount(session: AiSessionSummary) {
  return aiSessionTurns(session).length;
}

function updatePromptOverflow() {
  const element = promptContentEl.value;
  if (promptExpanded.value) return;
  promptHasOverflow.value = Boolean(element && element.scrollHeight > element.clientHeight + 1);
}

function promptIndexFor(session: AiSessionSummary) {
  const count = promptCount(session);
  if (!count) {
    return 0;
  }
  const saved = promptIndexes.value[session.id];
  if (!saved) {
    return count - 1;
  }
  const wasFollowingLatest = saved.index >= saved.count - 1;
  if (wasFollowingLatest && count !== saved.count) {
    return count - 1;
  }
  return Math.min(Math.max(saved.index, 0), count - 1);
}

function setPromptIndex(session: AiSessionSummary, index: number) {
  const count = promptCount(session);
  if (!count) {
    return;
  }
  promptIndexes.value = {
    ...promptIndexes.value,
    [session.id]: { index: Math.min(Math.max(index, 0), count - 1), count },
  };
  promptExpanded.value = false;
  promptHasOverflow.value = false;
  void nextTick(updatePromptOverflow);
}

function previousPrompt(session: AiSessionSummary) {
  setPromptIndex(session, promptIndexFor(session) - 1);
}

function nextPrompt(session: AiSessionSummary) {
  setPromptIndex(session, promptIndexFor(session) + 1);
}

function selectSession(sessionId: string) {
  emit("selectAiSession", props.instance.id, sessionId);
}

function canInterrupt(session: AiSessionSummary) {
  return Boolean(session.actions?.interrupt);
}

function canResolveApproval(session: AiSessionSummary) {
  return session.status === "waiting" && session.phase === "approval";
}

async function refreshBoard() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["instance-board"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-ai-sessions"] }),
  ]);
}

async function runSelectedSessionAction() {
  const session = selectedSession.value;
  if (!session || aiSessionActionBusy.value || (!messageDraft.value.trim() && !messageAttachments.value.length && !canInterrupt(session))) {
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
  const session = selectedSession.value;
  const message = messageDraft.value.trim();
  if (!session || (!message && !messageAttachments.value.length) || aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    const attachments = await uploadMessageAttachments(props.instance.id, session.id);
    await sendAiSessionMessage(props.instance.id, session.id, message || "请查看附件图片。", undefined, attachments.map((attachment) => ({ id: attachment.id, kind: attachment.kind })));
    clearAiSessionDraft(session.id);
    messageDraft.value = "";
    messageAttachments.value = [];
  } catch (error) {
    showControlPlaneToast(error instanceof Error ? error.message : "Failed to send message.");
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function steerMessageDraft() {
  const session = selectedSession.value;
  const message = messageDraft.value.trim();
  if (!session || (!message && !messageAttachments.value.length) || aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    const attachments = await uploadMessageAttachments(props.instance.id, session.id);
    await sendAiSessionMessage(props.instance.id, session.id, message || "请查看附件图片。", "steer", attachments.map((attachment) => ({ id: attachment.id, kind: attachment.kind })));
    clearAiSessionDraft(session.id);
    messageDraft.value = "";
    messageAttachments.value = [];
    await refreshBoard();
  } catch (error) {
    showControlPlaneToast(error instanceof Error ? error.message : "Failed to steer message.");
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function steerQueuedMessage(sessionId: string, queueId: string) {
  await runQueueAction(() => steerAiSessionQueuedMessage(props.instance.id, sessionId, queueId), "Failed to steer queued message.");
}

async function retryQueuedMessage(sessionId: string, queueId: string) {
  await runQueueAction(() => retryAiSessionQueuedMessage(props.instance.id, sessionId, queueId), "Failed to retry queued message.");
}

async function removeQueuedMessage(sessionId: string, queueId: string) {
  await runQueueAction(() => removeAiSessionQueuedMessage(props.instance.id, sessionId, queueId), "Failed to remove queued message.");
}

async function runQueueAction(action: () => Promise<unknown>, message: string) {
  if (aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    await action();
    await refreshBoard();
  } catch (error) {
    showControlPlaneToast(error instanceof Error ? error.message : message);
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function interruptSelectedSession() {
  const session = selectedSession.value;
  if (!session || !canInterrupt(session) || aiSessionActionBusy.value || messageDraft.value.trim() || messageAttachments.value.length) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    await interruptAiSession(props.instance.id, session.id);
    await refreshBoard();
  } catch (error) {
    showControlPlaneToast(error instanceof Error ? error.message : "Failed to stop AI session.");
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function resolveSelectedApproval(decision: "allow" | "deny" | "skip") {
  const session = selectedSession.value;
  if (session) {
    await resolveApproval(session, decision);
  }
}

async function resolveApproval(session: AiSessionSummary, decision: "allow" | "deny" | "skip") {
  if (!session || !canResolveApproval(session) || aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  try {
    await resolveAiSessionApproval(props.instance.id, session.id, decision);
    await refreshBoard();
  } catch (error) {
    showControlPlaneToast(error instanceof Error ? error.message : "Failed to resolve approval.");
  } finally {
    aiSessionActionBusy.value = false;
  }
}

function boundTriggers(session: AiSessionSummary) {
  return (props.instance.triggers?.configs || []).flatMap((entry) => entry.deployments.filter((deployment) => isAiSessionTriggerDeployment(deployment, session.id)));
}

function isAiSessionTriggerDeployment(deployment: TriggerDeployment, sessionId: string) {
  return deployment.target.type === "ai-session" && deployment.target.aiSessionId === sessionId;
}

function isTriggerBound(session: AiSessionSummary, configHash: string) {
  return boundTriggers(session).some((deployment) => deployment.configHash === configHash);
}

function triggerActionKey(session: AiSessionSummary, configHash: string) {
  return `${props.instance.id}:${session.id}:${configHash}`;
}

function triggerButtonTitle(session: AiSessionSummary) {
  const count = boundTriggers(session).length;
  return count ? `${count} triggers bound` : "Add trigger";
}

async function toggleTrigger(session: AiSessionSummary, configHash: string) {
  const key = triggerActionKey(session, configHash);
  if (triggerBusyKey.value) {
    return;
  }
  triggerBusyKey.value = key;
  try {
    if (isTriggerBound(session, configHash)) {
      await unbindAiSessionTrigger(props.instance.id, session.id, configHash);
      removeLocalTriggerBinding(session, configHash);
    } else {
      const created = await bindAiSessionTrigger(props.instance.id, session.id, configHash) as TriggerMutationResult;
      upsertLocalTriggerBinding(created);
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["instance-board"] }),
      queryClient.invalidateQueries({ queryKey: ["control-plane-triggers"] }),
    ]);
  } finally {
    triggerBusyKey.value = "";
  }
}

function shortHash(value: string) {
  return value.length > 14 ? `${value.slice(0, 10)}...` : value;
}

type TriggerMutationResult = {
  config?: TriggerConfig;
  deployment?: TriggerDeployment;
  runtime?: TriggerRuntimeState;
};

type InstanceTriggerSnapshot = NonNullable<InstanceBoardItem["triggers"]>;

function emptyTriggerSnapshot(): InstanceTriggerSnapshot {
  return {
    configs: [],
    recentRuns: [],
    updatedAt: new Date().toISOString(),
  };
}

function upsertLocalTriggerBinding(result: TriggerMutationResult) {
  if (!result.config || !result.deployment) {
    return;
  }
  queryClient.setQueryData<InstanceBoardItem[]>(["instance-board"], (current = []) => current.map((instance) => {
    if (instance.id !== props.instance.id) {
      return instance;
    }
    const snapshot = instance.triggers || emptyTriggerSnapshot();
    const currentConfig = snapshot.configs.find((entry) => entry.configHash === result.config?.configHash);
    const nextEntry = {
      configHash: result.config.configHash,
      config: result.config,
      deployments: [
        ...(currentConfig?.deployments || []).filter((deployment) => deployment.deploymentId !== result.deployment?.deploymentId),
        result.deployment,
      ],
      runtime: result.runtime
        ? [...(currentConfig?.runtime || []).filter((runtime) => runtime.deploymentId !== result.runtime?.deploymentId), result.runtime]
        : currentConfig?.runtime || [],
    };
    return {
      ...instance,
      triggers: {
        ...snapshot,
        configs: [
          ...snapshot.configs.filter((entry) => entry.configHash !== result.config?.configHash),
          nextEntry,
        ],
        updatedAt: new Date().toISOString(),
      },
    };
  }));
}

function removeLocalTriggerBinding(session: AiSessionSummary, configHash: string) {
  queryClient.setQueryData<InstanceBoardItem[]>(["instance-board"], (current = []) => current.map((instance) => {
    if (instance.id !== props.instance.id || !instance.triggers) {
      return instance;
    }
    const configs = instance.triggers.configs.flatMap((entry) => {
      if (entry.configHash !== configHash) {
        return [entry];
      }
      const deployments = entry.deployments.filter((deployment) => !isAiSessionTriggerDeployment(deployment, session.id));
      if (!deployments.length) {
        return [];
      }
      const deploymentIds = new Set(deployments.map((deployment) => deployment.deploymentId || deployment.configHash));
      return [{
        ...entry,
        deployments,
        runtime: entry.runtime.filter((runtime) => deploymentIds.has(runtime.deploymentId || runtime.configHash)),
      }];
    });
    return {
      ...instance,
      triggers: {
        ...instance.triggers,
        configs,
        updatedAt: new Date().toISOString(),
      },
    };
  }));
}

function syncComposerOffset() {
  const detail = detailEl.value;
  const composer = (composerEl.value?.$el instanceof HTMLElement ? composerEl.value.$el : undefined);
  if (!detail || !composer) {
    return;
  }
  detail.style.setProperty("--session-ai-compose-offset", `${Math.ceil(composer.getBoundingClientRect().height)}px`);
  scrollFollow?.notifyContentResize();
}

function followLatest() {
  scrollFollow?.followLatest();
}

function observeComposerOffset() {
  composerResizeObserver?.disconnect();
  composerResizeObserver = undefined;
  const composer = (composerEl.value?.$el instanceof HTMLElement ? composerEl.value.$el : undefined);
  if (!composer) {
    syncComposerOffset();
    return;
  }
  composerResizeObserver = new ResizeObserver(syncComposerOffset);
  composerResizeObserver.observe(composer);
  syncComposerOffset();
}

function syncDetailActionsWidth() {
  const detail = detailEl.value;
  const actions = detailActionsEl.value;
  if (!detail || !actions) {
    return;
  }
  detail.style.setProperty("--session-ai-fixed-actions-width", `${Math.ceil(actions.getBoundingClientRect().width)}px`);
}

function observeDetailActionsWidth() {
  detailActionsResizeObserver?.disconnect();
  detailActionsResizeObserver = undefined;
  const actions = detailActionsEl.value;
  if (!actions) {
    syncDetailActionsWidth();
    return;
  }
  detailActionsResizeObserver = new ResizeObserver(syncDetailActionsWidth);
  detailActionsResizeObserver.observe(actions);
  syncDetailActionsWidth();
}

function observeDetailScroll() {
  detailScrollViewport?.removeEventListener("scroll", handleDetailScroll);
  streamingResizeObserver?.disconnect();
  streamingResizeObserver = undefined;
  scrollFollow?.dispose();
  scrollFollow = undefined;
  detailScrollViewport = undefined;
  detailScrollLayoutRevision += 1;
  detailScrollLayoutPending = false;
  detailScrolled.value = false;
  detailHeaderPlaceholderHeight.value = 0;
  const viewport = detailEl.value?.querySelector<HTMLElement>(".session-ai-detail-scroll [data-task-handoff-scroll-viewport]");
  if (!viewport) {
    isFollowingLatest.value = true;
    return;
  }
  detailScrollViewport = viewport;
  scrollFollow = createStreamingScrollFollow(
    () => detailScrollViewport as (HTMLElement & ScrollViewport) | undefined,
    { onFollowingChange: (value) => { isFollowingLatest.value = value; } },
  );
  const content = detailEl.value?.querySelector<HTMLElement>(".session-ai-detail-content");
  if (content && typeof ResizeObserver !== "undefined") {
    streamingResizeObserver = new ResizeObserver(() => scrollFollow?.notifyContentResize());
    streamingResizeObserver.observe(content);
  }
  handleDetailScroll();
  viewport.addEventListener("scroll", handleDetailScroll, { passive: true });
  scrollFollow.followLatest();
}

function handleDetailScroll() {
  scrollFollow?.handleScroll();
  if (detailScrollLayoutPending) {
    return;
  }
  const scrollTop = detailScrollViewport?.scrollTop || 0;
  if (!detailScrolled.value && scrollTop > 64) {
    void enterDetailStickyLayout();
  } else if (detailScrolled.value && scrollTop <= 64) {
    detailScrollLayoutRevision += 1;
    detailHeaderPlaceholderHeight.value = 0;
    detailScrolled.value = false;
  }
}

async function enterDetailStickyLayout() {
  const header = detailHeaderEl.value;
  if (!header || detailScrolled.value) {
    return;
  }
  const revision = ++detailScrollLayoutRevision;
  const previousScrollTop = detailScrollViewport?.scrollTop || 0;
  const expandedHeight = header.getBoundingClientRect().height;
  detailScrollLayoutPending = true;
  detailScrolled.value = true;
  await nextTick();
  if (revision !== detailScrollLayoutRevision || !detailScrolled.value || !detailHeaderEl.value) {
    detailScrollLayoutPending = false;
    return;
  }
  const stickyHeight = detailHeaderEl.value.getBoundingClientRect().height;
  detailHeaderPlaceholderHeight.value = Math.max(0, Math.ceil(expandedHeight - stickyHeight));
  await nextTick();
  if (revision === detailScrollLayoutRevision && detailScrollViewport) {
    detailScrollViewport.scrollTop = previousScrollTop;
  }
  detailScrollLayoutPending = false;
}

watch([selectedSession, messageAttachments, messageDraft], () => {
  void nextTick(observeComposerOffset);
}, { immediate: true });

watch(() => `${props.instance.id}\u0000${selectedSession.value?.id || ""}`, () => {
  messageDraft.value = selectedSession.value ? loadAiSessionDraft(selectedSession.value.id) : "";
  promptExpanded.value = false;
  promptHasOverflow.value = false;
  void nextTick(() => {
    updatePromptOverflow();
    promptResizeObserver?.disconnect();
    if (promptContentEl.value && typeof ResizeObserver !== "undefined") {
      promptResizeObserver = new ResizeObserver(updatePromptOverflow);
      promptResizeObserver.observe(promptContentEl.value);
    }
    observeDetailActionsWidth();
    observeDetailScroll();
  });
}, { immediate: true });

watch([() => selectedSession.value?.id, messageDraft], ([sessionId, draft]) => {
  if (sessionId) {
    persistAiSessionDraft(sessionId, draft);
  }
});

onMounted(() => {
  void nextTick(() => {
    observeComposerOffset();
    observeDetailActionsWidth();
    observeDetailScroll();
  });
});
onBeforeUnmount(() => {
  composerResizeObserver?.disconnect();
  detailActionsResizeObserver?.disconnect();
  promptResizeObserver?.disconnect();
  detailScrollViewport?.removeEventListener("scroll", handleDetailScroll);
  streamingResizeObserver?.disconnect();
  scrollFollow?.dispose();
  stopSidebarResize();
});

const emit = defineEmits<{
  openAiSessionApp: [instance: InstanceBoardItem, session?: AiSessionSummary];
  selectAiSession: [instanceId: string, sessionId: string];
}>();
</script>

<style scoped src="./AiSessionPanel.css"></style>
