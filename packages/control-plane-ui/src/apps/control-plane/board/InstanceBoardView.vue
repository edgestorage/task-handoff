<template>
  <section class="instance-board-view" :aria-label="t('instances.board.label')">
    <div v-if="loading" class="board-empty">{{ t("instances.board.loading") }}</div>
    <div v-else-if="error" class="board-empty error">{{ error }}</div>
    <template v-else>
      <div class="instance-board-toolbar">
        <div class="board-filter-group">
          <label class="board-search">
            <Search :size="14" />
            <input :value="filter" :placeholder="t('instances.board.search')" @input="$emit('update:filter', ($event.target as HTMLInputElement).value)" />
          </label>
          <ControlPlaneSelect :model-value="projectFilter" :placeholder="t('instances.board.allProjects')" trigger-class="board-select" @update:model-value="$emit('update:projectFilter', $event)">
            <ControlPlaneSelectItem :value="allFilterValue">{{ t("instances.board.allProjects") }}</ControlPlaneSelectItem>
            <ControlPlaneSelectItem v-for="project in projectOptions" :key="project.id" :value="project.id">{{ project.name }}</ControlPlaneSelectItem>
          </ControlPlaneSelect>
          <ControlPlaneSelect :model-value="statusFilter" :placeholder="t('instances.board.allStatuses')" trigger-class="board-select" @update:model-value="$emit('update:statusFilter', $event)">
            <ControlPlaneSelectItem :value="allFilterValue">{{ t("instances.board.allStatuses") }}</ControlPlaneSelectItem>
            <ControlPlaneSelectItem v-for="status in statusOptions" :key="status" :value="status">{{ instanceStatusLabel(status) }}</ControlPlaneSelectItem>
          </ControlPlaneSelect>
          <ControlPlaneSelect :model-value="appFilter" :placeholder="t('instances.board.showApp')" trigger-class="board-select board-app-select" :disabled="!appOptions.length" @update:model-value="$emit('update:appFilter', $event)">
            <ControlPlaneSelectItem :value="allFilterValue">{{ t("instances.board.mixedApps") }}</ControlPlaneSelectItem>
            <ControlPlaneSelectItem v-for="app in appOptions" :key="app.appId" :value="app.appId">
              {{ appDisplayName(app.appId, t) }} · {{ app.count }}
            </ControlPlaneSelectItem>
          </ControlPlaneSelect>
        </div>
        <div class="board-toolbar-actions">
          <InstanceViewOptionsMenu
            :group-by-node="groupByNode"
            :label="t('instances.board.options')"
            :preview-interactive="interactive"
            :show-preview-interaction="true"
            :sort-mode="sortMode"
            @update:group-by-node="$emit('update:groupByNode', $event)"
            @update:preview-interactive="$emit('update:interactive', $event)"
            @update:sort-mode="$emit('update:sortMode', $event)"
          />
          <div class="board-size-toggle" :aria-label="t('instances.board.cardSize')">
            <button v-for="option in sizeOptions" :key="option.value" type="button" :class="{ active: size === option.value }" @click="$emit('setSize', option.value)">
              {{ option.label }}
            </button>
          </div>
        </div>
      </div>
      <ScrollArea class="instance-board-grid-scroll">
        <div class="instance-board-grid" :class="`size-${size}`">
          <template v-for="group in boardGroups" :key="group.key">
            <div v-if="groupByNode" class="board-group-label">
              <span>{{ group.label }}</span>
              <strong>{{ group.instances.length }}</strong>
            </div>
            <article
              v-for="instance in group.instances"
              :key="`board-${instance.id}`"
              class="instance-board-card"
              :class="{ active: instance.id === activeInstanceId }"
            >
            <header class="board-card-head">
              <button type="button" class="board-card-title" @click="$emit('selectInstance', instance.id)">
                <span class="status-dot" :data-state="instance.connectionStatus" />
                <span>
                  <strong>{{ instanceDisplayName(instance) }}</strong>
                  <small>{{ instanceSourceLabel(instance, t) }}</small>
                </span>
              </button>
              <div class="board-card-badges">
                <Badge :variant="instance.connectionStatus === 'online' ? 'default' : 'secondary'">{{ connectionStatusLabel(instance.connectionStatus) }}</Badge>
                <Badge variant="secondary">{{ instanceStatusLabel(instance.status) }}</Badge>
              </div>
            </header>
            <p v-if="instance.imageProvisioning && instance.imageProvisioning.phase !== 'ready'" class="image-provisioning-status">
              {{ imageProvisioningLabel(instance, t) }}<template v-if="instance.imageProvisioning.error"> · {{ instance.imageProvisioning.error }}</template>
            </p>
            <div class="board-card-preview" :data-interactive="interactive" :data-state="boardPreviewState(instance)">
              <div v-if="boardSessions(instance).length > 1" class="board-session-switcher" @click.stop>
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <button type="button" class="board-session-trigger" :aria-label="t('instances.board.switchSession', { name: instanceDisplayName(instance) })">
                      <span>{{ sessionDisplayName(boardPrimarySession(instance), t) }}</span>
                      <ChevronDown :size="13" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent class="board-session-menu" align="start" :side-offset="5">
                    <DropdownMenuItem
                      v-for="session in boardSessions(instance)"
                      :key="session.key"
                      class="board-session-item"
                      :class="{ active: session.key === boardPrimarySession(instance)?.key }"
                      @select="$emit('selectBoardSession', instance.id, session.key)"
                    >
                      <span>
                        <strong>{{ sessionDisplayName(session, t) }}</strong>
                        <small>{{ sessionMeta(session, t) }}</small>
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div v-if="boardPrimarySession(instance)?.kind === 'ai'" class="board-ai-preview">
                <span>{{ aiSessionHeadline(instance, t) }}</span>
                <span class="board-ai-message">{{ aiSessionHeadline(instance, t) }}</span>
                <small>{{ t("sessions.board.updated", { time: relativeTime(instance.aiSessions.updatedAt, locale as SupportedLocale) }) }}</small>
              </div>
              <iframe
                v-else-if="boardSessionFrameUrl(instance)"
                class="board-card-frame"
                :src="boardSessionFrameUrl(instance)"
                :title="t('instances.board.sessionFrame', { name: instanceDisplayName(instance) })"
                allow="clipboard-read; clipboard-write; fullscreen"
              />
              <div
                v-else-if="boardTerminalSocketUrl(instance)"
                :ref="(element) => setBoardTerminalHost(instance.id, boardTerminalSocketUrl(instance), element)"
                class="board-terminal-preview"
              />
              <div v-else class="board-card-empty">
                <Monitor :size="28" />
                <strong>{{ boardCardTitle(instance) }}</strong>
                <DropdownMenu
                  v-if="canLaunchBoardApp(instance)"
                  :open="boardLaunchMenuId === instance.id"
                  @update:open="(open) => boardLaunchMenuId = open ? instance.id : ''"
                >
                  <DropdownMenuTrigger as-child>
                    <Button variant="outline" size="sm" class="board-launch-button" :disabled="launchingApp" :aria-expanded="boardLaunchMenuId === instance.id" :title="t('instances.actions.launchApp')">
                      <Plus :size="14" />
                      <span>{{ t("instances.actions.app") }}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent class="board-launch-menu" align="center" :side-offset="6">
                    <AppLaunchMenuItems :apps="launchableAppsForInstance(instance, t)" :folders="projectFoldersForInstance(instance)" :instance="instance" :launching="launchingApp" submenu-class="board-launch-menu" @launch="(appId, cwdFolderId) => launchBoardApp(instance, appId, cwdFolderId)" @new-project="openProjectPicker(instance)" />
                  </DropdownMenuContent>
                </DropdownMenu>
                <span v-else>{{ boardCardDetail(instance) }}</span>
              </div>
            </div>
            <footer class="board-card-actions">
              <Button v-if="canShowInstanceAction(instance, 'start')" variant="outline" size="sm" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'start', instance)">
                <Play :size="14" />
                <span>{{ activeActionLabel(instance, "start", t("instances.actions.start")) }}</span>
              </Button>
              <Button v-if="canShowInstanceAction(instance, 'stop')" variant="outline" size="sm" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'stop', instance)">
                <Square :size="14" />
                <span>{{ activeActionLabel(instance, "stop", t("instances.actions.stop")) }}</span>
              </Button>
              <Button v-if="canShowInstanceAction(instance, 'restart')" variant="outline" size="sm" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'restart', instance)">
                <RotateCw :size="14" />
                <span>{{ activeActionLabel(instance, "restart", t("instances.actions.restart")) }}</span>
              </Button>
              <Button v-if="canShowInstanceAction(instance, 'retry-image')" variant="outline" size="sm" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'retry-image', instance)">
                <RotateCw :size="14" />
                <span>{{ activeActionLabel(instance, "retry-image", t("instances.actions.retryImage")) }}</span>
              </Button>
              <Button variant="outline" size="sm" @click="$emit('openWindow', instance)">
                <ExternalLink :size="14" />
                <span>{{ t("instances.actions.open") }}</span>
              </Button>
            </footer>
            </article>
          </template>
          <div v-if="!visibleInstances.length" class="board-empty">{{ totalInstances ? t("instances.board.noMatches") : t("instances.board.empty") }}</div>
        </div>
      </ScrollArea>
    </template>
    <ProjectFolderPicker
      v-if="projectPickerInstance"
      :node-id="projectPickerInstance.nodeId"
      :node-name="instanceNodeLabel(projectPickerInstance)"
      :open="true"
      @created="handleProjectCreated"
      @update:open="closeProjectPicker"
    />
  </section>
</template>

<script setup lang="ts">
import { ChevronDown, ExternalLink, Monitor, Play, Plus, RotateCw, Search, Square } from "@lucide/vue";
import { computed, ref, type ComponentPublicInstance } from "vue";
import { useI18n } from "vue-i18n";
import type { SupportedLocale } from "../../../i18n/locale";
import type { InstanceBoardItem, NodeLocalFolder } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import type { InstanceAction } from "../useInstanceActions";
import { canShowInstanceAction, imageProvisioningLabel, instanceSourceLabel, isInstanceAppReady } from "../useInstanceStatus";
import type { InstanceListSortMode } from "../instance-list/useWorkbenchInstances";
import InstanceViewOptionsMenu from "../shared/InstanceViewOptionsMenu.vue";
import AppLaunchMenuItems from "../shared/AppLaunchMenuItems.vue";
import ProjectFolderPicker from "../shared/ProjectFolderPicker.vue";
import { connectionStatusKeys, instanceStatusKeys, translateStatus } from "../../../i18n/status";
import {
  aiSessionHeadline,
  aiSessionStatusLabel,
  appDisplayName,
  launchableAppsForInstance,
  primaryAiSession,
  primaryAiSessionMessage,
  relativeTime,
  sessionDisplayName,
  sessionMeta,
  type SessionTab,
} from "../useInstanceSessions";

type BoardSize = "small" | "medium" | "large";

const { locale, t } = useI18n();
const instanceStatusLabel = (status: string) => translateStatus(instanceStatusKeys, status, t);
const connectionStatusLabel = (status: string) => translateStatus(connectionStatusKeys, status, t);

const props = defineProps<{
  activeActionLabel: (instance: InstanceBoardItem, action: InstanceAction, idleLabel: string) => string;
  activeInstanceId?: string;
  allFilterValue: string;
  appFilter: string;
  appOptions: Array<{ appId: string; count: number }>;
  boardCardDetail: (instance: InstanceBoardItem) => string;
  boardCardTitle: (instance: InstanceBoardItem) => string;
  boardPreviewState: (instance: InstanceBoardItem) => string;
  boardPrimarySession: (instance: InstanceBoardItem) => SessionTab | undefined;
  boardSessionFrameUrl: (instance: InstanceBoardItem) => string;
  boardSessions: (instance: InstanceBoardItem) => SessionTab[];
  boardTerminalSocketUrl: (instance: InstanceBoardItem) => string;
  error?: string;
  filter: string;
  groupByNode: boolean;
  instanceDisplayName: (instance: InstanceBoardItem) => string;
  interactive: boolean;
  isInstanceActionBusy: (instance: InstanceBoardItem) => boolean;
  launchingApp: boolean;
  loading: boolean;
  nodeLocalFoldersByNodeId: Record<string, NodeLocalFolder[]>;
  projectFilter: string;
  projectOptions: Array<{ id: string; name: string }>;
  setBoardTerminalHost: (instanceId: string, socketUrl: string, element: Element | ComponentPublicInstance | null) => void;
  size: BoardSize;
  sizeOptions: Array<{ value: BoardSize; label: string }>;
  sortMode: InstanceListSortMode;
  statusFilter: string;
  statusOptions: string[];
  totalInstances: number;
  visibleInstances: InstanceBoardItem[];
}>();

const emit = defineEmits<{
  launchApp: [instance: InstanceBoardItem, appId: string, cwdFolderId?: string];
  openWindow: [instance: InstanceBoardItem];
  runAction: [action: InstanceAction, instance: InstanceBoardItem];
  selectBoardSession: [instanceId: string, sessionKey: string];
  selectInstance: [instanceId: string];
  setSize: [size: BoardSize];
  "update:groupByNode": [value: boolean];
  "update:interactive": [value: boolean];
  "update:appFilter": [value: string];
  "update:filter": [value: string];
  "update:projectFilter": [value: string];
  "update:sortMode": [value: InstanceListSortMode];
  "update:statusFilter": [value: string];
}>();

const boardLaunchMenuId = ref("");
const projectPickerInstance = ref<InstanceBoardItem>();
const createdProjectFoldersByNodeId = ref<Record<string, NodeLocalFolder[]>>({});

function launchBoardApp(instance: InstanceBoardItem, appId: string, cwdFolderId?: string) {
  boardLaunchMenuId.value = "";
  emit("launchApp", instance, appId, cwdFolderId);
}

function openProjectPicker(instance: InstanceBoardItem) {
  projectPickerInstance.value = instance;
}

function closeProjectPicker(open: boolean) {
  if (!open) projectPickerInstance.value = undefined;
}

function handleProjectCreated(folder: NodeLocalFolder) {
  const nodeId = projectPickerInstance.value?.nodeId;
  if (nodeId) {
    createdProjectFoldersByNodeId.value = {
      ...createdProjectFoldersByNodeId.value,
      [nodeId]: [...(createdProjectFoldersByNodeId.value[nodeId] || []), folder],
    };
  }
  projectPickerInstance.value = undefined;
}

function projectFoldersForInstance(instance: InstanceBoardItem) {
  return [...new Map([...(props.nodeLocalFoldersByNodeId[instance.nodeId] || []), ...(createdProjectFoldersByNodeId.value[instance.nodeId] || [])].map((folder) => [folder.id, folder])).values()];
}

function instanceNodeLabel(instance: InstanceBoardItem) {
  return instance.node?.name || instance.nodeId;
}

const boardGroups = computed(() => {
  if (!props.groupByNode) {
    return [{ key: "__all__", label: t("instances.board.allNodes"), instances: props.visibleInstances }];
  }
  const groups = new Map<string, { key: string; label: string; instances: InstanceBoardItem[] }>();
  for (const instance of props.visibleInstances) {
    const key = instance.nodeId || "__unknown__";
    const current = groups.get(key) || { key, label: instanceNodeLabel(instance), instances: [] };
    current.instances.push(instance);
    groups.set(key, current);
  }
  return [...groups.values()];
});

function canLaunchBoardApp(instance: InstanceBoardItem) {
  return isInstanceAppReady(instance) && launchableAppsForInstance(instance, t).length > 0;
}
</script>

<style scoped>
.instance-board-view {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 10px;
  min-height: 0;
  overflow: hidden;
  background:
    radial-gradient(circle at 78% 10%, var(--brand-accent-soft), transparent 32rem),
    var(--workspace-bg);
  padding: 10px;
}

.instance-board-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  padding: 0 0 2px;
}

.board-filter-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  min-width: 0;
  gap: 6px;
}

.board-search {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  width: min(220px, 26vw);
  min-width: 160px;
  height: 30px;
  border: 1px solid var(--board-control-border);
  border-radius: 7px;
  background: var(--board-control-bg);
  color: var(--text-muted);
  padding: 0 9px;
}

.board-search input {
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--board-control-input-text);
  font-size: 12px;
  outline: none;
}

.board-search input::placeholder {
  color: var(--text-subtle);
}

.board-size-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 3px;
  border: 1px solid var(--board-control-border);
  border-radius: 7px;
  background: var(--board-control-bg);
  height: 30px;
  padding: 2px;
}

.board-toolbar-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
}

.board-size-toggle button {
  min-height: 24px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  font-weight: 750;
  padding: 0 8px;
}

.board-size-toggle button:hover,
.board-size-toggle button:focus-visible,
.board-size-toggle button.active {
  background: var(--board-control-active-bg);
  color: var(--board-control-active-text);
  outline: none;
  box-shadow: none;
}

.instance-board-grid-scroll {
  min-width: 0;
  min-height: 0;
}

.instance-board-grid {
  --board-card-min: 360px;
  --board-card-height: 420px;
  display: grid;
  align-content: start;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, var(--board-card-min)), 1fr));
  gap: 12px;
  min-height: 100%;
}

.board-group-label {
  display: flex;
  align-self: start;
  grid-column: 1 / -1;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 30px;
  border-bottom: 1px solid var(--line);
  color: var(--brand-accent-muted);
  font-size: 12px;
  font-weight: 750;
}

.board-group-label strong {
  color: var(--text-muted);
  font-size: 12px;
}

.instance-board-grid.size-small {
  --board-card-min: 280px;
  --board-card-height: 320px;
}

.instance-board-grid.size-large {
  --board-card-min: 520px;
  --board-card-height: 560px;
}

.instance-board-card {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-width: 0;
  height: var(--board-card-height);
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-inset);
  box-shadow: var(--shadow-popover);
}

.instance-board-card.active {
  border-color: var(--brand-accent);
  box-shadow:
    0 0 0 1px var(--focus-ring),
    var(--shadow-popover);
}

.board-card-head {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 10px;
  border-bottom: 1px solid var(--line);
  padding: 10px;
}

.board-card-title {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 8px;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--text-strong);
  cursor: pointer;
  padding: 0;
  text-align: left;
}

.board-card-title strong,
.board-card-title small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board-card-title strong {
  font-size: 13px;
  font-weight: 800;
}

.board-card-title small {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
}

.board-card-title:hover strong,
.board-card-title:focus-visible strong {
  color: var(--brand-accent-muted);
}

.board-card-title:focus-visible {
  outline: none;
}

.board-card-badges {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 5px;
}

.board-card-preview {
  display: grid;
  position: relative;
  min-height: 0;
  overflow: hidden;
  background: var(--workspace-bg);
}

.board-session-switcher {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 5;
  opacity: 0;
  transform: translateY(-2px);
  transition:
    opacity 120ms ease,
    transform 120ms ease;
}

.instance-board-card:hover .board-session-switcher,
.instance-board-card:focus-within .board-session-switcher {
  opacity: 1;
  transform: translateY(0);
}

.board-session-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 190px;
  min-height: 27px;
  border: 1px solid var(--focus-ring);
  border-radius: 6px;
  background: var(--surface-overlay);
  color: var(--text-strong);
  cursor: pointer;
  font-size: 11px;
  font-weight: 800;
  padding: 0 8px;
  box-shadow: var(--shadow-popover);
}

.board-session-trigger span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board-session-trigger:hover,
.board-session-trigger:focus-visible {
  border-color: var(--status-success);
  background: var(--surface-active);
  outline: none;
}

.board-session-menu {
  display: grid;
  width: 220px;
  gap: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-inset);
  box-shadow: var(--shadow-popover);
  padding: 5px;
}

.board-session-item {
  display: flex;
  align-items: center;
  min-height: 40px;
  border-radius: 6px;
  color: var(--terminal-text);
  cursor: default;
  padding: 0 8px;
}

.board-session-item span {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.board-session-item strong,
.board-session-item small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board-session-item strong {
  color: var(--text-strong);
  font-size: 12px;
  font-weight: 800;
}

.board-session-item small {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
}

.board-session-item:hover,
.board-session-item:focus-visible,
.board-session-item[data-highlighted],
.board-session-item.active {
  background: var(--surface-active);
  color: var(--white);
  outline: none;
}

.board-card-frame {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
  background: var(--terminal-bg);
}

.board-card-preview[data-interactive="false"] .board-card-frame,
.board-card-preview[data-interactive="false"] .board-terminal-preview {
  pointer-events: none;
  user-select: none;
}

.board-terminal-preview {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--terminal-bg);
  padding: 6px;
}

.board-terminal-preview :deep(.board-terminal-surface) {
  position: absolute;
  top: 6px;
  left: 6px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  transform-origin: top left;
}

.board-terminal-preview :deep(.xterm) {
  width: max-content;
  height: max-content;
}

.board-terminal-preview :deep(.xterm-viewport) {
  overflow: hidden !important;
}

.board-card-empty,
.board-empty {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 7px;
  min-width: 0;
  color: var(--terminal-text);
  padding: 18px;
  text-align: center;
}

.board-empty {
  min-height: 300px;
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
  background: var(--surface-inset);
  color: var(--text-muted);
  padding: 28px;
}

.board-empty.error {
  color: var(--status-danger);
}

.board-card-empty strong,
.board-card-empty span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board-card-empty strong {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 800;
}

.board-card-empty span {
  color: var(--text-muted);
  font-size: 12px;
}

.board-launch-button {
  box-sizing: border-box;
  display: inline-flex;
  width: 96px;
  height: 32px;
  min-width: 96px;
  min-height: 32px;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-color: var(--terminal-selection);
  background: var(--surface-raised);
  color: var(--brand-accent-muted);
  font-weight: 800;
  padding: 0 12px;
}

.board-launch-button:hover,
.board-launch-button:focus-visible,
.board-launch-button[data-state="open"] {
  border-color: var(--brand-accent);
  background: var(--surface-active);
  color: var(--brand-accent-foreground);
}

.board-launch-button span {
  color: inherit;
  font-size: inherit;
  line-height: 1;
  max-width: none;
  overflow: visible;
  text-overflow: clip;
}

:global(.board-launch-menu) {
  z-index: 80;
  min-width: 220px;
  border: 1px solid var(--terminal-selection);
  background: var(--surface-hover);
  color: var(--terminal-text);
  padding: 5px;
}

:global(.board-launch-menu .app-launch-menu-item) {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 16px;
  align-items: center;
  gap: 8px;
  border-radius: 6px;
  cursor: pointer;
  padding: 8px;
}

:global(.board-launch-menu .app-launch-menu-item:hover),
:global(.board-launch-menu .app-launch-menu-item:focus-visible),
:global(.board-launch-menu .app-launch-menu-item[data-highlighted]) {
  background: var(--surface-active);
  color: var(--white);
}

:global(.board-launch-menu .app-launch-menu-item span) {
  display: grid;
  min-width: 0;
  gap: 2px;
}

:global(.board-launch-menu .app-launch-menu-item strong),
:global(.board-launch-menu .app-launch-menu-item small) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.board-launch-menu .app-launch-menu-item strong) {
  font-size: 12px;
  line-height: 1.25;
}

:global(.board-launch-menu .app-launch-menu-item small) {
  color: var(--text-subtle);
  font-size: 11px;
  line-height: 1.25;
}

.board-ai-preview {
  display: grid;
  align-content: center;
  gap: 6px;
  height: 100%;
  min-width: 0;
  background: var(--surface-inset);
  color: var(--terminal-text);
  padding: 18px;
}

.board-ai-preview span,
.board-ai-preview small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board-ai-preview span,
.board-ai-preview small {
  color: var(--text-muted);
  font-size: 12px;
}

.board-ai-message {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 800;
}

.board-ai-message code {
  border: 1px solid var(--line-subtle);
  border-radius: 4px;
  background: var(--surface-subtle);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.92em;
  padding: 1px 4px;
}

.board-ai-message strong {
  color: var(--text-strong);
  font-weight: 800;
}

.board-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  border-top: 1px solid var(--line);
  padding: 8px;
}

.image-provisioning-status {
  overflow: hidden;
  margin: 0;
  color: var(--status-warning);
  font-size: 11px;
  padding: 0 12px 8px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.board-card-actions .inline-flex {
  min-height: 28px;
  padding: 0 8px;
}

@media (max-width: 780px) {
  .instance-board-view {
    padding: 10px;
  }

  .instance-board-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
