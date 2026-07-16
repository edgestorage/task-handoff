<template>
  <div class="control-plane-shell">
    <header class="control-plane-topbar" @dblclick="controlWindow('toggle-maximize')">
      <div class="topbar-left">
        <div
          v-if="showCustomWindowControls"
          class="desktop-window-controls"
          aria-label="Window controls"
        >
          <button type="button" class="window-control close" aria-label="Close window" title="Close" @click.stop="controlWindow('close')">
            <X :size="11" />
          </button>
          <button type="button" class="window-control minimize" aria-label="Minimize window" title="Minimize" @click.stop="controlWindow('minimize')">
            <Minus :size="11" />
          </button>
          <button type="button" class="window-control maximize" aria-label="Maximize window" title="Maximize" @click.stop="controlWindow('toggle-maximize')">
            <Maximize2 :size="10" />
          </button>
        </div>
        <div v-else-if="showNativeWindowControlSpace" class="desktop-window-controls native-window-control-space" aria-hidden="true" />
        <div class="control-plane-title">
          <span class="control-plane-kicker">{{ topbarKicker }}</span>
          <strong>{{ topbarTitle }}</strong>
        </div>
      </div>
      <div class="control-plane-actions">
        <Button
          v-if="serverUpdateAvailable"
          variant="outline"
          size="sm"
          class="control-plane-update-indicator"
          :aria-label="`Update available: ${serverUpdateVersion}`"
          :title="`Update available: ${serverUpdateVersion}`"
          @click="openSettings('basic')"
        >
          <Download :size="15" />
          <span>Update available · {{ serverUpdateVersion }}</span>
        </Button>
        <div class="workbench-view-switcher" :data-active-view="workbenchView" aria-label="Workbench view">
          <button
            v-for="option in workbenchViewOptions"
            :key="option.value"
            type="button"
            class="workbench-view-option"
            :class="{ active: workbenchView === option.value }"
            :aria-pressed="workbenchView === option.value"
            @click="setWorkbenchView(option.value)"
          >
            <component :is="option.icon" :size="15" />
            <span>{{ option.label }}</span>
          </button>
        </div>
        <Button variant="outline" size="sm" aria-label="Refresh" title="Refresh" :disabled="refreshing" @click="refresh">
          <RefreshCw :size="15" />
          <span>Refresh</span>
        </Button>
        <Button :variant="settingsMode ? 'default' : 'outline'" size="sm" aria-label="Settings" title="Settings" :aria-pressed="settingsMode" @click="toggleSettings">
          <Settings :size="15" />
          <span>Settings</span>
        </Button>
        <Button v-if="authSession.data.value?.enabled" variant="outline" size="sm" aria-label="Sign out" title="Sign out" :disabled="signingOut" @click="signOut">
          <LogOut :size="15" />
          <span>{{ signingOut ? "Signing out" : "Sign out" }}</span>
        </Button>
      </div>
    </header>

    <main class="control-plane-workbench" :class="{ 'instances-collapsed': instancesCollapsed, 'board-mode': !instanceViewMode || settingsMode }" :style="workbenchStyle">
      <InstanceList
        v-if="instanceViewMode && !settingsMode"
        v-model:filter="instanceFilter"
        :active-action-label="activeActionLabel"
        :active-instance-id="activeInstance?.id"
        :can-export-config="canExportConfig"
        :collapsed="instancesCollapsed"
        :config-sync-label="configSyncLabel"
        :config-sync-presets="configSyncPresets"
        :error="board.error.value ? errorText(board.error.value) : ''"
        v-model:group-by-node="groupInstancesByNode"
        :instance-display-name="instanceDisplayName"
        :instances="filteredInstances"
        :is-config-sync-busy="isConfigSyncBusy"
        :is-instance-action-busy="isInstanceActionBusy"
        :loading="board.isLoading.value"
        :open-menu-id="openInstanceMenuId"
        v-model:sort-mode="instanceSortMode"
        :total-instances="sortedInstances.length"
        @collapse="collapseInstances"
        @expand="expandInstances"
        @new-instance="newInstanceOpen = true"
        @open-settings="openInstanceSettings"
        @resize-start="startInstanceResize"
        @run-action="runRowInstanceAction"
        @run-config-sync="runRowConfigSync"
        @select-instance="selectInstance"
        @set-menu-open="setInstanceMenuOpen"
      />

      <InstanceBoardView
        v-if="boardMode && !settingsMode"
        v-model:app-filter="boardBulkAppFilter"
        v-model:filter="boardFilter"
        v-model:group-by-node="groupInstancesByNode"
        v-model:project-filter="boardProjectFilter"
        v-model:sort-mode="instanceSortMode"
        v-model:status-filter="boardStatusFilter"
        :active-action-label="activeActionLabel"
        :active-instance-id="activeInstance?.id"
        :all-filter-value="ALL_BOARD_FILTER_VALUE"
        :app-options="boardAppOptions"
        :board-card-detail="boardCardDetail"
        :board-card-title="boardCardTitle"
        :board-open-url="boardOpenUrl"
        :board-preview-state="boardPreviewState"
        :board-primary-session="boardPrimarySession"
        :board-session-frame-url="boardSessionFrameUrl"
        :board-sessions="boardSessions"
        :board-terminal-socket-url="boardTerminalSocketUrl"
        :error="board.error.value ? errorText(board.error.value) : ''"
        :instance-display-name="instanceDisplayName"
        :is-instance-action-busy="isInstanceActionBusy"
        :launching-app="launchingApp"
        :loading="board.isLoading.value"
        :node-local-folders-by-node-id="nodeLocalFoldersByNodeId"
        :project-options="boardProjectOptions"
        :set-board-terminal-host="setBoardTerminalHost"
        :size="boardSize"
        :size-options="boardSizeOptions"
        :status-options="boardStatusOptions"
        :total-instances="sortedInstances.length"
        :visible-instances="boardVisibleInstances"
        @open-url="openAppUrl"
        @launch-app="launchSelectedApp"
        @run-action="runInstanceAction"
        @select-board-session="selectBoardSession"
        @select-instance="selectInstance"
        @set-size="setBoardSize"
      />

      <AiSessionBoardView
        v-if="aiBoardMode && !settingsMode"
        v-model:filter="aiBoardFilter"
        :approval-busy-key="aiApprovalBusyKey"
        :error="board.error.value ? errorText(board.error.value) : ''"
        :instance-display-name="instanceDisplayName"
        :instances="boardInstancesWithAiSessions"
        :loading="board.isLoading.value"
        @open-ai-session-app="openAiSessionAppFromBoard"
        @resolve-approval="resolveAiSessionApprovalAction"
        @select-instance="selectInstance"
      />

      <SettingsModal
        v-if="settingsMode"
        :choose-project-folder="desktopBridge?.chooseProjectFolder"
        :initial-section="settingsSection"
        :instances="sortedInstances"
        @back="closeSettings"
        @open-instance-settings="openInstanceSettings"
        @section-change="settingsSection = $event"
      />

      <InstanceDetail
        v-else-if="instanceViewMode && !settingsMode"
        v-model:app-launch-menu-open="appLaunchMenuOpen"
        v-model:preview-expanded="sessionPreviewExpanded"
        v-model:session-menu-open="sessionMenuOpen"
        :active-action-label="activeActionLabel"
        :active-attach-url="activeAttachUrl"
        :active-instance-web-url="activeInstanceWebUrl"
        :active-open-url="activeOpenUrl"
        :active-session="activeSession"
        :active-session-frame-url="activeSessionFrameUrl"
        :active-session-key="activeSessionKey"
        :active-terminal-socket-url="activeTerminalSocketUrl"
        :app-launch-button-label="appLaunchButtonLabel"
        :app-launch-button-title="appLaunchButtonTitle"
        :can-launch-app="canLaunchApp"
        :copied-text="copiedText"
        :error="board.error.value ? errorText(board.error.value) : ''"
        :instance="activeInstanceWithAiSessions"
        :instance-connecting="activeInstanceConnecting"
        :instance-display-name="instanceDisplayName"
        :is-instance-action-busy="isInstanceActionBusy"
        :last-refresh-label="lastRefreshLabel"
        :launchable-apps="launchableApps"
        :launching-app="launchingApp"
        :loading="board.isLoading.value"
        :node-local-folders="activeNodeLocalFolders"
        :rename-instance="renameInstance"
        :rename-session="renameSession"
        :selected-ai-session="selectedAiSession"
        :ordered-session-tabs="orderedSessionTabs"
        :session-tabs="sessionTabs"
        :stopping-session-id="stoppingSessionId"
        @copy-registration="copyRegistration"
        @launch-app="launchSelectedApp"
        @new-instance="newInstanceOpen = true"
        @open-ai-session-app="openAiSessionApp"
        @open-settings="openInstanceSettings"
        @open-url="openAppUrl"
        @move-session-tab="moveSessionTab"
        @run-action="runInstanceAction"
        @select-ai-session="selectAiSession"
        @select-session="selectSession"
        @stop-session="stopSelectedAppSession"
      />
    </main>

    <NewInstanceModal v-if="newInstanceOpen" :choose-project-folder="desktopBridge?.chooseProjectFolder" @close="newInstanceOpen = false" @created="handleInstanceCreated" />

    <InstanceSettingsDialog
      v-model:open="instanceSettingsOpen"
      :instance="instanceSettingsInstance"
      :models="models.data.value || []"
      :app-management="instanceSettingsAppManagement?.snapshot"
      :app-management-loading="instanceSettingsAppManagement?.loading || false"
      :app-management-error="instanceSettingsAppManagement?.error || ''"
      :refresh-app-management="recoverInstanceAppManagement"
      :manage-app="manageInstanceApp"
      :update-instance="updateInstanceSettings"
    />

  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { useEventListener } from "@vueuse/core";
import { Bot, Download, House, LayoutGrid, LogOut, Maximize2, Minus, RefreshCw, Settings, X } from "@lucide/vue";
import "@xterm/xterm/css/xterm.css";
import { getInstanceAppManagement, installInstanceApp, logoutControlPlane, renameAppSession, resolveAiSessionApproval, uninstallInstanceApp, updateControlledInstance, useAuthSessionQuery, useConfigSyncPresetsQuery, useControlPlaneAiSessionsQuery, useControlPlaneAppSessionsQuery, useControlPlaneStatusQuery, useInstanceBoardQuery, useModelsQuery, useNodesQuery, useServerUpdateCheckQuery } from "../../api/queries";
import { getApiData } from "../../api/client";
import { type AiSessionSummary, type AppManagementOperation, type InstanceBoardItem, type NodeLocalFolder, type UpdateControlledInstanceInput } from "../../api/types";
import { Button } from "../../components/ui/button";
import AiSessionBoardView from "./ai-board/AiSessionBoardView.vue";
import InstanceBoardView from "./board/InstanceBoardView.vue";
import InstanceDetail from "./instance-detail/InstanceDetail.vue";
import InstanceList from "./instance-list/InstanceList.vue";
import InstanceSettingsDialog from "./instance-settings/InstanceSettingsDialog.vue";
import { useInstanceAppManagement } from "./instance-settings/useInstanceAppManagement";
import NewInstanceModal from "./NewInstanceModal.vue";
import SettingsModal from "./settings/SettingsModal.vue";
import { useActiveInstanceSessions } from "./instance-detail/useActiveInstanceSessions";
import { useBoardTerminalPreviews } from "./board/useBoardTerminalPreviews";
import { useInstanceActions } from "./useInstanceActions";
import { useInstanceBoardSessions } from "./board/useInstanceBoardSessions";
import { appDisplayName, buildAppSessionTabs, type SessionTab } from "./useInstanceSessions";
import { isInstanceConnecting } from "./useInstanceStatus";
import { useResizableInstancesSidebar } from "./instance-list/useResizableInstancesSidebar";
import { useWorkbenchInstances } from "./instance-list/useWorkbenchInstances";
import { useAiSessionStore } from "./useAiSessionStore";
import { useAppSessionStore } from "./useAppSessionStore";
import { useControlPlaneEvents } from "./useControlPlaneEvents";
import { useControlPlaneToasts } from "./useControlPlaneToasts";

type ProjectFolderSelection = string | { path: string; ownerNodeId?: string };

type DesktopBridge = {
  chooseProjectFolder?: () => Promise<ProjectFolderSelection | undefined>;
  openAppWindow?: (url: string) => Promise<{ ok: boolean }>;
  windowAction?: (action: "minimize" | "toggle-maximize" | "close") => Promise<{ ok: boolean; maximized?: boolean }>;
};

type BoardSize = "small" | "medium" | "large";
type WorkbenchView = "instance" | "board" | "ai";
const BOARD_SIZE_STORAGE_KEY = "task-handoff.control-plane.board-size";
const SESSION_PREVIEW_EXPANDED_STORAGE_KEY = "task-handoff.control-plane.session-preview-expanded";
const ALL_BOARD_FILTER_VALUE = "__all__";
const BOARD_SIZE_VALUES = new Set<BoardSize>(["small", "medium", "large"]);

function storedBoardSize(): BoardSize {
  const stored = window.localStorage?.getItem(BOARD_SIZE_STORAGE_KEY);
  return BOARD_SIZE_VALUES.has(stored as BoardSize) ? (stored as BoardSize) : "medium";
}

function storedSessionPreviewExpanded() {
  return window.localStorage?.getItem(SESSION_PREVIEW_EXPANDED_STORAGE_KEY) === "true";
}

const queryClient = useQueryClient();
const authSession = useAuthSessionQuery();
const controlPlane = useControlPlaneStatusQuery();
const board = useInstanceBoardQuery();
const models = useModelsQuery();
const controlPlaneAiSessions = useControlPlaneAiSessionsQuery();
const controlPlaneAppSessions = useControlPlaneAppSessionsQuery();
const configSyncPresetsQuery = useConfigSyncPresetsQuery();
const nodes = useNodesQuery();

const workbenchView = ref<WorkbenchView>("instance");
const workbenchViewOptions: Array<{ value: WorkbenchView; label: string; icon: typeof LayoutGrid }> = [
  { value: "instance", label: "Home", icon: House },
  { value: "board", label: "Board", icon: LayoutGrid },
  { value: "ai", label: "AI", icon: Bot },
];
const instanceViewMode = computed(() => workbenchView.value === "instance");
const boardMode = computed(() => workbenchView.value === "board");
const aiBoardMode = computed(() => workbenchView.value === "ai");
const settingsMode = ref(false);
const settingsSection = ref<"basic" | "chat" | "images" | "projects" | "nodes" | "models" | "triggers">("nodes");
const boardFilter = ref("");
const aiBoardFilter = ref("");
const boardProjectFilter = ref(ALL_BOARD_FILTER_VALUE);
const boardStatusFilter = ref(ALL_BOARD_FILTER_VALUE);
const boardBulkAppFilter = ref(ALL_BOARD_FILTER_VALUE);
const boardSize = ref<BoardSize>(storedBoardSize());
const sessionPreviewExpanded = ref(storedSessionPreviewExpanded());
const newInstanceOpen = ref(false);
const instanceSettingsId = ref("");
const instanceSettingsOpen = computed({
  get: () => Boolean(instanceSettingsId.value),
  set: (open: boolean) => {
    if (!open) instanceSettingsId.value = "";
  },
});
const copiedText = ref("");
const { clearToasts, showToast } = useControlPlaneToasts();
const lastRefreshAt = ref(new Date().toISOString());
const appLaunchMenuOpen = ref(false);
const sessionMenuOpen = ref(false);
const openInstanceMenuId = ref("");
const signingOut = ref(false);
const aiApprovalBusyKey = ref("");
const boardSessionKeys = reactive<Record<string, string>>({});
const nodeLocalFoldersByNodeId = reactive<Record<string, NodeLocalFolder[]>>({});
const nodeLocalFolderLoads = reactive<Record<string, boolean>>({});
const desktopBridge = (window as Window & { taskHandoffDesktop?: DesktopBridge }).taskHandoffDesktop;
const serverUpdateNodeId = computed(() => desktopBridge ? "" : nodes.data.value?.find((node) => node.labels["task-handoff.control-plane.builtin"] === "true")?.id || "");
const serverUpdateQuery = useServerUpdateCheckQuery(serverUpdateNodeId);
const serverUpdateAvailable = computed(() => Boolean(serverUpdateQuery.data.value?.supported && serverUpdateQuery.data.value.updateAvailable));
const serverUpdateVersion = computed(() => serverUpdateQuery.data.value?.availableVersion || "");
const hasDesktopWindowControls = Boolean(desktopBridge?.windowAction);
const isMacOS = navigator.platform.toLowerCase().includes("mac");
const showCustomWindowControls = hasDesktopWindowControls && !isMacOS;
const showNativeWindowControlSpace = hasDesktopWindowControls && isMacOS;
const { collapseInstances, expandInstances, instancesCollapsed, startInstanceResize, stopInstanceResize, workbenchStyle } = useResizableInstancesSidebar();
const boardInstances = computed(() => board.data.value || []);
const appSessionStore = useAppSessionStore({
  boardInstances: () => boardInstances.value,
  appSessions: () => controlPlaneAppSessions.data.value,
});
const boardInstancesWithAppSessions = appSessionStore.boardInstancesWithAppSessions;
const aiSessionStore = useAiSessionStore({
  boardInstances: () => boardInstancesWithAppSessions.value,
  aiSessions: () => controlPlaneAiSessions.data.value,
});
const boardInstancesWithAiSessions = aiSessionStore.boardInstancesWithAiSessions;
const instanceSettingsInstance = computed(() => boardInstancesWithAppSessions.value.find((instance) => instance.id === instanceSettingsId.value));
const instanceAppManagement = useInstanceAppManagement({ load: getInstanceAppManagement, errorText });
const instanceSettingsAppManagement = computed(() => instanceSettingsId.value ? instanceAppManagement.state(instanceSettingsId.value) : undefined);
const {
  activeInstance,
  activeInstanceId,
  filteredInstances,
  groupInstancesByNode,
  instanceDisplayName,
  instanceFilter,
  instanceSortMode,
  selectInstance: setActiveInstance,
  sortedInstances,
} = useWorkbenchInstances({
  instances: boardInstancesWithAppSessions,
});
const activeInstanceWithAiSessions = computed(() => aiSessionStore.instanceWithAiSessions(activeInstance.value));
const boardSizeOptions: Array<{ value: BoardSize; label: string }> = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

const boardProjectOptions = computed(() => {
  const byId = new Map<string, { id: string; name: string }>();
  for (const instance of sortedInstances.value) {
    if (!instance.projectId) {
      continue;
    }
    byId.set(instance.projectId, { id: instance.projectId, name: instance.project?.name || instance.projectId });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
});
const boardStatusOptions = computed<string[]>(() => [...new Set(sortedInstances.value.map((instance) => instance.connectionStatus as string))].sort());
const boardVisibleInstances = computed(() => {
  const term = boardFilter.value.trim().toLowerCase();
  return sortedInstances.value.filter((instance) => {
    if (boardProjectFilter.value !== ALL_BOARD_FILTER_VALUE && instance.projectId !== boardProjectFilter.value) {
      return false;
    }
    if (boardStatusFilter.value !== ALL_BOARD_FILTER_VALUE && instance.connectionStatus !== boardStatusFilter.value) {
      return false;
    }
    if (!term) {
      return true;
    }
    const sessionLabels = buildAppSessionTabs(instance)
      .map((session) => session.label)
      .join(" ");
    const haystack = [instance.name, instance.project?.name, instance.projectId, instance.image?.name, instance.imageId, instance.node?.name, instance.nodeId, instance.status, instance.connectionStatus, sessionLabels]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(term);
  });
});
const boardAppOptions = computed(() => {
  const counts = new Map<string, number>();
  for (const instance of boardVisibleInstances.value) {
    const appIds = new Set(buildAppSessionTabs(instance).map((session) => session.label).filter(Boolean));
    for (const appId of appIds) {
      counts.set(appId, (counts.get(appId) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([appId, count]) => ({ appId, count }))
    .sort((a, b) => appDisplayName(a.appId).localeCompare(appDisplayName(b.appId)));
});
const activeNodeLocalFolders = computed(() => activeInstance.value ? nodeLocalFoldersByNodeId[activeInstance.value.nodeId] || [] : []);
const configSyncPresets = computed(() => configSyncPresetsQuery.data.value || []);
const topbarKicker = computed(() => (settingsMode.value ? "Settings" : "TaskHandoff"));
const topbarTitle = computed(() => {
  if (!settingsMode.value) {
    return activeInstance.value?.name || "Control plane";
  }
  return settingsSectionTitle(settingsSection.value);
});
const refreshing = computed(() => board.isFetching.value || controlPlane.isFetching.value);
useControlPlaneEvents({
  aiSessions: aiSessionStore,
  appSessions: appSessionStore,
  isRefreshing: () => refreshing.value,
  refresh,
  appManagement: {
    applyEvent: instanceAppManagement.applyEvent,
    recoverOpen: () => instanceSettingsId.value ? instanceAppManagement.recover(instanceSettingsId.value) : undefined,
  },
});
const lastRefreshLabel = computed(() => new Date(lastRefreshAt.value).toLocaleTimeString());
const connectingInstanceIds = computed(() => sortedInstances.value.filter(isInstanceConnecting).map((instance) => instance.id).join("\n"));
const {
  applyBoardAppSelection,
  boardCardDetail,
  boardCardTitle,
  boardOpenUrl,
  boardPreviewState,
  boardPrimarySession,
  boardSessionFrameUrl,
  boardSessions,
  boardTerminalSocketUrl,
  selectBoardSession,
} = useInstanceBoardSessions({ boardSessionKeys, boardVisibleInstances });
const {
  activeAttachUrl,
  activeInstanceConnecting,
  activeInstanceWebUrl,
  activeOpenUrl,
  activeSession,
  activeSessionFrameUrl,
  activeSessionKey,
  activeTerminalSocketUrl,
  appLaunchButtonLabel,
  appLaunchButtonTitle,
  canLaunchApp,
  launchableApps,
  launchingApp,
  launchSelectedApp,
  moveSessionTab,
  openAiSessionApp,
  orderedSessionTabs,
  selectAiSession,
  selectSession,
  selectedAiSession,
  sessionTabs,
  setAppLaunchMenuOpen,
  setSessionMenuOpen,
  stoppingSessionId,
  stopSelectedAppSession,
} = useActiveInstanceSessions({
  activeInstance: activeInstanceWithAiSessions,
  appLaunchMenuOpen,
  boardSessionKeys,
  closeFloatingLayers,
  errorText,
  notifyError: showToast,
  refresh,
  sessionMenuOpen,
});
const { disposeBoardTerminalPreviews, disposeHiddenBoardTerminalPreviews, mountBoardTerminalPreviews, setBoardTerminalHost } = useBoardTerminalPreviews(boardMode);

let connectingRefreshTimer: ReturnType<typeof setInterval> | undefined;

watch(
  () => activeInstance.value?.id,
  () => {
    closeFloatingLayers();
  },
);

watch(boardProjectFilter, (projectId) => {
  if (projectId !== ALL_BOARD_FILTER_VALUE && !boardProjectOptions.value.some((project) => project.id === projectId)) {
    boardProjectFilter.value = ALL_BOARD_FILTER_VALUE;
  }
});

watch(boardStatusFilter, (status) => {
  if (status !== ALL_BOARD_FILTER_VALUE && !boardStatusOptions.value.includes(status)) {
    boardStatusFilter.value = ALL_BOARD_FILTER_VALUE;
  }
});

watch(
  () => boardAppOptions.value.map((app) => app.appId).join("\n"),
  () => {
    if (boardBulkAppFilter.value !== ALL_BOARD_FILTER_VALUE && !boardAppOptions.value.some((app) => app.appId === boardBulkAppFilter.value)) {
      boardBulkAppFilter.value = ALL_BOARD_FILTER_VALUE;
    }
  },
);

watch(boardBulkAppFilter, (appId) => {
  if (appId === ALL_BOARD_FILTER_VALUE) {
    return;
  }
  applyBoardAppSelection(appId);
});

watch(sessionPreviewExpanded, (expanded) => {
  window.localStorage?.setItem(SESSION_PREVIEW_EXPANDED_STORAGE_KEY, String(expanded));
});

watch(
  () => (boardMode.value ? boardVisibleInstances.value.map((instance) => `${instance.id}:${boardTerminalSocketUrl(instance)}`).join("\n") : ""),
  () => {
    if (!boardMode.value) {
      disposeBoardTerminalPreviews();
      return;
    }
    const visibleIds = new Set(boardVisibleInstances.value.map((instance) => instance.id));
    disposeHiddenBoardTerminalPreviews(visibleIds);
    void mountBoardTerminalPreviews();
  },
  { flush: "post" },
);

watch(
  () => [...new Set(sortedInstances.value.map((instance) => instance.nodeId).filter(Boolean))].sort().join("\n"),
  (value) => {
    for (const nodeId of value.split("\n").filter(Boolean)) {
      void loadNodeLocalFolders(nodeId);
    }
  },
  { immediate: true },
);

async function loadNodeLocalFolders(nodeId: string) {
  if (!nodeId || nodeLocalFolderLoads[nodeId]) {
    return;
  }
  nodeLocalFolderLoads[nodeId] = true;
  try {
    nodeLocalFoldersByNodeId[nodeId] = await getApiData<NodeLocalFolder[]>(`nodes/${nodeId}/local-folders`);
  } catch {
    nodeLocalFoldersByNodeId[nodeId] = [];
  } finally {
    nodeLocalFolderLoads[nodeId] = false;
  }
}

watch(
  connectingInstanceIds,
  (ids) => {
    if (ids && !connectingRefreshTimer) {
      connectingRefreshTimer = setInterval(() => {
        if (!refreshing.value) {
          void refresh();
        }
      }, 2000);
      return;
    }
    if (!ids && connectingRefreshTimer) {
      clearInterval(connectingRefreshTimer);
      connectingRefreshTimer = undefined;
    }
  },
  { immediate: true },
);

useEventListener(window, "click", handleGlobalClick);
useEventListener(window, "keydown", handleGlobalKeydown);

onBeforeUnmount(() => {
  clearToasts();
  if (connectingRefreshTimer) {
    clearInterval(connectingRefreshTimer);
    connectingRefreshTimer = undefined;
  }
  disposeBoardTerminalPreviews();
  stopInstanceResize();
});

function handleGlobalClick() {
  closeFloatingLayers();
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    closeFloatingLayers();
  }
}

function closeFloatingLayers(except?: "instance" | "session" | "app") {
  if (except !== "instance") {
    openInstanceMenuId.value = "";
  }
  if (except !== "session") {
    sessionMenuOpen.value = false;
  }
  if (except !== "app") {
    appLaunchMenuOpen.value = false;
  }
}

function setBoardSize(size: BoardSize) {
  boardSize.value = size;
  window.localStorage?.setItem(BOARD_SIZE_STORAGE_KEY, size);
}

async function refresh() {
  for (const key of Object.keys(nodeLocalFoldersByNodeId)) {
    delete nodeLocalFoldersByNodeId[key];
  }
  const nodeIds = [...new Set(sortedInstances.value.map((instance) => instance.nodeId).filter(Boolean))];
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["control-plane-status"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-projects"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-models"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-images"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-nodes"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-node-runtimes"] }),
    queryClient.refetchQueries({ queryKey: ["instance-board"] }),
    queryClient.refetchQueries({ queryKey: ["control-plane-app-sessions"] }),
    queryClient.refetchQueries({ queryKey: ["control-plane-ai-sessions"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-triggers"] }),
  ]);
  await Promise.all(nodeIds.map((nodeId) => loadNodeLocalFolders(nodeId)));
  lastRefreshAt.value = new Date().toISOString();
}

async function resolveAiSessionApprovalAction(instance: InstanceBoardItem, session: AiSessionSummary, decision: "allow" | "deny" | "skip") {
  const busyKey = `${instance.id}:${session.id}:${decision}`;
  if (aiApprovalBusyKey.value) {
    return;
  }
  aiApprovalBusyKey.value = busyKey;
  try {
    await resolveAiSessionApproval(instance.id, session.id, decision);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["instance-board"] }),
      queryClient.invalidateQueries({ queryKey: ["control-plane-app-sessions"] }),
      queryClient.invalidateQueries({ queryKey: ["control-plane-ai-sessions"] }),
    ]);
  } finally {
    aiApprovalBusyKey.value = "";
  }
}

const {
  activeActionLabel,
  canExportConfig,
  configSyncLabel,
  isConfigSyncBusy,
  isInstanceActionBusy,
  runInstanceAction,
  runRowConfigSync,
  runRowInstanceAction,
  startCreatedInstance,
} = useInstanceActions({
  clearActiveInstance(instanceId) {
    if (activeInstanceId.value === instanceId) {
      activeInstanceId.value = "";
    }
  },
  closeInstanceMenu() {
    openInstanceMenuId.value = "";
  },
  errorText,
  notifyError: showToast,
  refresh,
});

function openSettings(section: typeof settingsSection.value = "nodes") {
  settingsSection.value = section;
  settingsMode.value = true;
  closeFloatingLayers();
}

function toggleSettings() {
  if (settingsMode.value) {
    closeSettings();
    return;
  }
  openSettings();
}

function closeSettings() {
  settingsMode.value = false;
  closeFloatingLayers();
}

function settingsSectionTitle(section: typeof settingsSection.value) {
  if (section === "basic") {
    return "Basic";
  }
  if (section === "images") {
    return "Image management";
  }
  if (section === "nodes") {
    return "Nodes";
  }
  if (section === "models") {
    return "Models";
  }
  if (section === "chat") {
    return "Chat bridges";
  }
  if (section === "triggers") {
    return "Triggers";
  }
  return "Git repositories";
}

function handleInstanceCreated(instance: InstanceBoardItem) {
  activeInstanceId.value = instance.id;
  if (instance.status === "created") {
    void startCreatedInstance(instance.id);
  }
}

async function renameInstance(instance: InstanceBoardItem, name: string) {
  await updateControlledInstance(instance.id, { name });
  await refresh();
}

async function updateInstanceSettings(instance: InstanceBoardItem, input: UpdateControlledInstanceInput) {
  await updateControlledInstance(instance.id, input);
  await refresh();
}

function recoverInstanceAppManagement(instanceId: string) {
  return instanceAppManagement.recover(instanceId);
}

async function manageInstanceApp(instanceId: string, appId: string, operation: AppManagementOperation) {
  const requestId = `appop_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
  const response = operation === "install"
    ? await installInstanceApp(instanceId, appId, requestId)
    : await uninstallInstanceApp(instanceId, appId, requestId);
  instanceAppManagement.applyJob(instanceId, response.job);
}

function openInstanceSettings(instanceId: string) {
  if (!boardInstancesWithAppSessions.value.some((instance) => instance.id === instanceId)) return;
  instanceSettingsId.value = instanceId;
  closeFloatingLayers();
}

async function renameSession(instance: InstanceBoardItem, session: SessionTab, title: string) {
  const sessionId = typeof session.source?.id === "string" ? session.source.id : session.key;
  await renameAppSession(instance.id, sessionId, title);
  await queryClient.refetchQueries({ queryKey: ["control-plane-app-sessions"] });
}

async function controlWindow(action: "minimize" | "toggle-maximize" | "close") {
  await desktopBridge?.windowAction?.(action);
}

async function openAppUrl(url: string) {
  if (desktopBridge?.openAppWindow) {
    await desktopBridge.openAppWindow(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function selectInstance(id: string) {
  setActiveInstance(id);
  closeFloatingLayers();
}

function openAiSessionAppFromBoard(instance: InstanceBoardItem, session?: AiSessionSummary) {
  setActiveInstance(instance.id);
  openAiSessionApp(instance, session);
  workbenchView.value = "instance";
  closeFloatingLayers();
}

function setWorkbenchView(view: WorkbenchView) {
  workbenchView.value = view;
  settingsMode.value = false;
  closeFloatingLayers();
}

async function signOut() {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await logoutControlPlane();
    queryClient.clear();
    await queryClient.invalidateQueries({ queryKey: ["auth-session"] });
  } finally {
    signingOut.value = false;
  }
}

function setInstanceMenuOpen(id: string, open: boolean) {
  if (open) {
    closeFloatingLayers("instance");
    openInstanceMenuId.value = id;
    return;
  }
  if (openInstanceMenuId.value === id) {
    openInstanceMenuId.value = "";
  }
}

async function copyRegistration(instance: InstanceBoardItem) {
  await copyText(instance.id);
}

async function copyText(value: string) {
  await navigator.clipboard?.writeText(value);
  copiedText.value = value;
  setTimeout(() => {
    if (copiedText.value === value) {
      copiedText.value = "";
    }
  }, 1600);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
</script>

<style scoped src="./ControlPlaneWorkbench.css"></style>
