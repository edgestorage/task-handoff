<template>
  <div class="control-plane-shell" :class="{ 'standalone-instance-detail': standaloneMode }">
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
          <span v-if="!standaloneMode" class="control-plane-kicker">{{ topbarKicker }}</span>
          <DropdownMenu :open="instanceSwitcherOpen" @update:open="updateInstanceSwitcherOpen">
            <DropdownMenuTrigger as-child>
              <button
                ref="instanceSwitcherElement"
                type="button"
                class="control-plane-instance-switcher"
                :data-overflow="instanceSwitcherOverflow ? 'true' : undefined"
                :aria-label="t('instances.list.switchInstance')"
                @pointerdown.capture="startInstanceSwitcherPointer"
                @pointermove="moveInstanceSwitcherPointer"
                @pointerup="finishInstanceSwitcherPointer"
                @pointercancel="cancelInstanceSwitcherPointer"
                @click.capture="consumeInstanceSwitcherClick"
                @dblclick.stop
              >
              <span ref="instanceSwitcherTitleElement" class="control-plane-instance-switcher-title">
                <span v-if="standaloneMode" class="control-plane-instance-switcher-icon" aria-hidden="true">
                  <Laptop v-if="topbarRuntimeType === 'local'" :size="14" />
                  <Container v-else-if="topbarRuntimeType === 'docker'" :size="14" />
                  <Boxes v-else :size="14" />
                </span>
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
              :style="{ '--instance-menu-height': `${Math.max(switcherInstances.length, 1) * 52 - 2}px` }"
            >
              <div class="control-plane-instance-menu-list">
                <DropdownMenuItem
                  v-for="instance in switcherInstances"
                  :key="instance.id"
                  class="control-plane-instance-menu-item"
                  :class="{ selected: instance.id === selectedInstanceId }"
                  :aria-current="instance.id === selectedInstanceId ? 'true' : undefined"
                  @select="selectInstance(instance.id)"
                >
                  <span class="status-dot" :data-state="instance.connectionStatus" />
                  <span class="control-plane-instance-menu-copy">
                    <strong>{{ switcherInstanceName(instance) }}</strong>
                    <small>{{ switcherNodeName(instance) }}</small>
                  </span>
                  <Check v-if="instance.id === selectedInstanceId" class="control-plane-instance-menu-check" :size="16" aria-hidden="true" />
                </DropdownMenuItem>
                <DropdownMenuItem v-if="!switcherInstances.length" class="control-plane-instance-menu-item" disabled>
                  {{ t("instances.list.noMatches") }}
                </DropdownMenuItem>
              </div>
            </ScrollArea>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <span v-if="standaloneMode && sessionPreviewExpanded && !hasSessionSplit" class="instance-detail-titlebar-divider" aria-hidden="true" />
        <div v-if="standaloneMode" id="instance-detail-titlebar-tabs" class="instance-detail-titlebar-tabs" />
      </div>
      <div v-if="!standaloneMode" class="control-plane-actions">
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
      <div
        v-else-if="showWindowsNativeWindowControlSpace"
        class="desktop-window-controls native-window-control-space windows-native-window-control-space"
        aria-hidden="true"
      />
    </header>

    <main class="control-plane-workbench" :class="{ 'instances-collapsed': instancesCollapsed, 'instances-sidebar-hidden': !instancesSidebarVisible, 'board-mode': !instanceViewMode || settingsMode, 'standalone-detail-mode': standaloneMode }" :style="standaloneMode ? undefined : workbenchStyle">
      <InstanceList
        v-if="!standaloneMode && instanceViewMode && !settingsMode && instancesSidebarVisible"
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
        :nodes="nodes.data.value || []"
        :open-menu-id="openInstanceMenuId"
        v-model:sort-mode="instanceSortMode"
        :total-instances="sortedInstances.length"
        @collapse="collapseInstances"
        @expand="expandInstances"
        @new-instance="newInstanceOpen = true"
        @open-settings="openInstanceSettings"
        @open-window="openInstanceWindow"
        @save-template="openSaveEnvironmentTemplate"
        @resize-start="startInstanceResize"
        @run-action="runRowInstanceAction"
        @open-config-sync="openConfigSync"
        @select-instance="selectInstance"
        @set-menu-open="setInstanceMenuOpen"
      />

      <InstanceBoardView
        v-if="!standaloneMode && boardMode && !settingsMode"
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
        :board-ai-sessions="boardAiSessions"
        :board-preview-state="boardPreviewState"
        :board-primary-ai-session="boardPrimaryAiSession"
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
        @open-window="openInstanceWindow"
        @launch-app="launchSelectedApp"
        @run-action="runInstanceAction"
        @select-board-session="selectBoardSession"
        @step-board-ai-session="stepBoardAiSession"
        @select-instance="selectInstance"
        @set-size="setBoardSize"
        @update:interactive="boardInteractive = $event"
      />

      <AiSessionBoardView
        v-if="!standaloneMode && aiBoardMode && !settingsMode"
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
        v-if="!standaloneMode && settingsMode"
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
        :choose-project-folder="activeProjectFolderChooser"
        :error="standaloneDetailError || (board.error.value ? errorText(board.error.value) : '')"
        :instance="standaloneOwnershipReady ? activeInstanceWithAiSessions : undefined"
        :instance-display-name="instanceDisplayName"
        :instance-sidebar-visible="instancesSidebarVisible"
        :is-instance-action-busy="isInstanceActionBusy"
        :last-refresh-label="lastRefreshLabel"
        :left-session="leftSession"
        :left-session-key="leftSessionKey"
        :left-session-tabs="leftOrderedSessionTabs"
        :launchable-apps="launchableApps"
        :launching-app="launchingApp"
        :loading="board.isLoading.value || (standaloneMode && !standaloneOwnershipResolved)"
        :standalone="standaloneMode"
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
        :session-toolbar-target="standaloneMode && sessionPreviewExpanded && !hasSessionSplit ? '#instance-detail-titlebar-tabs' : undefined"
        @copy-registration="copyRegistration"
        @launch-app="launchSelectedApp"
        @new-instance="newInstanceOpen = true"
        @open-ai-session-app="openAiSessionApp"
        @open-repository-workspace="openRepositoryWorkspace"
        @open-settings="openInstanceSettings"
        @open-window="openInstanceWindow"
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
        @update:instance-sidebar-visible="setInstancesSidebarVisible"
      />
    </main>

    <Transition name="workbench-loading">
      <div
        v-if="workbenchLoadingOverlayVisible"
        class="workbench-loading-overlay"
        role="status"
        aria-live="polite"
      >
        <span class="workbench-loading-indicator">
          <LoaderCircle :size="17" aria-hidden="true" />
          {{ t(standaloneMode ? "instances.detail.loading" : "instances.list.loading") }}
        </span>
      </div>
    </Transition>

    <NewInstanceModal v-if="!standaloneMode && newInstanceOpen" :choose-project-folder="desktopBridge?.chooseProjectFolder" @close="newInstanceOpen = false" @created="handleInstanceCreated" />

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
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { formatTime } from "../../i18n/presentation";
import type { SupportedLocale } from "../../i18n/locale";
import { translateApiError } from "../../i18n/apiError";
import { useQueries, useQueryClient } from "@tanstack/vue-query";
import { useEventListener } from "@vueuse/core";
import { Bot, Boxes, Check, ChevronDown, Container, Download, House, Laptop, LayoutGrid, LoaderCircle, LogOut, Maximize2, Minus, RefreshCw, Settings, X } from "@lucide/vue";
import "@xterm/xterm/css/xterm.css";
import { controlPlaneQueryKeys, getInstanceAppManagement, getInstanceResourceMetrics, installInstanceApp, instanceBoardQueryOptions, logoutControlPlane, nodeLocalFoldersQueryOptions, renameAppSession, resolveAiSessionApproval, saveEnvironmentTemplate, uninstallInstanceApp, updateControlledInstance, useAuthSessionQuery, useControlPlaneAiSessionsQuery, useControlPlaneAppSessionsQuery, useControlPlaneStatusQuery, useInstanceBoardQuery, useInstanceDirectoryQuery, useModelsQuery, useNodesQuery, useServerUpdateCheckQuery } from "../../api/queries";
import type { ControlPlaneInstanceResourceEntry } from "@task-handoff/control-plane-client";
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
import { useInstanceBoardSessions, type BoardSessionTab } from "./board/useInstanceBoardSessions";
import { appDisplayName, buildAppSessionTabs, type SessionTab } from "./useInstanceSessions";
import { isInstanceConnecting } from "./useInstanceStatus";
import { useResizableInstancesSidebar } from "./instance-list/useResizableInstancesSidebar";
import { useWorkbenchInstances } from "./instance-list/useWorkbenchInstances";
import { useAiSessionStore } from "./useAiSessionStore";
import { useAppSessionStore } from "./useAppSessionStore";
import { useControlPlaneEvents } from "./useControlPlaneEvents";
import { useControlPlaneToasts } from "./useControlPlaneToasts";
import { useImagePullProgress } from "./useImagePullProgress";
import { buildInstanceDetailPath, openInstanceDetailWindow, switchDesktopInstanceDetailWindow } from "./instance-detail/instanceDetailWindow";
import { consumeInstanceDetailSelection, instanceDetailSelectionStorageKey, persistInstanceDetailSelection, type InstanceDetailSelection } from "./instance-detail/instanceDetailSelection";
import { createWebInstanceWindowCoordinator } from "./instance-detail/instanceWindowCoordinator";

type ProjectFolderSelection = string | { path: string; ownerNodeId?: string };

type DesktopBridge = {
  chooseProjectFolder?: () => Promise<ProjectFolderSelection | undefined>;
  openAppWindow?: (url: string) => Promise<{ ok: boolean }>;
  openControlPlaneWindow?: (url: string) => Promise<{ ok: boolean }>;
  openInstanceDetailWindow?: (instanceId: string) => Promise<{ ok: boolean; action?: string; code?: string }>;
  switchInstanceDetailWindow?: (instanceId: string) => Promise<{ ok: boolean; action?: "switched" | "focused" | "error"; code?: string }>;
  windowDrag?: (phase: "start" | "move" | "end", screenX: number, screenY: number) => void;
  onOpenSettings?: (listener: () => void) => () => void;
  windowChrome?: { mode: "custom" | "macos-overlay" | "windows-overlay" };
  windowAction?: (action: "minimize" | "toggle-maximize" | "close") => Promise<{ ok: boolean; maximized?: boolean }>;
};

const props = withDefaults(defineProps<{
  mode?: "workbench" | "standalone";
  initialInstanceId?: string;
}>(), {
  mode: "workbench",
  initialInstanceId: "",
});
const standaloneMode = computed(() => props.mode === "standalone");
const standaloneInstanceId = ref(props.initialInstanceId);
const pendingInstanceDetailSelection = ref<InstanceDetailSelection | undefined>(standaloneMode.value && props.initialInstanceId
  ? consumeInstanceDetailSelection(props.initialInstanceId)
  : undefined);
const standaloneOwnershipResolved = ref(!standaloneMode.value);
const standaloneOwnershipReady = ref(!standaloneMode.value);
const standaloneOwnershipConflict = ref(false);
const instanceSwitcherOpen = ref(false);
const instanceSwitcherElement = ref<HTMLButtonElement>();
const instanceSwitcherTitleElement = ref<HTMLElement>();
const instanceSwitcherOverflow = ref(false);
const instanceSwitchLoadingVisible = ref(false);
const initialWorkbenchLoadingVisible = ref(true);
const initialWorkbenchLoadingFinished = ref(false);
let instanceSwitcherPointer: { pointerId: number; startScreenX: number; startScreenY: number; moved: boolean } | undefined;
let suppressInstanceSwitcherClick = false;
let instanceSwitchLoadingTimer: number | undefined;
let instanceSwitchSequence = 0;
let instanceSwitcherResizeObserver: ResizeObserver | undefined;

function syncInstanceSwitcherOverflow() {
  const trigger = instanceSwitcherElement.value;
  instanceSwitcherOverflow.value = Boolean(trigger && trigger.scrollWidth > trigger.clientWidth + 1);
}

function observeInstanceSwitcherOverflow() {
  if (!standaloneMode.value) return;
  instanceSwitcherResizeObserver?.disconnect();
  if (typeof ResizeObserver !== "undefined") {
    instanceSwitcherResizeObserver = new ResizeObserver(syncInstanceSwitcherOverflow);
    if (instanceSwitcherElement.value) instanceSwitcherResizeObserver.observe(instanceSwitcherElement.value);
    if (instanceSwitcherTitleElement.value) instanceSwitcherResizeObserver.observe(instanceSwitcherTitleElement.value);
  }
  syncInstanceSwitcherOverflow();
}

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
const sessionQueryInstanceId = computed(() => standaloneMode.value ? standaloneInstanceId.value : "");
const sessionQueriesEnabled = computed(() => !standaloneMode.value || standaloneOwnershipReady.value);
const board = useInstanceBoardQuery(sessionQueryInstanceId, sessionQueriesEnabled);
const instanceDirectory = useInstanceDirectoryQuery(standaloneMode);
const controlPlaneAiSessions = useControlPlaneAiSessionsQuery(sessionQueryInstanceId, sessionQueriesEnabled);
const controlPlaneAppSessions = useControlPlaneAppSessionsQuery(sessionQueryInstanceId, sessionQueriesEnabled);
const nodes = useNodesQuery(computed(() => !standaloneMode.value));
const workbenchLoadingOverlayVisible = computed(() => initialWorkbenchLoadingVisible.value
  || (standaloneMode.value && instanceSwitchLoadingVisible.value));

watch(
  () => (standaloneMode.value && !standaloneOwnershipResolved.value) || board.isLoading.value,
  (loading) => {
    if (loading || initialWorkbenchLoadingFinished.value) return;
    initialWorkbenchLoadingFinished.value = true;
    window.requestAnimationFrame(() => {
      initialWorkbenchLoadingVisible.value = false;
    });
  },
  { flush: "post", immediate: true },
);

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
const settingsSection = ref<"basic" | "chat" | "images" | "environment-templates" | "projects" | "nodes" | "models" | "triggers" | "mobile-sessions" | "account" | "cloud-connectivity">("nodes");
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
const models = useModelsQuery(computed(() => !standaloneMode.value || instanceSettingsOpen.value));
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
const stopDesktopOpenSettings = desktopBridge?.onOpenSettings?.(() => {
  if (!standaloneMode.value) openSettings();
});
const webWindowCoordinator = standaloneMode.value && !desktopBridge?.switchInstanceDetailWindow
  ? createWebInstanceWindowCoordinator({
      onOwnershipLost: (instanceId) => {
        if (standaloneInstanceId.value !== instanceId) return;
        standaloneOwnershipResolved.value = true;
        standaloneOwnershipReady.value = false;
        standaloneOwnershipConflict.value = true;
      },
    })
  : undefined;
const serverUpdateNodeId = computed(() => desktopBridge ? "" : nodes.data.value?.find((node) => node.labels["task-handoff.control-plane.builtin"] === "true")?.id || "");
const serverUpdateQuery = useServerUpdateCheckQuery(serverUpdateNodeId);
const serverUpdateAvailable = computed(() => Boolean(serverUpdateQuery.data.value?.supported && serverUpdateQuery.data.value.updateAvailable));
const serverUpdateVersion = computed(() => serverUpdateQuery.data.value?.availableVersion || "");
const hasDesktopWindowControls = Boolean(desktopBridge?.windowAction);
const windowChromeMode = desktopBridge?.windowChrome?.mode;
const showCustomWindowControls = hasDesktopWindowControls && windowChromeMode === "custom";
const showNativeWindowControlSpace = hasDesktopWindowControls && windowChromeMode === "macos-overlay";
const showWindowsNativeWindowControlSpace = hasDesktopWindowControls && windowChromeMode === "windows-overlay";
const { collapseInstances, expandInstances, instancesCollapsed, instancesSidebarVisible, setInstancesSidebarVisible, startInstanceResize, stopInstanceResize, workbenchStyle } = useResizableInstancesSidebar();
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
  queryKey: () => controlPlaneQueryKeys.appSessions(sessionQueryInstanceId.value),
});
const boardInstancesWithAppSessions = appSessionStore.boardInstancesWithAppSessions;
const aiSessionStore = useAiSessionStore({
  boardInstances: () => boardInstancesWithAppSessions.value,
  aiSessions: () => controlPlaneAiSessions.data.value,
  queryKey: () => controlPlaneQueryKeys.aiSessions(sessionQueryInstanceId.value),
});
const boardInstancesWithAiSessions = aiSessionStore.boardInstancesWithAiSessions;
const switcherInstances = computed<Array<InstanceBoardItem | ControlPlaneInstanceResourceEntry>>(() => {
  if (!standaloneMode.value) return sortedInstances.value;
  return [...(instanceDirectory.data.value || [])].sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
});
const standaloneDirectoryInstance = computed(() => standaloneMode.value
  ? switcherInstances.value.find((instance) => instance.id === standaloneInstanceId.value)
  : undefined);
const switcherDuplicateNames = computed(() => {
  const counts = new Map<string, number>();
  for (const instance of switcherInstances.value) counts.set(instance.name, (counts.get(instance.name) || 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
});
const switcherInstanceName = (instance: InstanceBoardItem | ControlPlaneInstanceResourceEntry) => switcherDuplicateNames.value.has(instance.name)
  ? `${instance.name} (${instance.id})`
  : instance.name;
const switcherNodeName = (instance: InstanceBoardItem | ControlPlaneInstanceResourceEntry) => "node" in instance
  ? instance.node?.name || instance.nodeId
  : instance.nodeId;
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
  instances: boardInstancesWithAiSessions,
  selection: standaloneMode.value
    ? { mode: "standalone", activeInstanceId: standaloneInstanceId }
    : { mode: "persistent" },
});
const nodeLocalFolderNodeIds = ref<string[]>([]);
watch([sortedInstances, activeInstanceId], ([instances]) => {
  const visibleInstances = standaloneMode.value && activeInstance.value ? [activeInstance.value] : instances;
  const next = [...new Set(visibleInstances.map((instance) => instance.nodeId).filter(Boolean))].sort();
  if (next.length === nodeLocalFolderNodeIds.value.length
    && next.every((nodeId, index) => nodeId === nodeLocalFolderNodeIds.value[index])) return;
  nodeLocalFolderNodeIds.value = next;
}, { immediate: true });
const nodeLocalFolderQueries = useQueries({
  queries: () => nodeLocalFolderNodeIds.value.map(nodeLocalFoldersQueryOptions),
});
const nodeLocalFoldersByNodeId = computed<Record<string, NodeLocalFolder[]>>(() => Object.fromEntries(
  nodeLocalFolderQueries.value.map((query, index) => [nodeLocalFolderNodeIds.value[index], query.data || []]),
));
const activeInstanceWithAiSessions = computed(() => activeInstance.value);
const activeProjectFolderChooser = computed(() => {
  const labels = activeInstance.value?.node?.labels;
  return desktopBridge?.chooseProjectFolder
    && labels?.["task-handoff.control-plane.local"] === "true"
    && labels?.["task-handoff.control-plane.builtin"] === "true"
    ? desktopBridge.chooseProjectFolder
    : undefined;
});
const standaloneDetailError = computed(() => {
  if (!standaloneMode.value) return "";
  if (!standaloneInstanceId.value) return t("instances.window.invalidRoute");
  if (standaloneOwnershipConflict.value) return t("instances.window.alreadyOpen");
  if (standaloneOwnershipResolved.value && !activeInstance.value) return t("instances.window.instanceUnavailable");
  return "";
});
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
const selectedInstanceId = computed(() => standaloneMode.value ? standaloneInstanceId.value : activeInstance.value?.id || "");
const topbarTitle = computed(() => {
  if (!settingsMode.value) {
    const selectedDetail = !standaloneMode.value || activeInstance.value?.id === standaloneInstanceId.value
      ? activeInstance.value
      : undefined;
    return selectedDetail?.name || standaloneDirectoryInstance.value?.name || t("navigation.controlPlane");
  }
  return settingsSectionTitle(settingsSection.value);
});
const topbarRuntimeType = computed(() => {
  if (!standaloneMode.value) return activeInstance.value?.runtime?.type;
  if (activeInstance.value?.id === standaloneInstanceId.value) return activeInstance.value.runtime?.type;
  return standaloneDirectoryInstance.value?.runtime.type;
});
const topbarNodeName = computed(() => {
  if (standaloneMode.value && activeInstance.value?.id !== standaloneInstanceId.value) return "";
  return activeInstance.value?.node?.name || "";
});
const refreshing = computed(() => board.isFetching.value || controlPlane.isFetching.value);
useControlPlaneEvents({
  instanceId: sessionQueryInstanceId,
  enabled: sessionQueriesEnabled,
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
  boardAiSessions,
  boardCardDetail,
  boardCardTitle,
  boardPreviewState,
  boardPrimarySession,
  boardPrimaryAiSession,
  boardSessionFrameUrl,
  boardSessions,
  boardTerminalSocketUrl,
  selectBoardSession,
  stepBoardAiSession,
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

function applyPendingInstanceDetailSelection() {
  const selection = pendingInstanceDetailSelection.value;
  const instanceId = activeInstance.value?.id;
  if (!standaloneMode.value || !selection || !instanceId || instanceId !== standaloneInstanceId.value) return;
  if (selection.kind === "ai") {
    if (!sessionTabs.value.some((session) => session.key === "ai-sessions")) return;
    selectAiSession(instanceId, selection.aiSessionId);
    selectSession("ai-sessions");
  } else {
    if (!sessionTabs.value.some((session) => session.key === selection.sessionKey)) return;
    selectSession(selection.sessionKey);
  }
  pendingInstanceDetailSelection.value = undefined;
}

watch(
  [activeInstanceId, () => sessionTabs.value.map((session) => session.key).join("\n"), pendingInstanceDetailSelection],
  applyPendingInstanceDetailSelection,
  { immediate: true },
);

useEventListener(window, "storage", (event) => {
  if (!standaloneMode.value || event.key !== instanceDetailSelectionStorageKey(standaloneInstanceId.value)) return;
  const selection = consumeInstanceDetailSelection(standaloneInstanceId.value);
  if (!selection) return;
  pendingInstanceDetailSelection.value = selection;
});

const { disposeBoardTerminalPreviews, disposeHiddenBoardTerminalPreviews, mountBoardTerminalPreviews, setBoardTerminalHost } = useBoardTerminalPreviews(boardMode, boardInteractive);

let connectingRefreshTimer: ReturnType<typeof setInterval> | undefined;

watch(
  [topbarTitle, standaloneInstanceId],
  () => {
    closeFloatingLayers();
    if (standaloneMode.value) {
      document.title = `${topbarTitle.value} · TaskHandoff`;
    }
  },
  { immediate: true },
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
  instanceSwitcherResizeObserver?.disconnect();
  instanceSwitcherResizeObserver = undefined;
  finishInstanceSwitch(instanceSwitchSequence);
  cancelInstanceSwitcherPointer();
  stopDesktopOpenSettings?.();
  webWindowCoordinator?.dispose();
  clearToasts();
  if (connectingRefreshTimer) {
    clearInterval(connectingRefreshTimer);
    connectingRefreshTimer = undefined;
  }
  disposeBoardTerminalPreviews();
  stopInstanceResize();
});

onMounted(async () => {
  if (!standaloneMode.value) return;
  await nextTick();
  observeInstanceSwitcherOverflow();
  if (!standaloneInstanceId.value) {
    standaloneOwnershipResolved.value = true;
    return;
  }
  if (!webWindowCoordinator) {
    standaloneOwnershipResolved.value = true;
    standaloneOwnershipReady.value = true;
    return;
  }
  const result = await webWindowCoordinator.claim(standaloneInstanceId.value);
  standaloneOwnershipResolved.value = true;
  standaloneOwnershipReady.value = result.action === "claimed";
  standaloneOwnershipConflict.value = result.action === "focused";
  // i18n-audit-allow-next-line code-token: toast presentation variant
  if (result.action === "focused") showToast(t("instances.window.alreadyOpen"), "info");
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
  if (section === "account") {
    return t("settings.account.navigation");
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

function updateInstanceSwitcherOpen(open: boolean) {
  if (open && instanceSwitcherPointer) return;
  instanceSwitcherOpen.value = open;
}

function startInstanceSwitcherPointer(event: PointerEvent) {
  if (event.button !== 0 || !desktopBridge?.windowDrag) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  suppressInstanceSwitcherClick = true;
  const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  target?.setPointerCapture?.(event.pointerId);
  instanceSwitcherPointer = {
    pointerId: event.pointerId,
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    moved: false,
  };
  desktopBridge.windowDrag("start", event.screenX, event.screenY);
}

function moveInstanceSwitcherPointer(event: PointerEvent) {
  const pointer = instanceSwitcherPointer;
  if (!pointer || pointer.pointerId !== event.pointerId || !desktopBridge?.windowDrag) return;
  if (!pointer.moved && Math.hypot(event.screenX - pointer.startScreenX, event.screenY - pointer.startScreenY) < 5) return;
  pointer.moved = true;
  instanceSwitcherOpen.value = false;
  desktopBridge.windowDrag("move", event.screenX, event.screenY);
}

function finishInstanceSwitcherPointer(event: PointerEvent) {
  const pointer = instanceSwitcherPointer;
  if (!pointer || pointer.pointerId !== event.pointerId || !desktopBridge?.windowDrag) return;
  desktopBridge.windowDrag("end", event.screenX, event.screenY);
  instanceSwitcherPointer = undefined;
  if (!pointer.moved) instanceSwitcherOpen.value = true;
  window.setTimeout(() => { suppressInstanceSwitcherClick = false; }, 0);
}

function cancelInstanceSwitcherPointer(event?: PointerEvent) {
  const pointer = instanceSwitcherPointer;
  if (!pointer || (event && pointer.pointerId !== event.pointerId) || !desktopBridge?.windowDrag) return;
  desktopBridge.windowDrag("end", event?.screenX ?? pointer.startScreenX, event?.screenY ?? pointer.startScreenY);
  instanceSwitcherPointer = undefined;
  suppressInstanceSwitcherClick = false;
}

function consumeInstanceSwitcherClick(event: MouseEvent) {
  if (!suppressInstanceSwitcherClick) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  suppressInstanceSwitcherClick = false;
}

async function openAppUrl(url: string) {
  if (desktopBridge?.openAppWindow) {
    await desktopBridge.openAppWindow(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function openInstanceWindow(instance: InstanceBoardItem, session?: BoardSessionTab, aiSession?: AiSessionSummary) {
  if (session?.kind === "ai" && aiSession) {
    persistInstanceDetailSelection(instance.id, { kind: "ai", aiSessionId: aiSession.id });
  } else if (session) {
    persistInstanceDetailSelection(instance.id, { kind: "app", sessionKey: session.key });
  }
  const result = await openInstanceDetailWindow(instance.id);
  if (!result.ok) {
    try {
      window.localStorage?.removeItem(instanceDetailSelectionStorageKey(instance.id));
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
    showToast(t(result.code === "popup-blocked" ? "instances.window.popupBlocked" : "instances.window.switchFailed"));
  }
  // i18n-audit-allow-next-line code-token: toast presentation variant
  else if (result.action === "focused") showToast(t("instances.window.focusedExisting"), "info");
  closeFloatingLayers();
}

async function selectInstance(id: string) {
  if (!standaloneMode.value) {
    setActiveInstance(id);
    closeFloatingLayers();
    return;
  }
  if (id === activeInstanceId.value) {
    closeFloatingLayers();
    return;
  }
  closeFloatingLayers();
  const switchSequence = beginInstanceSwitch();
  try {
    await queryClient.ensureQueryData(instanceBoardQueryOptions(id));
  } catch {
    // The scoped query retains the authoritative error for the target detail view.
  }
  if (switchSequence !== instanceSwitchSequence) return;
  const desktopResult = await switchDesktopInstanceDetailWindow(id);
  if (desktopResult?.action === "focused") {
    finishInstanceSwitch(switchSequence);
    // i18n-audit-allow-next-line code-token: toast presentation variant
    showToast(t("instances.window.focusedExisting"), "info");
    closeFloatingLayers();
    return;
  }
  if (desktopResult && desktopResult.action !== "switched") {
    finishInstanceSwitch(switchSequence);
    showToast(t("instances.window.switchFailed"));
    closeFloatingLayers();
    return;
  }
  if (!desktopResult && webWindowCoordinator) {
    const webResult = await webWindowCoordinator.claim(id);
    if (webResult.action === "focused") {
      finishInstanceSwitch(switchSequence);
      // i18n-audit-allow-next-line code-token: toast presentation variant
      showToast(t("instances.window.focusedExisting"), "info");
      closeFloatingLayers();
      return;
    }
  }
  standaloneOwnershipResolved.value = true;
  standaloneOwnershipReady.value = true;
  standaloneOwnershipConflict.value = false;
  setActiveInstance(id);
  window.history.replaceState(null, "", buildInstanceDetailPath(id));
  await nextTick();
  window.requestAnimationFrame(() => finishInstanceSwitch(switchSequence));
}

function beginInstanceSwitch() {
  instanceSwitchSequence += 1;
  if (instanceSwitchLoadingTimer) window.clearTimeout(instanceSwitchLoadingTimer);
  const sequence = instanceSwitchSequence;
  instanceSwitchLoadingTimer = window.setTimeout(() => {
    if (sequence === instanceSwitchSequence) instanceSwitchLoadingVisible.value = true;
  }, 90);
  return sequence;
}

function finishInstanceSwitch(sequence: number) {
  if (sequence !== instanceSwitchSequence) return;
  if (instanceSwitchLoadingTimer) window.clearTimeout(instanceSwitchLoadingTimer);
  instanceSwitchLoadingTimer = undefined;
  instanceSwitchLoadingVisible.value = false;
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
