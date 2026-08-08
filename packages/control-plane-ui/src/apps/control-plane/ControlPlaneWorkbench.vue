<template>
  <div class="control-plane-shell">
    <header class="control-plane-topbar" @dblclick="controlWindow('toggle-maximize')">
      <div class="topbar-left">
        <div
          v-if="showCustomWindowControls"
          class="desktop-window-controls"
          :aria-label="t('navigation.windowControls')"
        >
          <button type="button" class="window-control close" :aria-label="t('common.actions.close')" :title="t('common.actions.close')" @click.stop="controlWindow('close')">
            <X :size="11" />
          </button>
          <button type="button" class="window-control minimize" :aria-label="t('common.actions.minimize')" :title="t('common.actions.minimize')" @click.stop="controlWindow('minimize')">
            <Minus :size="11" />
          </button>
          <button type="button" class="window-control maximize" :aria-label="t('common.actions.maximize')" :title="t('common.actions.maximize')" @click.stop="controlWindow('toggle-maximize')">
            <Maximize2 :size="10" />
          </button>
        </div>
        <div
          v-else-if="showNativeWindowControlSpace"
          class="desktop-window-controls native-window-control-space macos-native-window-control-space"
          aria-hidden="true"
        />
        <div v-if="settingsMode" class="control-plane-title">
          <span class="control-plane-kicker">{{ topbarKicker }}</span>
          <strong>{{ topbarTitle }}</strong>
        </div>
        <div v-else class="control-plane-title control-plane-instance-switcher-shell">
          <span class="control-plane-kicker">{{ topbarKicker }}</span>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button
                type="button"
                class="control-plane-instance-switcher"
                :aria-label="t('instances.list.switchInstance')"
                @dblclick.stop
              >
              <span class="control-plane-instance-switcher-title">
                <strong>{{ topbarTitle }}</strong>
                <small v-if="topbarNodeName" class="control-plane-instance-node-name" :title="topbarNodeName">· {{ topbarNodeName }}</small>
                <ChevronDown class="control-plane-instance-switcher-chevron" :size="16" aria-hidden="true" />
              </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent class="control-plane-instance-menu" align="start" :collision-padding="12" :side-offset="8">
            <ScrollArea
              class="control-plane-instance-menu-scroll"
              :horizontal="false"
              :style="{ '--instance-menu-height': `${Math.max(sortedInstances.length, 1) * 52 - 2}px` }"
            >
              <div class="control-plane-instance-menu-list">
                <DropdownMenuItem
                  v-for="instance in sortedInstances"
                  :key="instance.id"
                  class="control-plane-instance-menu-item"
                  :class="{ selected: instance.id === activeInstance?.id }"
                  :aria-current="instance.id === activeInstance?.id ? 'true' : undefined"
                  @select="selectInstance(instance.id)"
                >
                  <span class="status-dot" :data-state="instance.connectionStatus" />
                  <span class="control-plane-instance-menu-copy">
                    <strong>{{ instanceDisplayName(instance) }}</strong>
                    <small>{{ instance.node?.name || instance.nodeId }}</small>
                  </span>
                  <Check v-if="instance.id === activeInstance?.id" class="control-plane-instance-menu-check" :size="16" aria-hidden="true" />
                </DropdownMenuItem>
                <DropdownMenuItem v-if="!sortedInstances.length" class="control-plane-instance-menu-item" disabled>
                  {{ t("instances.list.noMatches") }}
                </DropdownMenuItem>
              </div>
            </ScrollArea>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div class="control-plane-actions">
        <TooltipProvider v-if="serverUpdateAvailable" :delay-duration="120">
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="outline"
                size="sm"
                class="control-plane-update-indicator"
                :aria-label="t('settings.appearance.updateAvailableVersion', { version: serverUpdateVersion })"
                @click="openSettings('basic')"
              >
                <Download :size="15" />
                <span>{{ t("common.actions.update") }}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" :side-offset="8">{{ t("settings.appearance.updateAvailableVersion", { version: serverUpdateVersion }) }}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div class="workbench-view-switcher" :data-active-view="workbenchView" :aria-label="t('navigation.workbenchView')">
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
        <Button variant="outline" size="sm" :aria-label="t('common.actions.refresh')" :title="t('common.actions.refresh')" :disabled="refreshing" @click="refresh">
          <RefreshCw :size="15" />
          <span>{{ t("common.actions.refresh") }}</span>
        </Button>
        <Button :variant="settingsMode ? 'default' : 'outline'" size="sm" :aria-label="t('navigation.settings')" :title="t('navigation.settings')" :aria-pressed="settingsMode" @click="toggleSettings">
          <Settings :size="15" />
          <span>{{ t("navigation.settings") }}</span>
        </Button>
        <Button v-if="authSession.data.value?.enabled" variant="outline" size="sm" :aria-label="t('auth.signOut')" :title="t('auth.signOut')" :disabled="signingOut" @click="signOut">
          <LogOut :size="15" />
          <span>{{ signingOut ? t("auth.signingOut") : t("auth.signOut") }}</span>
        </Button>
        <div
          v-if="showWindowsNativeWindowControlSpace"
          class="desktop-window-controls native-window-control-space windows-native-window-control-space"
          aria-hidden="true"
        />
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
        :error="board.error.value ? errorText(board.error.value) : ''"
        v-model:group-by-node="groupInstancesByNode"
        :instance-display-name="instanceDisplayName"
        :instances="filteredInstances"
        :is-instance-action-busy="isInstanceActionBusy"
        :loading="board.isLoading.value"
        :open-menu-id="openInstanceMenuId"
        v-model:sort-mode="instanceSortMode"
        :total-instances="sortedInstances.length"
        @collapse="collapseInstances"
        @expand="expandInstances"
        @new-instance="newInstanceOpen = true"
        @open-settings="openInstanceSettings"
        @save-template="openSaveEnvironmentTemplate"
        @resize-start="startInstanceResize"
        @run-action="runRowInstanceAction"
        @open-config-sync="openConfigSync"
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
        :interactive="boardInteractive"
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
        @update:interactive="boardInteractive = $event"
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
        :class="{ 'preview-expanded': sessionPreviewExpanded }"
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
        :instance-display-name="instanceDisplayName"
        :is-instance-action-busy="isInstanceActionBusy"
        :last-refresh-label="lastRefreshLabel"
        :left-session="leftSession"
        :left-session-key="leftSessionKey"
        :left-session-tabs="leftOrderedSessionTabs"
        :launchable-apps="launchableApps"
        :launching-app="launchingApp"
        :loading="board.isLoading.value"
        :resource-metrics="activeInstanceResourceMetrics"
        :resource-metrics-error="activeInstanceResourceMetricsError"
        :right-session="rightSession"
        :right-session-key="rightSessionKey"
        :right-session-tabs="rightOrderedSessionTabs"
        :focused-session-pane="focusedSessionPane"
        :has-session-split="hasSessionSplit"
        :session-split-ratio="sessionSplitRatio"
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
        @open-repository-workspace="openRepositoryWorkspace"
        @open-settings="openInstanceSettings"
        @open-url="openAppUrl"
        @move-session-tab="moveSessionTab"
        @move-session-to-pane="moveSessionToPane"
        @focus-session-pane="focusSessionPane"
        @open-session-split="openSessionSplit"
        @close-session-split="closeSessionSplit"
        @set-session-split-ratio="setSessionSplitRatio"
        @run-action="runInstanceAction"
        @select-ai-session="selectAiSession"
        @select-session="selectSession"
        @stop-session="stopSelectedAppSession"
      />
    </main>

    <NewInstanceModal v-if="newInstanceOpen" :choose-project-folder="desktopBridge?.chooseProjectFolder" @close="newInstanceOpen = false" @created="handleInstanceCreated" />

    <ConfigSyncDialog
      v-model:open="configSyncDialogOpen"
      :direction="configSyncDirection"
      :instance="configSyncInstance"
      @completed="refresh"
    />

    <InstanceDeleteDialog
      :open="Boolean(deleteDialogInstance)"
      :instance="deleteDialogInstance"
      :submitting="Boolean(deleteDialogInstance && isInstanceActionBusy(deleteDialogInstance))"
      :result="deleteResult"
      :error="deleteError"
      @update:open="(open) => { if (!open) closeDeleteDialog() }"
      @confirm="confirmDeleteInstance"
    />

    <SaveEnvironmentTemplateDialog
      :open="Boolean(saveTemplateInstance)"
      :instance="saveTemplateInstance"
      :submitting="savingEnvironmentTemplate"
      :error="saveTemplateError"
      @update:open="(open) => { if (!open) closeSaveEnvironmentTemplate() }"
      @confirm="confirmSaveEnvironmentTemplate"
    />

    <InstanceSettingsDialog
      v-model:open="instanceSettingsOpen"
      :initial-section="instanceSettingsSection"
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
import { useI18n } from "vue-i18n";
import { formatTime } from "../../i18n/presentation";
import type { SupportedLocale } from "../../i18n/locale";
import { translateApiError } from "../../i18n/apiError";
import { useQueries, useQueryClient } from "@tanstack/vue-query";
import { useEventListener } from "@vueuse/core";
import { Bot, Check, ChevronDown, Download, House, LayoutGrid, LogOut, Maximize2, Minus, RefreshCw, Settings, X } from "@lucide/vue";
import "@xterm/xterm/css/xterm.css";
import { controlPlaneQueryKeys, getInstanceAppManagement, getInstanceResourceMetrics, installInstanceApp, logoutControlPlane, nodeLocalFoldersQueryOptions, renameAppSession, resolveAiSessionApproval, saveEnvironmentTemplate, uninstallInstanceApp, updateControlledInstance, useAuthSessionQuery, useControlPlaneAiSessionsQuery, useControlPlaneAppSessionsQuery, useControlPlaneStatusQuery, useInstanceBoardQuery, useModelsQuery, useNodesQuery, useServerUpdateCheckQuery } from "../../api/queries";
import type { ConfigSyncDirection } from "@task-handoff/protocol/config-sync";
import { type AiSessionSummary, type AppManagementOperation, type InstanceBoardItem, type InstanceBoardItemWithAppSessions, type InstanceResourceMetrics, type NodeLocalFolder, type UpdateControlledInstanceInput } from "../../api/types";
import { Button } from "../../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip";
import AiSessionBoardView from "./ai-board/AiSessionBoardView.vue";
import InstanceBoardView from "./board/InstanceBoardView.vue";
import InstanceDetail from "./instance-detail/InstanceDetail.vue";
import InstanceList from "./instance-list/InstanceList.vue";
import ConfigSyncDialog from "./instance-list/ConfigSyncDialog.vue";
import InstanceDeleteDialog from "./instance-list/InstanceDeleteDialog.vue";
import SaveEnvironmentTemplateDialog from "./instance-list/SaveEnvironmentTemplateDialog.vue";
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
import { useImagePullProgress } from "./useImagePullProgress";

type ProjectFolderSelection = string | { path: string; ownerNodeId?: string };

type DesktopBridge = {
  chooseProjectFolder?: () => Promise<ProjectFolderSelection | undefined>;
  openAppWindow?: (url: string) => Promise<{ ok: boolean }>;
  openControlPlaneWindow?: (url: string) => Promise<{ ok: boolean }>;
  windowChrome?: { mode: "custom" | "macos-overlay" | "windows-overlay" };
  windowAction?: (action: "minimize" | "toggle-maximize" | "close") => Promise<{ ok: boolean; maximized?: boolean }>;
};

type BoardSize = "small" | "medium" | "large";
type WorkbenchView = "instance" | "board" | "ai";
const BOARD_SIZE_STORAGE_KEY = "task-handoff.control-plane.board-size";
const BOARD_INTERACTIVE_STORAGE_KEY = "task-handoff.control-plane.board-interactive";
const SESSION_PREVIEW_EXPANDED_STORAGE_KEY = "task-handoff.control-plane.session-preview-expanded";
const ALL_BOARD_FILTER_VALUE = "__all__";
const BOARD_SIZE_VALUES = new Set<BoardSize>(["small", "medium", "large"]);

function storedBoardSize(): BoardSize {
  const stored = window.localStorage?.getItem(BOARD_SIZE_STORAGE_KEY);
  return BOARD_SIZE_VALUES.has(stored as BoardSize) ? (stored as BoardSize) : "medium";
}

function storedBoardInteractive() {
  return window.localStorage?.getItem(BOARD_INTERACTIVE_STORAGE_KEY) === "true";
}

function storedSessionPreviewExpanded() {
  return window.localStorage?.getItem(SESSION_PREVIEW_EXPANDED_STORAGE_KEY) === "true";
}

const queryClient = useQueryClient();
const { locale, t } = useI18n();
const authSession = useAuthSessionQuery();
const controlPlane = useControlPlaneStatusQuery();
const board = useInstanceBoardQuery();
const models = useModelsQuery();
const controlPlaneAiSessions = useControlPlaneAiSessionsQuery();
const controlPlaneAppSessions = useControlPlaneAppSessionsQuery();
const nodes = useNodesQuery();

const workbenchView = ref<WorkbenchView>("instance");
const workbenchViewOptions = computed<Array<{ value: WorkbenchView; label: string; icon: typeof LayoutGrid }>>(() => [
  { value: "instance", label: t("navigation.home"), icon: House },
  { value: "board", label: t("navigation.board"), icon: LayoutGrid },
  { value: "ai", label: t("navigation.ai"), icon: Bot },
]);
const instanceViewMode = computed(() => workbenchView.value === "instance");
const boardMode = computed(() => workbenchView.value === "board");
const aiBoardMode = computed(() => workbenchView.value === "ai");
const settingsMode = ref(false);
const settingsSection = ref<"basic" | "chat" | "images" | "environment-templates" | "projects" | "nodes" | "models" | "triggers" | "mobile-sessions">("nodes");
const boardFilter = ref("");
const aiBoardFilter = ref("");
const boardProjectFilter = ref(ALL_BOARD_FILTER_VALUE);
const boardStatusFilter = ref(ALL_BOARD_FILTER_VALUE);
const boardBulkAppFilter = ref(ALL_BOARD_FILTER_VALUE);
const boardSize = ref<BoardSize>(storedBoardSize());
const boardInteractive = ref(storedBoardInteractive());
const sessionPreviewExpanded = ref(storedSessionPreviewExpanded());
const newInstanceOpen = ref(false);
const saveTemplateInstance = ref<InstanceBoardItem>();
const savingEnvironmentTemplate = ref(false);
const saveTemplateError = ref("");
const configSyncInstanceId = ref("");
const configSyncDirection = ref<ConfigSyncDirection>("import");
const configSyncDialogOpen = computed({
  get: () => Boolean(configSyncInstanceId.value),
  set: (open: boolean) => {
    if (!open) configSyncInstanceId.value = "";
  },
});
const instanceSettingsId = ref("");
const instanceSettingsSection = ref<"general" | "models" | "apps">("general");
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
const desktopBridge = (window as Window & { taskHandoffDesktop?: DesktopBridge }).taskHandoffDesktop;
const serverUpdateNodeId = computed(() => desktopBridge ? "" : nodes.data.value?.find((node) => node.labels["task-handoff.control-plane.builtin"] === "true")?.id || "");
const serverUpdateQuery = useServerUpdateCheckQuery(serverUpdateNodeId);
const serverUpdateAvailable = computed(() => Boolean(serverUpdateQuery.data.value?.supported && serverUpdateQuery.data.value.updateAvailable));
const serverUpdateVersion = computed(() => serverUpdateQuery.data.value?.availableVersion || "");
const hasDesktopWindowControls = Boolean(desktopBridge?.windowAction);
const windowChromeMode = desktopBridge?.windowChrome?.mode;
const showCustomWindowControls = hasDesktopWindowControls && windowChromeMode === "custom";
const showNativeWindowControlSpace = hasDesktopWindowControls && windowChromeMode === "macos-overlay";
const showWindowsNativeWindowControlSpace = hasDesktopWindowControls && windowChromeMode === "windows-overlay";
const { collapseInstances, expandInstances, instancesCollapsed, startInstanceResize, stopInstanceResize, workbenchStyle } = useResizableInstancesSidebar();
const imagePullProgress = useImagePullProgress();
const boardInstances = computed(() => (board.data.value || []).map((instance) => {
  const progress = imagePullProgress.state(instance.id);
  return progress && progress.generation === instance.imageProvisioning?.generation
    ? { ...instance, imagePullProgress: progress }
    : instance;
}));
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
const nodeLocalFolderNodeIds = computed(() => [...new Set(sortedInstances.value.map((instance) => instance.nodeId).filter(Boolean))].sort());
const nodeLocalFolderQueries = useQueries({
  queries: () => nodeLocalFolderNodeIds.value.map(nodeLocalFoldersQueryOptions),
});
const nodeLocalFoldersByNodeId = computed<Record<string, NodeLocalFolder[]>>(() => Object.fromEntries(
  nodeLocalFolderQueries.value.map((query, index) => [nodeLocalFolderNodeIds.value[index], query.data || []]),
));
const activeInstanceWithAiSessions = computed(() => aiSessionStore.instanceWithAiSessions(activeInstance.value));
const resourceMetricsByInstanceId = reactive<Record<string, InstanceResourceMetrics>>({});
const resourceMetricsErrorByInstanceId = reactive<Record<string, string>>({});
const activeInstanceResourceMetrics = computed(() => activeInstance.value?.runtime?.type === "docker" ? resourceMetricsByInstanceId[activeInstance.value.id] : undefined);
const activeInstanceResourceMetricsError = computed(() => activeInstance.value?.runtime?.type === "docker" ? resourceMetricsErrorByInstanceId[activeInstance.value.id] : undefined);
const boardSizeOptions = computed<Array<{ value: BoardSize; label: string }>>(() => [
  { value: "small", label: t("instances.board.small") },
  { value: "medium", label: t("instances.board.medium") },
  { value: "large", label: t("instances.board.large") },
]);

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
    const sessionLabels = buildAppSessionTabs(instance, t)
      .map((session) => session.label)
      .join(" ");
    const haystack = [instance.name, instance.project?.name, instance.projectId, instance.image?.name, instance.imageSelection?.imageId, instance.node?.name, instance.nodeId, instance.status, instance.connectionStatus, sessionLabels]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(term);
  });
});
const boardAppOptions = computed(() => {
  const counts = new Map<string, number>();
  for (const instance of boardVisibleInstances.value) {
    const appIds = new Set(buildAppSessionTabs(instance, t).map((session) => session.label).filter(Boolean));
    for (const appId of appIds) {
      counts.set(appId, (counts.get(appId) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([appId, count]) => ({ appId, count }))
    .sort((a, b) => appDisplayName(a.appId, t).localeCompare(appDisplayName(b.appId, t)));
});
const activeNodeLocalFolders = computed(() => activeInstance.value ? nodeLocalFoldersByNodeId.value[activeInstance.value.nodeId] || [] : []);
const configSyncInstance = computed(() => sortedInstances.value.find((instance) => instance.id === configSyncInstanceId.value));
const topbarKicker = computed(() => (settingsMode.value ? t("navigation.settings") : t("common.productName")));
const topbarTitle = computed(() => {
  if (!settingsMode.value) {
    return activeInstance.value?.name || t("navigation.controlPlane");
  }
  return settingsSectionTitle(settingsSection.value);
});
const topbarNodeName = computed(() => activeInstance.value?.node?.name || "");
const refreshing = computed(() => board.isFetching.value || controlPlane.isFetching.value);
useControlPlaneEvents({
  aiSessions: aiSessionStore,
  appSessions: appSessionStore,
  appManagement: {
    applyEvent: instanceAppManagement.applyEvent,
    recoverOpen: () => instanceSettingsId.value ? instanceAppManagement.recover(instanceSettingsId.value) : undefined,
  },
  resourceMetrics: {
    applyEvent(metrics) {
      if (!metrics.instanceId) return false;
      resourceMetricsByInstanceId[metrics.instanceId] = metrics;
      delete resourceMetricsErrorByInstanceId[metrics.instanceId];
      return true;
    },
    recoverOpen: loadActiveInstanceResourceMetrics,
  },
  imagePullProgress,
});
const lastRefreshLabel = computed(() => formatTime(lastRefreshAt.value, locale.value as SupportedLocale));
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
} = useInstanceBoardSessions({ boardInteractive, boardSessionKeys, boardVisibleInstances, locale, t });
const {
  activeAttachUrl,
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
  leftOrderedSessionTabs,
  leftSession,
  leftSessionKey,
  moveSessionTab,
  moveSessionToPane,
  openAiSessionApp,
  openSessionSplit,
  openRepositoryWorkspace,
  orderedSessionTabs,
  closeSessionSplit,
  focusSessionPane,
  focusedSessionPane,
  hasSessionSplit,
  rightOrderedSessionTabs,
  rightSession,
  rightSessionKey,
  selectAiSession,
  selectSession,
  selectedAiSession,
  sessionTabs,
  sessionSplitRatio,
  setSessionSplitRatio,
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
  t,
});
const { disposeBoardTerminalPreviews, disposeHiddenBoardTerminalPreviews, mountBoardTerminalPreviews, setBoardTerminalHost } = useBoardTerminalPreviews(boardMode, boardInteractive);

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

watch(boardInteractive, (interactive) => {
  window.localStorage?.setItem(BOARD_INTERACTIVE_STORAGE_KEY, String(interactive));
});

watch(
  () => (boardMode.value ? `${boardInteractive.value}\n${boardVisibleInstances.value.map((instance) => `${instance.id}:${boardTerminalSocketUrl(instance)}`).join("\n")}` : ""),
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

const resourceMetricsLoads = new Map<string, Promise<void>>();

watch(
  () => [
    activeInstanceId.value,
    activeInstance.value?.runtime?.type,
    activeInstance.value?.runtime?.containerId,
    activeInstance.value?.runtime?.containerName,
  ] as const,
  () => void loadActiveInstanceResourceMetrics(),
  { immediate: true },
);

watch(boardInstancesWithAppSessions, (instances) => {
  const currentIds = new Set(instances.map((instance) => instance.id));
  for (const instanceId of Object.keys(resourceMetricsByInstanceId)) {
    if (!currentIds.has(instanceId)) delete resourceMetricsByInstanceId[instanceId];
  }
  for (const instanceId of Object.keys(resourceMetricsErrorByInstanceId)) {
    if (!currentIds.has(instanceId)) delete resourceMetricsErrorByInstanceId[instanceId];
  }
});

async function loadActiveInstanceResourceMetrics() {
  const instance = activeInstance.value;
  if (!instance || instance.runtime?.type !== "docker") return;
  const requestedId = instance.id;
  const currentLoad = resourceMetricsLoads.get(requestedId);
  if (currentLoad) return currentLoad;
  const load = (async () => {
    try {
      const metrics = await getInstanceResourceMetrics(requestedId);
      if (activeInstanceId.value === requestedId) {
        resourceMetricsByInstanceId[requestedId] = metrics;
        delete resourceMetricsErrorByInstanceId[requestedId];
      }
    } catch (error) {
      if (activeInstanceId.value === requestedId && !resourceMetricsByInstanceId[requestedId]) {
        resourceMetricsErrorByInstanceId[requestedId] = errorText(error);
      }
    } finally {
      resourceMetricsLoads.delete(requestedId);
    }
  })();
  resourceMetricsLoads.set(requestedId, load);
  return load;
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
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["control-plane-status"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-projects"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-models"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-images"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-nodes"] }),
    queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.nodeLocalFolders() }),
    queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.nodeRuntimes }),
    queryClient.refetchQueries({ queryKey: controlPlaneQueryKeys.instanceBoard }),
    queryClient.refetchQueries({ queryKey: ["control-plane-app-sessions"] }),
    queryClient.refetchQueries({ queryKey: ["control-plane-ai-sessions"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-triggers"] }),
  ]);
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
      queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.instanceBoard }),
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
  closeDeleteDialog,
  confirmDeleteInstance,
  deleteDialogInstance,
  deleteError,
  deleteResult,
  isInstanceActionBusy,
  runInstanceAction,
  runRowInstanceAction,
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
  translate: t,
});

function openSaveEnvironmentTemplate(instance: InstanceBoardItem) {
  openInstanceMenuId.value = "";
  saveTemplateError.value = "";
  saveTemplateInstance.value = instance;
}

function closeSaveEnvironmentTemplate() {
  if (savingEnvironmentTemplate.value) return;
  saveTemplateInstance.value = undefined;
  saveTemplateError.value = "";
}

async function confirmSaveEnvironmentTemplate(name: string) {
  const instance = saveTemplateInstance.value;
  if (!instance || savingEnvironmentTemplate.value) return;
  savingEnvironmentTemplate.value = true;
  saveTemplateError.value = "";
  try {
    await saveEnvironmentTemplate(instance.id, name);
    await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.environmentTemplates(instance.nodeId) });
    showToast(t("instances.environmentTemplateDialog.saved", { name }));
    saveTemplateInstance.value = undefined;
  } catch (error) {
    saveTemplateError.value = errorText(error);
  } finally {
    savingEnvironmentTemplate.value = false;
  }
}

function openConfigSync(direction: ConfigSyncDirection, instance: InstanceBoardItem) {
  configSyncDirection.value = direction;
  configSyncInstanceId.value = instance.id;
  openInstanceMenuId.value = "";
}

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
    return t("settings.basic");
  }
  if (section === "images") {
    return t("settings.images");
  }
  if (section === "environment-templates") {
    return t("settings.environmentTemplates");
  }
  if (section === "nodes") {
    return t("settings.nodes");
  }
  if (section === "models") {
    return t("settings.models");
  }
  if (section === "chat") {
    return t("settings.chatBridges");
  }
  if (section === "triggers") {
    return t("triggers.title");
  }
  if (section === "mobile-sessions") {
    return t("settings.mobileSessions.navigation");
  }
  return t("settings.projects");
}

function handleInstanceCreated(instance: InstanceBoardItem) {
  activeInstanceId.value = instance.id;
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

function openInstanceSettings(instanceId: string, section: "general" | "models" | "apps" = "general") {
  if (!boardInstancesWithAppSessions.value.some((instance) => instance.id === instanceId)) return;
  instanceSettingsSection.value = section;
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

function openAiSessionAppFromBoard(instance: InstanceBoardItemWithAppSessions, session?: AiSessionSummary) {
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
  return translateApiError(error, t);
}
</script>

<style scoped src="./ControlPlaneWorkbench.css"></style>
