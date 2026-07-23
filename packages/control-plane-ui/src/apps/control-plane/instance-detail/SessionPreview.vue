<template>
  <section class="session-preview" :class="{ expanded: previewExpanded }" :data-state="instance.connectionStatus">
    <div class="session-preview-toolbar" :class="{ split: hasSessionSplit }">
      <div class="session-preview-primary-tools" :class="{ split: hasSessionSplit }" :style="hasSessionSplit ? { '--session-left-ratio': `${sessionSplitRatio * 100}%` } : undefined">
        <div v-for="tabGroup in visibleTabGroups" :key="tabGroup.id" class="session-preview-selector" :data-pane="tabGroup.id" :aria-label="hasSessionSplit ? `${tabGroup.id} session views` : 'Session views'" @click.stop>
          <button
            v-if="tabGroup.statusTab"
            type="button"
            class="session-ai-home"
            :class="{ active: isSessionTabActive(tabGroup.statusTab), focused: isSessionTabFocused(tabGroup.statusTab) }"
            :title="instanceStatusTitle(instance)"
            @click="$emit('selectSession', tabGroup.statusTab.key, tabGroup.id)"
          >
            <Activity :size="15" />
            <span>Status</span>
          </button>
          <span v-if="tabGroup.statusTab && (tabGroup.aiTab || tabGroup.appTabs.length)" class="session-tab-divider" aria-hidden="true" />
          <button
            v-if="tabGroup.aiTab"
            type="button"
            class="session-ai-home"
            :class="{ active: isSessionTabActive(tabGroup.aiTab), focused: isSessionTabFocused(tabGroup.aiTab), dragging: draggingSessionTabKey === tabGroup.aiTab.key }"
            draggable="true"
            :title="sessionMeta(tabGroup.aiTab)"
            @click="$emit('selectSession', tabGroup.aiTab.key, tabGroup.id)"
            @dragstart="startSessionTabDrag($event, tabGroup.aiTab)"
            @dragover.prevent
            @dragenter.prevent
            @drop.prevent="dropSessionTab($event, tabGroup.aiTab, tabGroup.id)"
            @dragend="endSessionTabDrag"
          >
            <span class="session-ai-icon">
              <Bot :size="15" />
              <span class="session-tab-dot" :data-state="tabGroup.aiTab.status" />
            </span>
            <span>AI</span>
          </button>
          <span v-if="tabGroup.aiTab && tabGroup.appTabs.length" class="session-tab-divider" aria-hidden="true" />
          <ScrollArea v-if="tabGroup.appTabs.length" class="session-tab-strip">
            <div class="session-tab-strip-content" role="tablist" :aria-label="hasSessionSplit ? `${tabGroup.id} session tabs` : 'Session views'">
              <ContextMenu v-for="session in tabGroup.appTabs" :key="session.key">
                <ContextMenuTrigger as-child>
                  <span
                    class="session-tab-item"
                    :class="{ active: isSessionTabActive(session), focused: isSessionTabFocused(session), dragging: draggingSessionTabKey === session.key }"
                    :data-kind="session.kind"
                    :data-pane="hasSessionSplit ? sessionPaneId(session) : undefined"
                    role="tab"
                    tabindex="0"
                    :draggable="editingSessionKey !== session.key"
                    :aria-selected="isSessionTabActive(session)"
                    :title="`${sessionDisplayName(session)} · ${stoppingSessionId === session.key ? 'stopping' : session.status}`"
                    @click="$emit('selectSession', session.key)"
                    @dragstart="startSessionTabDrag($event, session)"
                    @dragover.prevent
                    @dragenter.prevent
                    @drop.prevent="dropSessionTab($event, session, tabGroup.id)"
                    @dragend="endSessionTabDrag"
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
                        <strong>{{ sessionDisplayName(session) }}</strong>
                      </span>
                    </span>
                    <button
                      type="button"
                      class="session-tab-close"
                      :disabled="Boolean(stoppingSessionId)"
                      :aria-label="`Close ${sessionDisplayName(session)}`"
                      title="Close session"
                      @click.stop="$emit('stopSession', instance, session)"
                    >
                      <X :size="13" />
                    </button>
                  </span>
                </ContextMenuTrigger>
                <ContextMenuContent class="instance-action-menu">
                  <ContextMenuItem v-if="session.kind !== 'repository'" class="instance-action-item" @select="beginSessionRename(session)">
                    <Pencil :size="14" />
                    <span>Rename session</span>
                  </ContextMenuItem>
                  <ContextMenuItem v-if="sessionPaneId(session) === 'right'" class="instance-action-item" @select="$emit('moveSessionToPane', session.key, 'left')">
                    <PanelLeft :size="14" />
                    <span>Move to left</span>
                  </ContextMenuItem>
                  <ContextMenuItem v-else class="instance-action-item" @select="$emit('moveSessionToPane', session.key, 'right')">
                    <PanelRight :size="14" />
                    <span>Move to right</span>
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </div>
          </ScrollArea>
          <div class="app-launcher" :class="{ open: appLaunchMenuOpen && appLaunchMenuPane === tabGroup.id }" @click.stop>
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
                    <strong>Manage apps</strong>
                    <small>Install or uninstall apps</small>
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <DropdownMenu :open="sessionMenuOpen && sessionMenuPane === tabGroup.id" @update:open="updateSessionMenuOpen(tabGroup.id, $event)">
            <DropdownMenuTrigger as-child>
              <button type="button" class="session-tab-menu-trigger" :aria-expanded="sessionMenuOpen && sessionMenuPane === tabGroup.id" title="Sessions in this pane" aria-label="Sessions in this pane">
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
                      <strong>Status</strong>
                      <small>{{ instanceStatusTitle(instance) }}</small>
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
                      <strong>{{ appDisplayName(tabGroup.aiTab.label) }}</strong>
                      <small>{{ sessionMeta(tabGroup.aiTab) }}</small>
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
                        <strong>{{ sessionDisplayName(session) }}</strong>
                        <small>{{ sessionMeta(session) }}</small>
                      </span>
                    </span>
                    <button
                      type="button"
                      class="session-select-close"
                      :disabled="Boolean(stoppingSessionId)"
                      :aria-label="`Close ${session.label}`"
                      title="Close session"
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
                      <strong>{{ sessionDisplayName(session) }}</strong>
                      <small>{{ sessionMeta(session) }}</small>
                    </span>
                  </span>
                  <button
                    v-if="session.kind !== 'ai' && session.kind !== 'status'"
                    type="button"
                    class="session-select-close"
                    :disabled="Boolean(stoppingSessionId)"
                    :aria-label="`Close ${session.label}`"
                    title="Close session"
                    @click.stop="$emit('stopSession', instance, session)"
                  >
                    <X :size="13" />
                  </button>
                </DropdownMenuItem>
              </template>
              <DropdownMenuItem v-if="!tabGroup.tabs.length" class="session-select-row" disabled>
                <span class="session-select-option"><span><strong>No sessions in this pane</strong></span></span>
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
        <button type="button" class="preview-expand-button" :disabled="!hasSessionSplit && !canOpenSessionSplit" :aria-label="hasSessionSplit ? 'Close split view' : 'Split session view'" :title="hasSessionSplit ? 'Close split view' : 'Split session view'" @click="hasSessionSplit ? $emit('closeSessionSplit') : $emit('openSessionSplit')">
          <PanelRightClose v-if="hasSessionSplit" :size="15" />
          <Columns2 v-else :size="15" />
        </button>
        <button type="button" class="preview-expand-button" :aria-label="previewExpanded ? 'Restore session preview' : 'Expand session preview'" :title="previewExpanded ? 'Restore preview' : 'Expand preview'" @click="$emit('update:previewExpanded', !previewExpanded)">
          <Minimize2 v-if="previewExpanded" :size="15" />
          <Maximize2 v-else :size="15" />
        </button>
      </div>
    </div>
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
          :app-launch-button-title="appLaunchButtonTitle"
          :can-launch-app="canLaunchApp"
          :instance="instance"
          :launchable-apps="launchableApps"
          :launching-app="launchingApp"
          :node-local-folders="nodeLocalFolders"
          :selected-ai-session="selectedAiSession"
          :session="pane.session"
          :session-key="pane.sessionKey"
          :tabs="pane.tabs"
          @open-ai-session-app="(target, session) => $emit('openAiSessionApp', target, session)"
          @open-repository-workspace="$emit('openRepositoryWorkspace', $event)"
          @open-launch-menu="updateAppLaunchMenuOpen(pane.id, true)"
          @select-ai-session="(instanceId, sessionId) => $emit('selectAiSession', instanceId, sessionId)"
        />
      </section>
      <div v-if="hasSessionSplit" class="session-pane-resize-handle" role="separator" aria-label="Resize session panes" aria-orientation="vertical" :aria-valuenow="Math.round(sessionSplitRatio * 100)" tabindex="0" @pointerdown="startSplitResize" @dblclick="$emit('setSessionSplitRatio', 0.5)" @keydown.left.prevent="$emit('setSessionSplitRatio', sessionSplitRatio - 0.02)" @keydown.right.prevent="$emit('setSessionSplitRatio', sessionSplitRatio + 0.02)" />
    </div>
    <div class="session-preview-actions">
      <Button v-if="activeOpenUrl" variant="outline" size="sm" @click="$emit('openUrl', activeOpenUrl)">
        <ExternalLink :size="14" />
        <span>Open</span>
      </Button>
      <Button v-if="activeInstanceWebUrl && activeInstanceWebUrl !== activeOpenUrl" variant="outline" size="sm" @click="$emit('openUrl', activeInstanceWebUrl)">
        <Monitor :size="14" />
        <span>Instance</span>
      </Button>
      <Button v-if="activeAttachUrl && activeAttachUrl !== activeOpenUrl && activeAttachUrl !== activeInstanceWebUrl" variant="outline" size="sm" as="a" :href="activeAttachUrl" target="_blank" rel="noreferrer">
        <Terminal :size="14" />
        <span>Attach</span>
      </Button>
      <Button variant="outline" size="sm" @click="$emit('copyRegistration', instance)">
        <Copy :size="14" />
        <span>{{ copiedText === instance.id ? "Copied" : "Copy ID" }}</span>
      </Button>
      <p class="session-preview-status" aria-label="Instance status">
        <span>Health {{ instance.health }}</span>
        <span>Workspace {{ instance.workspace.status }}</span>
        <template v-if="resourceMetrics">
          <span class="session-resource-metrics" :data-state="resourceMetricsDisplay.state" :title="resourceMetricsDisplay.title">
            {{ resourceMetricsDisplay.compact }}
          </span>
        </template>
        <span v-else-if="instance.runtime?.type === 'docker'" class="session-resource-metrics" :data-state="resourceMetricsError ? 'unavailable' : 'loading'" :title="resourceMetricsError || 'Waiting for the first resource sample.'">
          {{ resourceMetricsError ? "Resources unavailable" : "Resources loading" }}
        </span>
        <span v-else>Last refresh {{ lastRefreshLabel }}</span>
      </p>
    </div>
    <ProjectFolderPicker
      :node-id="instance.nodeId"
      :node-name="instance.nodeId"
      :open="projectPickerOpen"
      @created="handleProjectCreated"
      @update:open="projectPickerOpen = $event"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, type ComponentPublicInstance } from "vue";
import { useNow } from "@vueuse/core";
import { Activity, AppWindow, Bot, Boxes, ChevronDown, Columns2, Copy, ExternalLink, Folder, FolderGit2, Maximize2, Minimize2, Monitor, PanelLeft, PanelRight, PanelRightClose, Pencil, Plus, Terminal, X } from "@lucide/vue";
import type { RepositorySessionKind } from "@task-handoff/protocol/repository";
import type { AiSessionSummary, InstanceBoardItem, InstanceResourceMetrics, InstanceWithAiSessions, NodeLocalFolder } from "../../../api/types";
import { Button } from "../../../components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../../components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import SessionPaneContent from "./SessionPaneContent.vue";
import AppLaunchMenuItems from "../shared/AppLaunchMenuItems.vue";
import ProjectFolderPicker from "../shared/ProjectFolderPicker.vue";
import RepositoryEnvironment from "./RepositoryEnvironment.vue";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import {
  appDisplayName,
  groupedAppSessionTabs,
  sessionMeta,
  sessionDisplayName,
  shouldGroupAppSessionTabs,
  type LaunchableApp,
  type SessionTab,
} from "../useInstanceSessions";
import { hasInstanceStatusPage, instanceStatusTitle } from "../useInstanceStatus";
import type { SessionPaneId } from "./useActiveInstanceSessions";

const props = defineProps<{
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
  selectAiSession: [instanceId: string, sessionId: string];
  selectSession: [sessionKey: string, pane?: SessionPaneId];
  stopSession: [instance: InstanceBoardItem, session: SessionTab];
  "update:appLaunchMenuOpen": [open: boolean];
  "update:previewExpanded": [expanded: boolean];
  "update:sessionMenuOpen": [open: boolean];
}>();

const resourceMetricsNow = useNow({ interval: 1_000 });
const activeRepositorySessionId = computed(() => {
  if (!props.activeSession || props.activeSession.kind === "ai" || props.activeSession.kind === "status" || props.activeSession.kind === "repository") return "";
  return typeof props.activeSession.source?.id === "string" ? props.activeSession.source.id : props.activeSession.key;
});
const resourceMetricsDisplay = computed(() => formatResourceMetrics(props.resourceMetrics, resourceMetricsNow.value.getTime()));

function formatResourceMetrics(metrics?: InstanceResourceMetrics, currentTime = Date.now()) {
  if (!metrics) return { state: "loading", compact: "Resources loading", title: "Waiting for the first resource sample." };
  const sampledAt = new Date(metrics.sampledAt);
  const stale = currentTime - sampledAt.getTime() > 10_000;
  if (metrics.state === "pending") return { state: "pending", compact: "Resources starting", title: `Waiting for the Docker container · sampled ${sampledAt.toLocaleTimeString()}` };
  if (metrics.state === "stopped") return { state: "stopped", compact: "Resources stopped", title: `Container stopped · sampled ${sampledAt.toLocaleTimeString()}` };
  if (metrics.state === "unavailable") return { state: "unavailable", compact: "Resources unavailable", title: `${metrics.error || "Docker metrics are unavailable."} · sampled ${sampledAt.toLocaleTimeString()}` };
  const cpu = metrics.cpu ? `CPU ${formatPercent(metrics.cpu.usagePercent)}` : "CPU —";
  const memory = metrics.memory
    ? `Memory ${formatBytes(metrics.memory.usageBytes)}${metrics.memory.limitBytes ? ` / ${formatBytes(metrics.memory.limitBytes)}` : ""}${metrics.memory.usagePercent !== undefined ? ` (${formatPercent(metrics.memory.usagePercent)})` : ""}`
    : "Memory —";
  const details = [cpu, memory];
  if (metrics.network) details.push(`Network ↓${formatBytes(metrics.network.rxBytes)} ↑${formatBytes(metrics.network.txBytes)}`);
  if (metrics.pids !== undefined) details.push(`Processes ${metrics.pids}`);
  details.push(`Sampled ${sampledAt.toLocaleTimeString()}`);
  return { state: stale ? "stale" : "available", compact: stale ? "Resources stale" : `${cpu} · ${memory}`, title: details.join(" · ") };
}

function formatPercent(value: number) {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let amount = value;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}

const projectPickerOpen = ref(false);
const createdProjectFolders = ref<NodeLocalFolder[]>([]);
const draggingSessionTabKey = ref("");
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
      groupedAppSessions: groupedAppSessionTabs(props.instance, tabs, activeKey),
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
  sessionTitleDraft.value = sessionDisplayName(session);
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
    sessionRenameError.value = "Session title is required.";
    await nextTick();
    renameInput.value?.focus();
    return;
  }
  if (title === sessionDisplayName(session)) {
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
    showControlPlaneToast(error instanceof Error ? error.message : "Failed to rename session.");
    await nextTick();
    renameInput.value?.focus();
  }
}

function launchApp(appId: string, cwdFolderId?: string) {
  emit("update:appLaunchMenuOpen", false);
  emit("launchApp", props.instance, appId, cwdFolderId);
}

function startSessionTabDrag(event: DragEvent, session: SessionTab) {
  draggingSessionTabKey.value = session.key;
  event.dataTransfer?.setData("text/plain", session.key);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
  }
}

function dropSessionTab(event: DragEvent, targetSession: SessionTab, targetPane?: SessionPaneId) {
  if (draggingSessionTabKey.value) {
    const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    const bounds = target?.getBoundingClientRect();
    const placement = bounds && event.clientX > bounds.left + bounds.width / 2 ? "after" : "before";
    emit("moveSessionTab", draggingSessionTabKey.value, targetSession.key, placement, targetPane);
  }
  endSessionTabDrag();
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
  document.body.classList.remove("session-pane-resizing");
});

function endSessionTabDrag() {
  draggingSessionTabKey.value = "";
}
</script>

<style scoped src="./SessionPreview.css"></style>
