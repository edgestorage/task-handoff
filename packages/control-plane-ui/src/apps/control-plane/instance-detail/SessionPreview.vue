<template>
  <section ref="sessionPreview" class="session-preview" :class="{ expanded: previewExpanded }" :data-state="instance.connectionStatus">
    <div class="session-preview-toolbar" :class="{ split: hasSessionSplit }">
      <div class="session-preview-primary-tools" :class="{ split: hasSessionSplit }" :style="hasSessionSplit ? { '--session-left-ratio': `${sessionSplitRatio * 100}%` } : undefined">
        <div
          v-for="tabGroup in visibleTabGroups"
          :key="tabGroup.id"
          class="session-preview-selector"
          :class="{ 'drop-target': sessionTabDropTarget?.pane === tabGroup.id }"
          :data-pane="tabGroup.id"
          :aria-label="hasSessionSplit ? t('sessions.tabs.paneViews', { pane: tabGroup.id }) : t('sessions.tabs.views')"
          @click.stop
        >
          <button
            v-if="tabGroup.statusTab"
            type="button"
            class="session-ai-home"
            :class="{ active: isSessionTabActive(tabGroup.statusTab), focused: isSessionTabFocused(tabGroup.statusTab) }"
            :title="instanceStatusTitle(instance, t)"
            @click="$emit('selectSession', tabGroup.statusTab.key, tabGroup.id)"
          >
            <Activity :size="15" />
            <span>{{ t("sessions.tabs.status") }}</span>
          </button>
          <span v-if="tabGroup.statusTab && (tabGroup.aiTab || tabGroup.appTabs.length)" class="session-tab-divider" aria-hidden="true" />
          <button
            v-if="tabGroup.aiTab"
            type="button"
            class="session-ai-home"
            :class="{ active: isSessionTabActive(tabGroup.aiTab), focused: isSessionTabFocused(tabGroup.aiTab) }"
            :title="sessionMeta(tabGroup.aiTab, t)"
            @click="$emit('selectSession', tabGroup.aiTab.key, tabGroup.id)"
          >
            <span class="session-ai-icon">
              <Bot :size="15" />
              <span class="session-tab-dot" :data-state="tabGroup.aiTab.status" />
            </span>
            <!-- i18n-audit-allow-next-line protocol-name: AI is the protocol-facing agent category label -->
            <span>AI</span>
          </button>
          <span v-if="tabGroup.aiTab && previewSessionTabs(tabGroup.id, tabGroup.appTabs).length" class="session-tab-divider" aria-hidden="true" />
          <div v-if="previewSessionTabs(tabGroup.id, tabGroup.appTabs).length" class="session-tab-strip-frame">
            <div v-session-tab-overflow class="session-tab-strip" @scroll="updateSessionTabOverflowFromEvent" @wheel="scrollSessionTabs">
              <TransitionGroup name="session-tab-reorder" tag="div" class="session-tab-strip-content" role="tablist" :aria-label="hasSessionSplit ? t('sessions.tabs.paneTabs', { pane: tabGroup.id }) : t('sessions.tabs.views')">
                <span
                  v-for="session in previewSessionTabs(tabGroup.id, tabGroup.appTabs)"
                  :key="session.key"
                  class="session-tab-sortable-shell"
                  @mouseenter="showSessionTabDetail($event, session)"
                  @pointermove="showSessionTabDetail($event, session)"
                  @mouseleave="scheduleSessionTabDetailClose"
                  @focusin="showSessionTabDetail($event, session)"
                  @focusout="scheduleSessionTabDetailClose"
                >
                  <ContextMenu>
                    <ContextMenuTrigger as-child :disabled="!sessionSplitAvailable">
                      <span
                        class="session-tab-item"
                        :class="{ active: isSessionTabActive(session), focused: isSessionTabFocused(session), 'drag-placeholder': draggingSessionTabKey === session.key }"
                        :data-kind="session.kind"
                        :data-pane="hasSessionSplit ? sessionPaneId(session) : undefined"
                        :data-session-tab-key="session.key"
                        role="tab"
                        tabindex="0"
                        :aria-selected="isSessionTabActive(session)"
                        @click="selectSessionFromTab($event, session.key)"
                        @pointerdown="startSessionTabPointer($event, session, tabGroup.id)"
                        @keydown.enter.prevent="$emit('selectSession', session.key)"
                        @keydown.space.prevent="$emit('selectSession', session.key)"
                      >
                        <span class="session-tab-button">
                          <FolderGit2 v-if="session.kind === 'repository'" :size="14" class="session-tab-icon" />
                          <AppWindow v-else :size="14" class="session-tab-icon" />
                          <input
                            v-if="editingSessionKey === session.key"
                            :ref="setRenameInput"
                            v-model="sessionTitleDraft"
                            class="session-tab-title-input"
                            :aria-invalid="Boolean(sessionRenameError)"
                            :disabled="renamingSession"
                            :title="sessionRenameError"
                            maxlength="120"
                            @click.stop
                            @blur="commitSessionRename(session)"
                            @keydown.enter.stop.prevent="commitSessionRename(session)"
                            @keydown.escape.stop.prevent="cancelSessionRename"
                          />
                          <span v-else class="session-tab-text">
                            <strong>{{ sessionDisplayName(session, t) }}</strong>
                          </span>
                        </span>
                        <button
                          type="button"
                          class="session-tab-close"
                          :disabled="Boolean(stoppingSessionId)"
                          :aria-label="t('sessions.tabs.closeNamed', { name: sessionDisplayName(session, t) })"
                          :title="t('sessions.tabs.close')"
                          @click.stop="$emit('stopSession', instance, session)"
                        >
                          <X :size="13" />
                        </button>
                      </span>
                      </ContextMenuTrigger>
                    <ContextMenuContent class="instance-action-menu">
                      <ContextMenuItem v-if="session.kind !== 'repository'" class="instance-action-item" @select="beginSessionRename(session)">
                        <Pencil :size="14" />
                        <span>{{ t("sessions.tabs.rename") }}</span>
                      </ContextMenuItem>
                      <ContextMenuItem v-if="sessionSplitAvailable && sessionPaneId(session) === 'right'" class="instance-action-item" @select="$emit('moveSessionToPane', session.key, 'left')">
                        <PanelLeft :size="14" />
                        <span>{{ t("sessions.tabs.moveLeft") }}</span>
                      </ContextMenuItem>
                      <ContextMenuItem v-else-if="sessionSplitAvailable" class="instance-action-item" @select="$emit('moveSessionToPane', session.key, 'right')">
                        <PanelRight :size="14" />
                        <span>{{ t("sessions.tabs.moveRight") }}</span>
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </span>
              </TransitionGroup>
            </div>
          </div>
          <div v-if="!tabGroup.statusTab" class="app-launcher" :class="{ open: appLaunchMenuOpen && appLaunchMenuPane === tabGroup.id }" @click.stop>
            <DropdownMenu :open="appLaunchMenuOpen && appLaunchMenuPane === tabGroup.id" @update:open="updateAppLaunchMenuOpen(tabGroup.id, $event)">
              <DropdownMenuTrigger as-child>
                <Button class="session-tab-add-button" variant="ghost" size="icon" :disabled="!canLaunchApp || launchingApp" :aria-expanded="appLaunchMenuOpen && appLaunchMenuPane === tabGroup.id" :aria-label="appLaunchButtonTitle" :title="appLaunchButtonTitle">
                  <Plus :size="16" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent class="app-launch-menu" align="start" :side-offset="6">
                <AppLaunchMenuItems :apps="launchableApps" :folders="projectFolders" :instance="instance" :launching="launchingApp" @launch="(appId, cwdFolderId) => launchApp(appId, cwdFolderId)" @new-project="openProjectPicker" />
                <DropdownMenuSeparator />
                <DropdownMenuItem class="app-launch-menu-item" @select="$emit('openSettings', instance.id, 'apps')">
                  <Boxes :size="14" />
                  <span>
                    <strong>{{ t("sessions.tabs.manageApps") }}</strong>
                    <small>{{ t("sessions.tabs.manageAppsDescription") }}</small>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <DropdownMenu v-if="!tabGroup.statusTab" :open="sessionMenuOpen && sessionMenuPane === tabGroup.id" @update:open="updateSessionMenuOpen(tabGroup.id, $event)">
            <DropdownMenuTrigger as-child>
              <button type="button" class="session-tab-menu-trigger" :aria-expanded="sessionMenuOpen && sessionMenuPane === tabGroup.id" :title="t('sessions.tabs.paneMenu')" :aria-label="t('sessions.tabs.paneMenu')">
                <ChevronDown :size="15" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent class="session-select-menu" align="end" :side-offset="8">
              <template v-if="tabGroup.groupSessionMenu">
                <DropdownMenuItem
                  v-if="tabGroup.statusTab"
                  :key="tabGroup.statusTab.key"
                  class="session-select-row"
                  :class="{ active: isSessionTabActive(tabGroup.statusTab) }"
                  @select="$emit('selectSession', tabGroup.statusTab.key, tabGroup.id)"
                >
                  <span class="session-select-option">
                    <span>
                      <strong>{{ t("sessions.tabs.status") }}</strong>
                      <small>{{ instanceStatusTitle(instance, t) }}</small>
                    </span>
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-if="tabGroup.aiTab"
                  :key="tabGroup.aiTab.key"
                  class="session-select-row"
                  :class="{ active: isSessionTabActive(tabGroup.aiTab) }"
                  @select="$emit('selectSession', tabGroup.aiTab.key, tabGroup.id)"
                >
                  <span class="session-select-option">
                    <span>
                      <strong>{{ appDisplayName(tabGroup.aiTab.label, t) }}</strong>
                      <small>{{ sessionMeta(tabGroup.aiTab, t) }}</small>
                    </span>
                  </span>
                </DropdownMenuItem>
                <div v-for="group in tabGroup.groupedAppSessions" :key="group.key" class="session-select-group">
                  <div class="session-select-group-label" :title="group.label">
                    <Folder :size="13" />
                    <span>{{ group.label }}</span>
                  </div>
                  <DropdownMenuItem
                    v-for="session in group.sessions"
                    :key="session.key"
                    class="session-select-row nested"
                    :class="{ active: isSessionTabActive(session) }"
                    @select="$emit('selectSession', session.key, tabGroup.id)"
                  >
                    <span class="session-select-option">
                      <span>
                        <strong>{{ sessionDisplayName(session, t) }}</strong>
                        <small>{{ sessionMeta(session, t) }}</small>
                      </span>
                    </span>
                    <button
                      type="button"
                      class="session-select-close"
                      :disabled="Boolean(stoppingSessionId)"
                      :aria-label="t('sessions.tabs.closeNamed', { name: sessionDisplayName(session, t) })"
                      :title="t('sessions.tabs.close')"
                      @click.stop="$emit('stopSession', instance, session)"
                    >
                      <X :size="13" />
                    </button>
                  </DropdownMenuItem>
                </div>
              </template>
              <template v-else>
                <DropdownMenuItem
                  v-for="session in tabGroup.tabs"
                  :key="session.key"
                  class="session-select-row"
                  :class="{ active: isSessionTabActive(session) }"
                  @select="$emit('selectSession', session.key, tabGroup.id)"
                >
                  <span class="session-select-option">
                    <span>
                      <strong>{{ sessionDisplayName(session, t) }}</strong>
                      <small>{{ sessionMeta(session, t) }}</small>
                    </span>
                  </span>
                  <button
                    v-if="session.kind !== 'ai' && session.kind !== 'status'"
                    type="button"
                    class="session-select-close"
                    :disabled="Boolean(stoppingSessionId)"
                    :aria-label="t('sessions.tabs.closeNamed', { name: sessionDisplayName(session, t) })"
                    :title="t('sessions.tabs.close')"
                    @click.stop="$emit('stopSession', instance, session)"
                  >
                    <X :size="13" />
                  </button>
                </DropdownMenuItem>
              </template>
              <DropdownMenuItem v-if="!tabGroup.tabs.length" class="session-select-row" disabled>
                <span class="session-select-option"><span><strong>{{ t("sessions.tabs.emptyPane") }}</strong></span></span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <span v-if="hasSessionSplit" class="session-toolbar-split-divider" aria-hidden="true" />
      </div>
      <div class="session-preview-tools">
        <RepositoryEnvironment
          v-if="activeRepositorySessionId"
          :connection-status="instance.connectionStatus"
          :instance-id="instance.id"
          :session-id="activeRepositorySessionId"
          session-kind="app-session"
          @open-workspace="$emit('openRepositoryWorkspace', $event)"
        />
        <button v-if="sessionSplitAvailable" type="button" class="preview-expand-button" :disabled="!hasSessionSplit && !canOpenSessionSplit" :aria-label="hasSessionSplit ? t('sessions.tabs.closeSplit') : t('sessions.tabs.split')" :title="hasSessionSplit ? t('sessions.tabs.closeSplit') : t('sessions.tabs.split')" @click="hasSessionSplit ? $emit('closeSessionSplit') : $emit('openSessionSplit')">
          <PanelRightClose v-if="hasSessionSplit" :size="15" />
          <Columns2 v-else :size="15" />
        </button>
        <button type="button" class="preview-expand-button" :aria-label="previewExpanded ? t('sessions.tabs.restore') : t('sessions.tabs.expand')" :title="previewExpanded ? t('sessions.tabs.restoreShort') : t('sessions.tabs.expandShort')" @click="$emit('update:previewExpanded', !previewExpanded)">
          <Minimize2 v-if="previewExpanded" :size="15" />
          <Maximize2 v-else :size="15" />
        </button>
      </div>
    </div>
    <Teleport to="body">
      <div
        v-if="sessionTabPointerDrag"
        class="session-tab-pointer-overlay"
        :data-kind="sessionTabPointerDrag.session.kind"
        :style="sessionTabPointerOverlayStyle"
        aria-hidden="true"
      >
        <FolderGit2 v-if="sessionTabPointerDrag.session.kind === 'repository'" :size="14" class="session-tab-icon" />
        <AppWindow v-else :size="14" class="session-tab-icon" />
        <strong>{{ sessionDisplayName(sessionTabPointerDrag.session, t) }}</strong>
      </div>
    </Teleport>
    <div
      ref="sessionPaneLayout"
      class="session-pane-layout"
      :class="{ split: hasSessionSplit, resizing: splitResizing }"
      :style="hasSessionSplit ? { '--session-left-ratio': `${sessionSplitRatio * 100}%` } : undefined"
    >
      <section
        v-for="pane in visiblePanes"
        :key="pane.id"
        class="session-pane"
        :class="{ focused: focusedSessionPane === pane.id }"
        :data-pane="pane.id"
        @pointerdown.capture="$emit('focusSessionPane', pane.id)"
      >
        <SessionPaneContent
          :active-action-label="activeActionLabel"
          :app-launch-button-title="appLaunchButtonTitle"
          :can-launch-app="canLaunchApp"
          :instance="instance"
          :is-instance-action-busy="isInstanceActionBusy"
          :launchable-apps="launchableApps"
          :launching-app="launchingApp"
          :node-local-folders="nodeLocalFolders"
          :selected-ai-session="selectedAiSession"
          :session="pane.session"
          :session-key="pane.sessionKey"
          @open-ai-session-app="(target, session) => $emit('openAiSessionApp', target, session)"
          @open-repository-workspace="$emit('openRepositoryWorkspace', $event)"
          @open-launch-menu="updateAppLaunchMenuOpen(pane.id, true)"
          @run-action="(action, target) => $emit('runAction', action, target)"
          @select-ai-session="(instanceId, sessionId) => $emit('selectAiSession', instanceId, sessionId)"
        />
      </section>
      <div v-if="hasSessionSplit" class="session-pane-resize-handle" role="separator" :aria-label="t('sessions.tabs.resizePanes')" aria-orientation="vertical" :aria-valuenow="Math.round(sessionSplitRatio * 100)" tabindex="0" @pointerdown="startSplitResize" @dblclick="$emit('setSessionSplitRatio', 0.5)" @keydown.left.prevent="$emit('setSessionSplitRatio', sessionSplitRatio - 0.02)" @keydown.right.prevent="$emit('setSessionSplitRatio', sessionSplitRatio + 0.02)" />
    </div>
    <div class="session-preview-actions">
      <p class="session-preview-status" :aria-label="t('sessions.tabs.instanceStatus')">
        <span>{{ t("sessions.tabs.health", { status: instance.health }) }}</span>
        <span>{{ t("sessions.tabs.workspace", { status: instance.workspace.status }) }}</span>
        <template v-if="resourceMetrics">
          <span class="session-resource-metrics" :data-state="resourceMetricsDisplay.state" :title="resourceMetricsDisplay.title">
            {{ resourceMetricsDisplay.compact }}
          </span>
        </template>
        <span v-else-if="instance.runtime?.type === 'docker'" class="session-resource-metrics" :data-state="resourceMetricsError ? 'unavailable' : 'loading'" :title="resourceMetricsError || t('sessions.tabs.waitingMetrics')">
          {{ resourceMetricsError ? t("sessions.tabs.resourcesUnavailable") : t("sessions.tabs.resourcesLoading") }}
        </span>
        <span v-else>{{ t("sessions.tabs.lastRefresh", { time: lastRefreshLabel }) }}</span>
      </p>
    </div>
    <ProjectFolderPicker
      :node-id="instance.nodeId"
      :node-name="instance.nodeId"
      :open="projectPickerOpen"
      @created="handleProjectCreated"
      @update:open="projectPickerOpen = $event"
    />
    <Teleport to="body">
      <Transition name="session-tab-detail">
        <div
          v-if="sessionTabDetailVisible && sessionTabDetailSession"
          class="session-tab-detail-tooltip"
          :style="sessionTabDetailStyle"
          role="tooltip"
          @mouseenter="cancelSessionTabDetailClose"
          @mouseleave="scheduleSessionTabDetailClose"
        >
          <strong class="session-tab-detail-title">{{ sessionDisplayName(sessionTabDetailSession, t) }}</strong>
          <span class="session-tab-detail-cwd">{{ sessionTabWorkspaceLabel(sessionTabDetailSession) }}</span>
        </div>
      </Transition>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance, type ObjectDirective } from "vue";
import { useI18n } from "vue-i18n";
import { useMediaQuery, useNow } from "@vueuse/core";
import { Activity, AppWindow, Bot, Boxes, ChevronDown, Columns2, Folder, FolderGit2, Maximize2, Minimize2, PanelLeft, PanelRight, PanelRightClose, Pencil, Plus, X } from "@lucide/vue";
import type { RepositorySessionKind } from "@task-handoff/protocol/repository";
import type { AiSessionSummary, InstanceBoardItem, InstanceResourceMetrics, InstanceWithAiSessions, NodeLocalFolder } from "../../../api/types";
import { Button } from "../../../components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../../components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { useControlPlaneLocale, type SupportedLocale } from "../../../i18n/index.ts";
import { formatBytes, formatPercent, formatTime } from "../../../i18n/presentation.ts";
import { translateApiError } from "../../../i18n/apiError";
import SessionPaneContent from "./SessionPaneContent.vue";
import AppLaunchMenuItems from "../shared/AppLaunchMenuItems.vue";
import ProjectFolderPicker from "../shared/ProjectFolderPicker.vue";
import RepositoryEnvironment from "./RepositoryEnvironment.vue";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { pruneTerminalPreviewCache } from "../useTerminalPreview";
import {
  appDisplayName,
  groupedAppSessionTabs,
  sessionMeta,
  sessionDisplayName,
  sessionStatusLabel,
  sessionWorkspacePath,
  shouldGroupAppSessionTabs,
  type LaunchableApp,
  type SessionTab,
} from "../useInstanceSessions";
import { hasInstanceStatusPage, instanceStatusTitle } from "../useInstanceStatus";
import type { InstanceAction } from "../useInstanceActions";
import type { SessionPaneId } from "./useActiveInstanceSessions";

const { t } = useI18n();

const props = defineProps<{
  activeActionLabel: (instance: InstanceBoardItem, action: InstanceAction, idleLabel: string) => string;
  activeAttachUrl: string;
  activeInstanceWebUrl: string;
  activeOpenUrl: string;
  activeSession?: SessionTab;
  activeSessionFrameUrl: string;
  activeSessionKey: string;
  activeTerminalSocketUrl: string;
  appLaunchButtonLabel: string;
  appLaunchButtonTitle: string;
  appLaunchMenuOpen: boolean;
  canLaunchApp: boolean;
  copiedText: string;
  instance: InstanceWithAiSessions;
  isInstanceActionBusy: (instance: InstanceBoardItem) => boolean;
  launchableApps: LaunchableApp[];
  launchingApp: boolean;
  lastRefreshLabel: string;
  leftSession?: SessionTab;
  leftSessionKey: string;
  leftSessionTabs: SessionTab[];
  nodeLocalFolders?: NodeLocalFolder[];
  orderedSessionTabs: SessionTab[];
  previewExpanded: boolean;
  resourceMetrics?: InstanceResourceMetrics;
  resourceMetricsError?: string;
  rightSession?: SessionTab;
  rightSessionKey: string;
  rightSessionTabs: SessionTab[];
  focusedSessionPane: SessionPaneId;
  hasSessionSplit: boolean;
  sessionSplitRatio: number;
  renameSession: (instance: InstanceBoardItem, session: SessionTab, title: string) => Promise<void>;
  selectedAiSession: (instance: InstanceBoardItem, sessions?: AiSessionSummary[]) => AiSessionSummary | undefined;
  sessionMenuOpen: boolean;
  sessionTabs: SessionTab[];
  stoppingSessionId: string;
}>();

const emit = defineEmits<{
  copyRegistration: [instance: InstanceBoardItem];
  launchApp: [instance: InstanceBoardItem, appId: string, cwdFolderId?: string];
  moveSessionTab: [sourceKey: string, targetKey: string, placement: "before" | "after", targetPane?: SessionPaneId];
  moveSessionToPane: [sessionKey: string, pane: SessionPaneId];
  focusSessionPane: [pane: SessionPaneId];
  openSessionSplit: [];
  closeSessionSplit: [];
  setSessionSplitRatio: [ratio: number];
  openAiSessionApp: [instance: InstanceBoardItem, session?: AiSessionSummary];
  openRepositoryWorkspace: [target: { initialView: "files" | "changes"; sessionId: string; sessionKind: RepositorySessionKind }];
  openSettings: [instanceId: string, section?: "general" | "models" | "apps"];
  openUrl: [url: string];
  runAction: [action: InstanceAction, instance: InstanceBoardItem];
  selectAiSession: [instanceId: string, sessionId: string];
  selectSession: [sessionKey: string, pane?: SessionPaneId];
  stopSession: [instance: InstanceBoardItem, session: SessionTab];
  "update:appLaunchMenuOpen": [open: boolean];
  "update:previewExpanded": [expanded: boolean];
  "update:sessionMenuOpen": [open: boolean];
}>();

const resourceMetricsNow = useNow({ interval: 1_000 });
const sessionSplitAvailable = useMediaQuery("(min-width: 781px)");

watch([sessionSplitAvailable, () => props.hasSessionSplit], ([available, split]) => {
  if (!available && split) emit("closeSessionSplit");
}, { immediate: true });
watch(
  [() => props.instance.id, () => props.sessionTabs.map((session) => `${session.key}:${session.kind}`).join("\n")],
  ([instanceId]) => {
    pruneTerminalPreviewCache(
      instanceId,
      new Set(props.sessionTabs.filter((session) => session.kind === "terminal").map((session) => session.key)),
    );
  },
  { immediate: true },
);
const { locale } = useControlPlaneLocale();
const activeRepositorySessionId = computed(() => {
  if (!props.activeSession || props.activeSession.kind === "ai" || props.activeSession.kind === "status" || props.activeSession.kind === "repository") return "";
  return typeof props.activeSession.source?.id === "string" ? props.activeSession.source.id : props.activeSession.key;
});
const resourceMetricsDisplay = computed(() => formatResourceMetrics(props.resourceMetrics, resourceMetricsNow.value.getTime(), locale.value, t));
const sessionTabOverflowObservers = new WeakMap<HTMLElement, ResizeObserver>();
const sessionTabDetailSession = ref<SessionTab>();
const sessionTabDetailVisible = ref(false);
const sessionTabDetailPosition = ref({ left: 12, top: 12 });
const sessionTabDetailStyle = computed(() => ({
  left: `${sessionTabDetailPosition.value.left}px`,
  top: `${sessionTabDetailPosition.value.top}px`,
}));
const SESSION_TAB_DETAIL_DELAY_MS = 1_000;
const SESSION_TAB_DETAIL_SKIP_DELAY_MS = 800;
const SESSION_TAB_DETAIL_CLOSE_DELAY_MS = 120;
let sessionTabDetailOpenTimer: ReturnType<typeof setTimeout> | undefined;
let sessionTabDetailCloseTimer: ReturnType<typeof setTimeout> | undefined;
let sessionTabDetailClosedAt = 0;

function sessionTabWorkspaceLabel(session: SessionTab) {
  const path = sessionWorkspacePath(session, props.instance);
  return path === "__unknown_workspace__" ? t("sessions.tabs.unknownWorkspace") : path;
}

function cancelSessionTabDetailClose() {
  if (!sessionTabDetailCloseTimer) return;
  clearTimeout(sessionTabDetailCloseTimer);
  sessionTabDetailCloseTimer = undefined;
}

function closeSessionTabDetail() {
  if (sessionTabDetailOpenTimer) clearTimeout(sessionTabDetailOpenTimer);
  if (sessionTabDetailCloseTimer) clearTimeout(sessionTabDetailCloseTimer);
  sessionTabDetailOpenTimer = undefined;
  sessionTabDetailCloseTimer = undefined;
  if (sessionTabDetailVisible.value) sessionTabDetailClosedAt = Date.now();
  sessionTabDetailVisible.value = false;
}

function scheduleSessionTabDetailClose() {
  if (sessionTabDetailOpenTimer) clearTimeout(sessionTabDetailOpenTimer);
  sessionTabDetailOpenTimer = undefined;
  cancelSessionTabDetailClose();
  sessionTabDetailCloseTimer = setTimeout(closeSessionTabDetail, SESSION_TAB_DETAIL_CLOSE_DELAY_MS);
}

function showSessionTabDetail(event: Event, session: SessionTab) {
  if (!(event.currentTarget instanceof HTMLElement)) return;
  cancelSessionTabDetailClose();
  if (sessionTabDetailOpenTimer) clearTimeout(sessionTabDetailOpenTimer);
  const bounds = event.currentTarget.getBoundingClientRect();
  const cardWidth = Math.min(280, window.innerWidth - 24);
  sessionTabDetailPosition.value = {
    left: Math.max(12, Math.min(bounds.left, window.innerWidth - cardWidth - 12)),
    top: bounds.bottom + 4,
  };
  sessionTabDetailSession.value = session;
  if (sessionTabDetailVisible.value || Date.now() - sessionTabDetailClosedAt <= SESSION_TAB_DETAIL_SKIP_DELAY_MS) {
    sessionTabDetailVisible.value = true;
    return;
  }
  sessionTabDetailOpenTimer = setTimeout(() => {
    sessionTabDetailVisible.value = true;
    sessionTabDetailOpenTimer = undefined;
  }, SESSION_TAB_DETAIL_DELAY_MS);
}

function updateSessionTabOverflow(tabList: HTMLElement) {
  const maxScrollLeft = Math.max(0, tabList.scrollWidth - tabList.clientWidth);
  tabList.dataset.overflowStart = String(tabList.scrollLeft > 1);
  tabList.dataset.overflowEnd = String(tabList.scrollLeft < maxScrollLeft - 1);
}

function updateSessionTabOverflowFromEvent(event: Event) {
  if (event.currentTarget instanceof HTMLElement) updateSessionTabOverflow(event.currentTarget);
}

function revealSelectedSessionTab(tabList: HTMLElement) {
  const selectedTab = tabList.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (!selectedTab) return;
  const viewportBounds = tabList.getBoundingClientRect();
  const tabBounds = selectedTab.getBoundingClientRect();
  let nextScrollLeft = tabList.scrollLeft;
  if (tabBounds.left < viewportBounds.left) nextScrollLeft -= viewportBounds.left - tabBounds.left;
  else if (tabBounds.right > viewportBounds.right) nextScrollLeft += tabBounds.right - viewportBounds.right;
  tabList.scrollLeft = Math.max(0, Math.min(tabList.scrollWidth - tabList.clientWidth, nextScrollLeft));
}

function syncSessionTabViewport(tabList: HTMLElement) {
  revealSelectedSessionTab(tabList);
  updateSessionTabOverflow(tabList);
}

const vSessionTabOverflow: ObjectDirective<HTMLElement> = {
  mounted(tabList) {
    const observer = new ResizeObserver(() => syncSessionTabViewport(tabList));
    observer.observe(tabList);
    if (tabList.firstElementChild instanceof HTMLElement) observer.observe(tabList.firstElementChild);
    sessionTabOverflowObservers.set(tabList, observer);
    syncSessionTabViewport(tabList);
  },
  updated(tabList) {
    void nextTick(() => syncSessionTabViewport(tabList));
  },
  unmounted(tabList) {
    sessionTabOverflowObservers.get(tabList)?.disconnect();
    sessionTabOverflowObservers.delete(tabList);
  },
};

function scrollSessionTabs(event: WheelEvent) {
  const tabList = event.currentTarget as HTMLElement | null;
  if (!tabList || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || tabList.scrollWidth <= tabList.clientWidth) return;
  const nextScrollLeft = Math.max(0, Math.min(tabList.scrollWidth - tabList.clientWidth, tabList.scrollLeft + event.deltaY));
  if (nextScrollLeft === tabList.scrollLeft) return;
  event.preventDefault();
  tabList.scrollLeft = nextScrollLeft;
  updateSessionTabOverflow(tabList);
}

function formatResourceMetrics(metrics: InstanceResourceMetrics | undefined, currentTime: number, locale: SupportedLocale, translate: typeof t) {
  if (!metrics) return { state: "loading", compact: translate("sessions.tabs.resourcesLoading"), title: translate("sessions.tabs.waitingMetrics") };
  const sampledAt = new Date(metrics.sampledAt);
  const stale = currentTime - sampledAt.getTime() > 10_000;
  if (metrics.state === "pending") return { state: "pending", compact: translate("sessions.tabs.resourcesStarting"), title: translate("sessions.tabs.waitingContainer", { time: formatTime(sampledAt, locale) }) };
  if (metrics.state === "stopped") return { state: "stopped", compact: translate("sessions.tabs.resourcesStopped"), title: translate("sessions.tabs.containerStopped", { time: formatTime(sampledAt, locale) }) };
  if (metrics.state === "unavailable") return { state: "unavailable", compact: translate("sessions.tabs.resourcesUnavailable"), title: translate("sessions.tabs.sampledError", { error: metrics.error || translate("sessions.tabs.metricsUnavailable"), time: formatTime(sampledAt, locale) }) };
  const cpu = translate("sessions.tabs.cpu", { value: metrics.cpu ? formatPercent(metrics.cpu.usagePercent / 100, locale) : "—" });
  const memory = metrics.memory
    ? translate("sessions.tabs.memory", { value: `${formatBytes(metrics.memory.usageBytes, locale)}${metrics.memory.limitBytes ? ` / ${formatBytes(metrics.memory.limitBytes, locale)}` : ""}${metrics.memory.usagePercent !== undefined ? ` (${formatPercent(metrics.memory.usagePercent / 100, locale)})` : ""}` })
    : translate("sessions.tabs.memory", { value: "—" });
  const details = [cpu, memory];
  if (metrics.network) details.push(translate("sessions.tabs.network", { rx: formatBytes(metrics.network.rxBytes, locale), tx: formatBytes(metrics.network.txBytes, locale) }));
  if (metrics.pids !== undefined) details.push(translate("sessions.tabs.processes", { count: metrics.pids }));
  details.push(translate("sessions.tabs.sampled", { time: formatTime(sampledAt, locale) }));
  return { state: stale ? "stale" : "available", compact: stale ? translate("sessions.tabs.resourcesStale") : `${cpu} · ${memory}`, title: details.join(" · ") };
}

const projectPickerOpen = ref(false);
const createdProjectFolders = ref<NodeLocalFolder[]>([]);
const draggingSessionTabKey = ref("");
const sessionTabDropTarget = ref<{ pane: SessionPaneId; targetKey: string; placement: "before" | "after" }>();
const sessionPreview = ref<HTMLElement>();
const sessionTabPointerDrag = ref<{
  pointerId: number;
  session: SessionTab;
  x: number;
  y: number;
  width: number;
  height: number;
}>();
let pendingSessionTabPointer: {
  pointerId: number;
  pointerType: string;
  session: SessionTab;
  pane: SessionPaneId;
  tab: HTMLElement;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
} | undefined;
const mobileSessionTabDragHoldMs = 420;
const mobileSessionTabDragMoveTolerance = 8;
let sessionTabLongPressTimer: number | undefined;
let sessionTabDragMoved = false;
let suppressSessionTabClickUntil = 0;
const editingSessionKey = ref("");
const sessionTitleDraft = ref("");
const sessionRenameError = ref("");
const renamingSession = ref(false);
const renameInput = ref<HTMLInputElement>();
const appLaunchMenuPane = ref<SessionPaneId>(props.focusedSessionPane);
const sessionMenuPane = ref<SessionPaneId>(props.focusedSessionPane);
const visibleTabGroups = computed(() => {
  const groups = props.hasSessionSplit
    ? [{ id: "left" as const, tabs: props.leftSessionTabs }, { id: "right" as const, tabs: props.rightSessionTabs }]
    : [{ id: "left" as const, tabs: props.orderedSessionTabs }];
  return groups.map(({ id, tabs }) => {
    const activeKey = props.hasSessionSplit ? (id === "left" ? props.leftSessionKey : props.rightSessionKey) : props.activeSessionKey;
    return {
      id,
      tabs,
      statusTab: tabs.find((session) => session.kind === "status"),
      aiTab: tabs.find((session) => session.kind === "ai"),
      appTabs: tabs.filter((session) => session.kind !== "ai" && session.kind !== "status"),
      groupSessionMenu: shouldGroupAppSessionTabs(props.instance, tabs),
      groupedAppSessions: groupedAppSessionTabs(props.instance, tabs, activeKey, t),
    };
  });
});
const visiblePanes = computed(() => [
  { id: "left" as const, tabs: props.leftSessionTabs, session: props.leftSession, sessionKey: props.leftSessionKey },
  ...(props.hasSessionSplit ? [{ id: "right" as const, tabs: props.rightSessionTabs, session: props.rightSession, sessionKey: props.rightSessionKey }] : []),
]);
const canOpenSessionSplit = computed(() => props.leftSessionTabs.some((session) => session.kind !== "ai" && session.kind !== "status"));
const sessionPaneLayout = ref<HTMLElement>();
const splitResizing = ref(false);
let stopSplitResize: (() => void) | undefined;
const projectFolders = computed(() => [...new Map([...(props.nodeLocalFolders || []), ...createdProjectFolders.value].map((folder) => [folder.id, folder])).values()]);

function updateAppLaunchMenuOpen(pane: SessionPaneId, open: boolean) {
  if (open) {
    appLaunchMenuPane.value = pane;
    emit("focusSessionPane", pane);
  }
  emit("update:appLaunchMenuOpen", open);
}

function updateSessionMenuOpen(pane: SessionPaneId, open: boolean) {
  if (open) {
    sessionMenuPane.value = pane;
    emit("focusSessionPane", pane);
  }
  emit("update:sessionMenuOpen", open);
}

function openProjectPicker() {
  projectPickerOpen.value = true;
}

function handleProjectCreated(folder: NodeLocalFolder) {
  createdProjectFolders.value = [...createdProjectFolders.value, folder];
  projectPickerOpen.value = false;
}

function isSessionTabActive(session: SessionTab) {
  if (hasInstanceStatusPage(props.instance)) return session.kind === "status";
  if (!props.hasSessionSplit) return session.key === props.activeSessionKey;
  return session.key === props.leftSessionKey || session.key === props.rightSessionKey;
}

function sessionPaneId(session: SessionTab): SessionPaneId {
  return props.rightSessionTabs.some((item) => item.key === session.key) ? "right" : "left";
}

function isSessionTabFocused(session: SessionTab) {
  return isSessionTabActive(session) && sessionPaneId(session) === props.focusedSessionPane;
}

function setRenameInput(element: Element | ComponentPublicInstance | null) {
  renameInput.value = element instanceof HTMLInputElement ? element : undefined;
}

async function beginSessionRename(session: SessionTab) {
  editingSessionKey.value = session.key;
  sessionTitleDraft.value = sessionDisplayName(session, t);
  sessionRenameError.value = "";
  await nextTick();
  renameInput.value?.focus();
  renameInput.value?.select();
}

function cancelSessionRename() {
  editingSessionKey.value = "";
  sessionTitleDraft.value = "";
  sessionRenameError.value = "";
  renamingSession.value = false;
}

async function commitSessionRename(session: SessionTab) {
  if (editingSessionKey.value !== session.key || renamingSession.value) {
    return;
  }
  const title = sessionTitleDraft.value.trim();
  if (!title) {
    sessionRenameError.value = t("sessions.tabs.titleRequired");
    await nextTick();
    renameInput.value?.focus();
    return;
  }
  if (title === sessionDisplayName(session, t)) {
    cancelSessionRename();
    return;
  }
  renamingSession.value = true;
  sessionRenameError.value = "";
  try {
    await props.renameSession(props.instance, session, title);
    cancelSessionRename();
  } catch (error) {
    renamingSession.value = false;
    showControlPlaneToast(translateApiError(error, t, t("sessions.tabs.renameFailed")));
    await nextTick();
    renameInput.value?.focus();
  }
}

function launchApp(appId: string, cwdFolderId?: string) {
  emit("update:appLaunchMenuOpen", false);
  emit("launchApp", props.instance, appId, cwdFolderId);
}

const sessionTabPointerOverlayStyle = computed(() => {
  const drag = sessionTabPointerDrag.value;
  return drag
    ? {
        width: `${drag.width}px`,
        height: `${drag.height}px`,
        transform: `translate3d(${drag.x}px, ${drag.y}px, 0)`,
      }
    : undefined;
});

function previewSessionTabs(pane: SessionPaneId, tabs: SessionTab[]) {
  const drag = sessionTabPointerDrag.value;
  const target = sessionTabDropTarget.value;
  if (!drag || !target) return tabs;
  const nextTabs = tabs.filter((session) => session.key !== drag.session.key);
  if (target.pane !== pane) return nextTabs;
  if (!target.targetKey) return [...nextTabs, drag.session];
  const targetIndex = nextTabs.findIndex((session) => session.key === target.targetKey);
  if (targetIndex < 0) return [...nextTabs, drag.session];
  nextTabs.splice(target.placement === "after" ? targetIndex + 1 : targetIndex, 0, drag.session);
  return nextTabs;
}

function selectSessionFromTab(event: MouseEvent, sessionKey: string) {
  if (Date.now() < suppressSessionTabClickUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  emit("selectSession", sessionKey);
}

function startSessionTabPointer(event: PointerEvent, session: SessionTab, pane: SessionPaneId) {
  if (event.button !== 0 || editingSessionKey.value === session.key) return;
  const target = event.target instanceof Element ? event.target : undefined;
  if (target?.closest("button, input")) return;
  const tab = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  if (!tab) return;
  cancelSessionTabPointerDrag();
  const bounds = tab.getBoundingClientRect();
  pendingSessionTabPointer = {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    session,
    pane,
    tab,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: event.clientX - bounds.left,
    offsetY: event.clientY - bounds.top,
    width: bounds.width,
    height: bounds.height,
  };
  window.addEventListener("pointermove", moveSessionTabPointer, true);
  window.addEventListener("pointerup", finishSessionTabPointer, true);
  window.addEventListener("pointercancel", cancelSessionTabPointerDrag, true);
  window.addEventListener("keydown", cancelSessionTabPointerDragOnEscape, true);
  window.addEventListener("blur", cancelSessionTabPointerDrag);
  if (!sessionSplitAvailable.value && event.pointerType === "touch") {
    sessionTabLongPressTimer = window.setTimeout(() => {
      const pending = pendingSessionTabPointer;
      if (!pending || pending.pointerId !== event.pointerId) return;
      activateSessionTabPointerDrag(pending.startX, pending.startY);
    }, mobileSessionTabDragHoldMs);
  }
}

function moveSessionTabPointer(event: PointerEvent) {
  const pending = pendingSessionTabPointer;
  if (!pending || event.pointerId !== pending.pointerId) return;
  const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
  const waitsForLongPress = !sessionSplitAvailable.value && pending.pointerType === "touch";
  if (!sessionTabPointerDrag.value && waitsForLongPress) {
    if (distance > mobileSessionTabDragMoveTolerance) cleanupSessionTabPointerDrag(false);
    return;
  }
  if (!sessionTabPointerDrag.value && distance < 5) return;
  event.preventDefault();
  if (!sessionTabPointerDrag.value) {
    activateSessionTabPointerDrag(event.clientX, event.clientY);
  } else {
    sessionTabPointerDrag.value.x = event.clientX - pending.offsetX;
    sessionTabPointerDrag.value.y = event.clientY - pending.offsetY;
  }
  sessionTabDragMoved = true;
  updateSessionTabPointerTarget(event.clientX, event.clientY);
}

function activateSessionTabPointerDrag(clientX: number, clientY: number) {
  const pending = pendingSessionTabPointer;
  if (!pending || sessionTabPointerDrag.value) return;
  clearSessionTabLongPressTimer();
  try {
    pending.tab.setPointerCapture?.(pending.pointerId);
  } catch {
    // Window-level listeners keep dragging functional when a WebView cannot capture this pointer.
  }
  draggingSessionTabKey.value = pending.session.key;
  sessionTabPointerDrag.value = {
    pointerId: pending.pointerId,
    session: pending.session,
    x: clientX - pending.offsetX,
    y: clientY - pending.offsetY,
    width: pending.width,
    height: pending.height,
  };
  document.body.classList.add("session-tab-pointer-dragging");
}

function updateSessionTabPointerTarget(clientX: number, clientY: number) {
  const root = sessionPreview.value;
  const hit = document.elementFromPoint(clientX, clientY);
  const selector = hit instanceof Element ? hit.closest<HTMLElement>(".session-preview-selector") : null;
  if (!root || !selector || !root.contains(selector)) {
    sessionTabDropTarget.value = undefined;
    return;
  }
  const pane = selector.dataset.pane === "right" ? "right" : "left";
  const tabs = [...selector.querySelectorAll<HTMLElement>("[data-session-tab-key]")]
    .filter((tab) => tab.dataset.sessionTabKey !== draggingSessionTabKey.value);
  const target = tabs.find((tab) => clientX < tab.getBoundingClientRect().left + tab.getBoundingClientRect().width / 2);
  const last = tabs.at(-1);
  sessionTabDropTarget.value = target
    ? { pane, targetKey: target.dataset.sessionTabKey || "", placement: "before" }
    : last
      ? { pane, targetKey: last.dataset.sessionTabKey || "", placement: "after" }
      : { pane, targetKey: "", placement: "after" };
  scrollSessionTabDragViewport(selector, clientX);
}

function scrollSessionTabDragViewport(selector: HTMLElement, clientX: number) {
  const tabList = selector.querySelector<HTMLElement>(".session-tab-strip");
  if (!tabList || tabList.scrollWidth <= tabList.clientWidth) return;
  const bounds = tabList.getBoundingClientRect();
  const edge = Math.min(36, bounds.width / 4);
  const delta = clientX < bounds.left + edge ? -12 : clientX > bounds.right - edge ? 12 : 0;
  if (!delta) return;
  tabList.scrollLeft = Math.max(0, Math.min(tabList.scrollWidth - tabList.clientWidth, tabList.scrollLeft + delta));
  updateSessionTabOverflow(tabList);
}

function finishSessionTabPointer(event: PointerEvent) {
  if (!pendingSessionTabPointer || event.pointerId !== pendingSessionTabPointer.pointerId) return;
  const wasDragging = Boolean(sessionTabPointerDrag.value);
  if (wasDragging && sessionTabDragMoved) updateSessionTabPointerTarget(event.clientX, event.clientY);
  const target = sessionTabDropTarget.value;
  if (wasDragging && sessionTabDragMoved && draggingSessionTabKey.value && target) {
    emit("moveSessionTab", draggingSessionTabKey.value, target.targetKey, target.placement, target.pane);
  }
  cleanupSessionTabPointerDrag(wasDragging);
}

function cancelSessionTabPointerDragOnEscape(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  cancelSessionTabPointerDrag();
}

function cancelSessionTabPointerDrag() {
  cleanupSessionTabPointerDrag(Boolean(sessionTabPointerDrag.value));
}

function cleanupSessionTabPointerDrag(suppressClick: boolean) {
  clearSessionTabLongPressTimer();
  window.removeEventListener("pointermove", moveSessionTabPointer, true);
  window.removeEventListener("pointerup", finishSessionTabPointer, true);
  window.removeEventListener("pointercancel", cancelSessionTabPointerDrag, true);
  window.removeEventListener("keydown", cancelSessionTabPointerDragOnEscape, true);
  window.removeEventListener("blur", cancelSessionTabPointerDrag);
  const pending = pendingSessionTabPointer;
  if (pending?.tab.hasPointerCapture?.(pending.pointerId)) pending.tab.releasePointerCapture(pending.pointerId);
  pendingSessionTabPointer = undefined;
  sessionTabPointerDrag.value = undefined;
  draggingSessionTabKey.value = "";
  sessionTabDropTarget.value = undefined;
  sessionTabDragMoved = false;
  document.body.classList.remove("session-tab-pointer-dragging");
  if (suppressClick) suppressSessionTabClickUntil = Date.now() + 250;
}

function clearSessionTabLongPressTimer() {
  if (sessionTabLongPressTimer === undefined) return;
  window.clearTimeout(sessionTabLongPressTimer);
  sessionTabLongPressTimer = undefined;
}

function startSplitResize(event: PointerEvent) {
  const layout = sessionPaneLayout.value;
  if (!layout || event.button !== 0) return;
  event.preventDefault();
  splitResizing.value = true;
  document.body.classList.add("session-pane-resizing");
  const resize = (moveEvent: PointerEvent) => {
    const bounds = layout.getBoundingClientRect();
    if (bounds.width) emit("setSessionSplitRatio", (moveEvent.clientX - bounds.left) / bounds.width);
  };
  const stop = () => {
    splitResizing.value = false;
    document.body.classList.remove("session-pane-resizing");
    window.removeEventListener("pointermove", resize);
    window.removeEventListener("pointerup", stop);
    stopSplitResize = undefined;
  };
  stopSplitResize?.();
  stopSplitResize = stop;
  window.addEventListener("pointermove", resize);
  window.addEventListener("pointerup", stop, { once: true });
}

onBeforeUnmount(() => {
  stopSplitResize?.();
  cancelSessionTabPointerDrag();
  closeSessionTabDetail();
  document.body.classList.remove("session-pane-resizing");
});
</script>

<style scoped src="./SessionPreview.css"></style>
