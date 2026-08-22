<template>
  <aside class="instance-list" :class="{ collapsed }" :aria-label="t('instances.list.controlledInstances')">
    <Popover v-if="collapsed" v-model:open="temporaryListOpen">
      <PopoverTrigger as-child>
        <button type="button" class="instances-expand-rail" :aria-label="t('instances.list.switchInstance')" :title="t('instances.list.switchInstance')" @dblclick.prevent="expandTemporaryList">
          <PanelLeftOpen :size="16" />
          <span>{{ t("instances.title") }}</span>
          <strong>{{ totalInstances }}</strong>
        </button>
      </PopoverTrigger>
      <PopoverContent class="instances-temporary-popover" align="start" side="right" :side-offset="10" @open-auto-focus="(event) => event.preventDefault()">
        <InstanceList
          class="instances-temporary-list"
          :active-action-label="activeActionLabel"
          :active-instance-id="activeInstanceId"
          :can-export-config="canExportConfig"
          :collapsed="false"
          :embedded="true"
          :error="error"
          :filter="filter"
          :group-by-node="groupByNode"
          :instance-display-name="instanceDisplayName"
          :instances="instances"
          :is-instance-action-busy="isInstanceActionBusy"
          :loading="loading"
          :node-states="nodeStates"
          :nodes="nodes"
          :open-menu-id="openMenuId"
          :sort-mode="sortMode"
          :total-instances="totalInstances"
          @collapse="temporaryListOpen = false"
          @expand="expandTemporaryList"
          @new-instance="openNewInstanceFromTemporaryList"
          @open-settings="(instanceId) => $emit('openSettings', instanceId)"
          @open-window="(instance) => $emit('openWindow', instance)"
          @save-template="(instance) => $emit('saveTemplate', instance)"
          @resize-start="$emit('resizeStart', $event)"
          @run-action="(action, instance) => $emit('runAction', action, instance)"
          @open-config-sync="(direction, instance) => $emit('openConfigSync', direction, instance)"
          @select-instance="selectTemporaryInstance"
          @set-menu-open="(instanceId, open) => $emit('setMenuOpen', instanceId, open)"
          @update:filter="$emit('update:filter', $event)"
          @update:group-by-node="$emit('update:groupByNode', $event)"
          @update:sort-mode="$emit('update:sortMode', $event)"
        />
      </PopoverContent>
    </Popover>

    <template v-else>
      <div class="list-head">
        <div>
          <span>{{ t("instances.title") }}</span>
          <strong>{{ totalInstances }}</strong>
        </div>
        <div class="list-head-actions">
          <Button
            variant="outline"
            size="sm"
            class="icon-button"
            :aria-label="embedded ? t('instances.list.expand') : t('instances.list.collapse')"
            :title="embedded ? t('instances.list.expand') : t('instances.list.collapse')"
            @click="embedded ? $emit('expand') : $emit('collapse')"
          >
            <PanelLeftOpen v-if="embedded" :size="16" />
            <PanelLeftClose v-else :size="16" />
          </Button>
          <InstanceViewOptionsMenu :group-by-node="groupByNode" :label="t('instances.list.options')" :sort-mode="sortMode" @update:group-by-node="$emit('update:groupByNode', $event)" @update:sort-mode="$emit('update:sortMode', $event)" />
          <Button size="sm" class="icon-button" :aria-label="t('instances.list.new')" @click="$emit('newInstance')">
            <Plus :size="16" />
          </Button>
        </div>
      </div>

      <label class="list-filter">
        <Search :size="14" />
        <input :value="filter" :placeholder="t('instances.list.search')" @input="$emit('update:filter', ($event.target as HTMLInputElement).value)" />
      </label>

      <div v-if="loading && !nodes.length" class="list-empty">{{ t("instances.list.loading") }}</div>
      <div v-else-if="error" class="list-empty error">{{ error }}</div>
      <ScrollArea v-else class="instance-rows">
        <div class="instance-rows-content">
        <template v-for="group in instanceGroups" :key="group.key">
          <button
            v-if="groupByNode"
            type="button"
            class="instance-group-label"
            :aria-expanded="!collapsedGroups[group.key]"
            @click="toggleGroup(group.key)"
          >
            <Server class="instance-group-icon" :size="15" />
            <span class="instance-group-name">{{ group.label }}</span>
            <span v-if="group.connectionLabel" class="instance-group-status" :data-phase="group.resourcePhase || group.connectionPhase">
              <LoaderCircle v-if="group.resourcePhase === 'loading' || group.resourcePhase === 'uninitialized' || (group.connectionPhase && group.connectionPhase !== 'offline')" :size="13" aria-hidden="true" />
              {{ group.connectionLabel }}
            </span>
            <ChevronRight class="instance-group-chevron" :class="{ open: !collapsedGroups[group.key] }" :size="15" />
            <strong>{{ group.instances.length }}</strong>
          </button>
          <template v-if="!groupByNode || !collapsedGroups[group.key]">
          <ContextMenu
            v-for="instance in group.instances"
            :key="instance.id"
          >
            <ContextMenuTrigger as-child>
              <div
                class="instance-row"
                :class="{ active: instance.id === activeInstanceId }"
                @contextmenu="$emit('selectInstance', instance.id, 'contextmenu')"
              >
                <button type="button" class="instance-row-content" @click="$emit('selectInstance', instance.id)">
                  <span class="status-dot" :data-state="instance.connectionStatus" />
                  <span class="instance-row-main">
                    <span class="instance-row-title">
                      <span v-if="instance.runtime" class="instance-runtime-icon" role="img" :aria-label="instanceRuntimeLabel(instance)" :title="instanceRuntimeLabel(instance)">
                        <Laptop v-if="instance.runtime.type === 'local'" :size="14" aria-hidden="true" />
                        <Container v-else-if="instance.runtime.type === 'docker'" :size="14" aria-hidden="true" />
                        <Boxes v-else :size="14" aria-hidden="true" />
                      </span>
                      <strong>{{ instanceDisplayName(instance) }}</strong>
                    </span>
                    <small>{{ instanceSourceLabel(instance, t) }}</small>
                    <small v-if="instance.imageProvisioning && instance.imageProvisioning.phase !== 'ready'" class="image-provisioning-status">
                      {{ imageProvisioningLabel(instance, t) }}<template v-if="instance.imageProvisioning.error"> · {{ instance.imageProvisioning.error }}</template>
                    </small>
                  </span>
                  <span v-if="!groupByNode" class="instance-row-session">{{ instanceNodeLabel(instance) }}</span>
                </button>
                <div class="instance-row-actions" :class="{ open: openMenuId === instance.id }" @click.stop>
                  <DropdownMenu :open="openMenuId === instance.id" @update:open="(open) => $emit('setMenuOpen', instance.id, open)">
                    <DropdownMenuTrigger as-child>
                      <button type="button" class="instance-menu-trigger" :aria-expanded="openMenuId === instance.id" :aria-label="t('instances.list.openControls', { name: instance.name })">
                        <MoreHorizontal :size="16" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent class="instance-action-menu" align="end" :side-offset="6">
                      <DropdownMenuItem v-if="canShowInstanceAction(instance, 'start')" class="instance-action-item" :disabled="isInstanceActionBusy(instance)" @select="$emit('runAction', 'start', instance)">
                        <Play :size="14" />
                        <span>{{ activeActionLabel(instance, "start", t("instances.actions.start")) }}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem v-if="canShowInstanceAction(instance, 'stop')" class="instance-action-item" :disabled="isInstanceActionBusy(instance)" @select="$emit('runAction', 'stop', instance)">
                        <Square :size="14" />
                        <span>{{ activeActionLabel(instance, "stop", t("instances.actions.stop")) }}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem v-if="canShowInstanceAction(instance, 'restart')" class="instance-action-item" :disabled="isInstanceActionBusy(instance)" @select="$emit('runAction', 'restart', instance)">
                        <RotateCw :size="14" />
                        <span>{{ activeActionLabel(instance, "restart", t("instances.actions.restart")) }}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem v-if="canShowInstanceAction(instance, 'retry-image')" class="instance-action-item" :disabled="isInstanceActionBusy(instance)" @select="$emit('runAction', 'retry-image', instance)">
                        <RotateCw :size="14" />
                        <span>{{ activeActionLabel(instance, "retry-image", t("instances.actions.retryImage")) }}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem class="instance-action-item" @select="$emit('openConfigSync', 'import', instance)">
                        <Download :size="14" />
                        <span>{{ t("instances.actions.importConfig") }}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem class="instance-action-item" :disabled="!canExportConfig(instance)" @select="$emit('openConfigSync', 'export', instance)">
                        <Upload :size="14" />
                        <span>{{ t("instances.actions.exportConfig") }}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem class="instance-action-item" @select="$emit('openSettings', instance.id)">
                        <Settings :size="14" />
                        <span>{{ t("navigation.settings") }}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem class="instance-action-item" @select="$emit('openWindow', instance)">
                        <ExternalLink :size="14" />
                        <span>{{ t("instances.window.openInNewWindow") }}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem class="instance-action-item" :disabled="instance.runtime?.type !== 'docker' || isInstanceActionBusy(instance)" @select="$emit('saveTemplate', instance)">
                        <PackagePlus :size="14" />
                        <span>{{ t("instances.actions.saveEnvironmentTemplate") }}</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem class="instance-action-item danger" :disabled="isInstanceActionBusy(instance)" @select="$emit('runAction', 'delete', instance)">
                        <Trash2 :size="14" />
                        <span>{{ activeActionLabel(instance, "delete", t("instances.actions.delete")) }}</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent class="instance-action-menu">
              <ContextMenuItem v-if="canShowInstanceAction(instance, 'start')" class="instance-action-item" :disabled="isInstanceActionBusy(instance)" @select="$emit('runAction', 'start', instance)">
                <Play :size="14" />
                <span>{{ activeActionLabel(instance, "start", t("instances.actions.start")) }}</span>
              </ContextMenuItem>
              <ContextMenuItem v-if="canShowInstanceAction(instance, 'stop')" class="instance-action-item" :disabled="isInstanceActionBusy(instance)" @select="$emit('runAction', 'stop', instance)">
                <Square :size="14" />
                <span>{{ activeActionLabel(instance, "stop", t("instances.actions.stop")) }}</span>
              </ContextMenuItem>
              <ContextMenuItem v-if="canShowInstanceAction(instance, 'restart')" class="instance-action-item" :disabled="isInstanceActionBusy(instance)" @select="$emit('runAction', 'restart', instance)">
                <RotateCw :size="14" />
                <span>{{ activeActionLabel(instance, "restart", t("instances.actions.restart")) }}</span>
              </ContextMenuItem>
              <ContextMenuItem v-if="canShowInstanceAction(instance, 'retry-image')" class="instance-action-item" :disabled="isInstanceActionBusy(instance)" @select="$emit('runAction', 'retry-image', instance)">
                <RotateCw :size="14" />
                <span>{{ activeActionLabel(instance, "retry-image", t("instances.actions.retryImage")) }}</span>
              </ContextMenuItem>
              <ContextMenuItem class="instance-action-item" @select="$emit('openConfigSync', 'import', instance)">
                <Download :size="14" />
                <span>{{ t("instances.actions.importConfig") }}</span>
              </ContextMenuItem>
              <ContextMenuItem class="instance-action-item" :disabled="!canExportConfig(instance)" @select="$emit('openConfigSync', 'export', instance)">
                <Upload :size="14" />
                <span>{{ t("instances.actions.exportConfig") }}</span>
              </ContextMenuItem>
              <ContextMenuItem class="instance-action-item" @select="$emit('openSettings', instance.id)">
                <Settings :size="14" />
                <span>{{ t("instances.actions.settings") }}</span>
              </ContextMenuItem>
              <ContextMenuItem class="instance-action-item" @select="$emit('openWindow', instance)">
                <ExternalLink :size="14" />
                <span>{{ t("instances.window.openInNewWindow") }}</span>
              </ContextMenuItem>
              <ContextMenuItem class="instance-action-item danger" :disabled="isInstanceActionBusy(instance)" @select="$emit('runAction', 'delete', instance)">
                <Trash2 :size="14" />
                <span>{{ activeActionLabel(instance, "delete", t("instances.actions.delete")) }}</span>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          </template>
        </template>
        <div v-if="!instances.length && !loading" class="list-empty">{{ t("instances.list.noMatches") }}</div>
        <div v-if="hasPendingNodes && !groupByNode" class="instance-list-pending">
          <LoaderCircle :size="13" aria-hidden="true" />
          {{ t("instances.list.nodesStillLoading") }}
        </div>
        </div>
      </ScrollArea>
    </template>
    <button v-if="!collapsed && !embedded" type="button" class="instance-resize-handle" :aria-label="t('instances.list.resizeSidebar')" :title="t('instances.list.resize')" @pointerdown="$emit('resizeStart', $event)" />
  </aside>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Boxes, ChevronRight, Container, Download, ExternalLink, Laptop, LoaderCircle, MoreHorizontal, PackagePlus, PanelLeftClose, PanelLeftOpen, Play, Plus, RotateCw, Search, Server, Settings, Square, Trash2, Upload } from "@lucide/vue";
import type { InstanceBoardItem, Node, NodeFleetResourceState } from "../../../api/types";
import type { ConfigSyncDirection } from "@task-handoff/protocol/config-sync";
import { Button } from "../../../components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../../components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";
import type { InstanceAction } from "../useInstanceActions";
import { canShowInstanceAction, imageProvisioningLabel, instanceSourceLabel } from "../useInstanceStatus";
import type { InstanceListSortMode } from "./useWorkbenchInstances";
import InstanceViewOptionsMenu from "../shared/InstanceViewOptionsMenu.vue";

const { t } = useI18n();

defineOptions({ name: "InstanceList" });

const props = defineProps<{
  activeActionLabel: (instance: InstanceBoardItem, action: InstanceAction, idleLabel: string) => string;
  activeInstanceId?: string;
  canExportConfig: (instance: InstanceBoardItem) => boolean;
  collapsed: boolean;
  embedded?: boolean;
  error?: string;
  filter: string;
  groupByNode: boolean;
  instanceDisplayName: (instance: InstanceBoardItem) => string;
  instances: InstanceBoardItem[];
  isInstanceActionBusy: (instance: InstanceBoardItem) => boolean;
  loading: boolean;
  nodeStates?: NodeFleetResourceState[];
  nodes: Node[];
  openMenuId: string;
  sortMode: InstanceListSortMode;
  totalInstances: number;
}>();

const emit = defineEmits<{
  collapse: [];
  expand: [];
  newInstance: [];
  openSettings: [instanceId: string];
  openWindow: [instance: InstanceBoardItem];
  saveTemplate: [instance: InstanceBoardItem];
  resizeStart: [event: PointerEvent];
  runAction: [action: InstanceAction, instance: InstanceBoardItem];
  openConfigSync: [direction: ConfigSyncDirection, instance: InstanceBoardItem];
  selectInstance: [instanceId: string, source?: "click" | "contextmenu"];
  setMenuOpen: [instanceId: string, open: boolean];
  "update:filter": [value: string];
  "update:groupByNode": [value: boolean];
  "update:sortMode": [value: InstanceListSortMode];
}>();

const temporaryListOpen = ref(false);

function instanceNodeLabel(instance: InstanceBoardItem) {
  return instance.node?.name || instance.nodeId;
}

function instanceRuntimeLabel(instance: InstanceBoardItem) {
  if (instance.runtime?.type === "local") {
    return t("instances.list.localRuntime");
  }
  if (instance.runtime?.type === "docker") {
    return t("instances.list.dockerRuntime");
  }
  return t("instances.list.kubernetesRuntime");
}

const collapsedGroups = reactive<Record<string, boolean>>({});
const instanceNodeStates = computed(() => new Map((props.nodeStates || [])
  .filter((state) => state.resource === "instances")
  .map((state) => [state.nodeId, state])));
const hasPendingNodes = computed(() => props.nodes.some((node) => {
  const phase = instanceNodeStates.value.get(node.id)?.phase;
  return phase === "uninitialized" || phase === "loading";
}));

const instanceGroups = computed(() => {
  if (!props.groupByNode) {
    return [{ key: "__all__", label: t("instances.board.allNodes"), instances: props.instances }];
  }
  const groups = new Map<string, { key: string; label: string; instances: InstanceBoardItem[]; connectionPhase?: Node["connectionPhase"]; resourcePhase?: NodeFleetResourceState["phase"]; connectionLabel?: string }>();
  for (const node of props.nodes) {
    const resourceState = instanceNodeStates.value.get(node.id);
    const connectionLabel = resourceState?.phase === "uninitialized" || resourceState?.phase === "loading"
      ? t("instances.list.nodeLoading")
      : resourceState?.phase === "stale"
        ? t("instances.list.nodeStale")
        : resourceState?.phase === "error"
          ? t("instances.list.nodeLoadFailed")
          : node.connectionPhase === "connecting" || node.connectionPhase === "handshaking"
      ? t("instances.list.nodeConnecting")
      : node.connectionPhase === "reconnecting"
        ? t("instances.list.nodeReconnecting")
        : undefined;
    groups.set(node.id, { key: node.id, label: node.name || node.id, instances: [], connectionPhase: node.connectionPhase, resourcePhase: resourceState?.phase, connectionLabel });
  }
  for (const instance of props.instances) {
    const key = instance.nodeId || "__unknown__";
    const node = props.nodes.find((candidate) => candidate.id === key);
    const current = groups.get(key) || { key, label: instanceNodeLabel(instance), instances: [], connectionPhase: node?.connectionPhase, resourcePhase: instanceNodeStates.value.get(key)?.phase };
    current.instances.push(instance);
    groups.set(key, current);
  }
  return [...groups.values()];
});

watch(
  instanceGroups,
  (groups) => {
    const activeKeys = new Set(groups.map((group) => group.key));
    for (const key of Object.keys(collapsedGroups)) {
      if (!activeKeys.has(key)) {
        delete collapsedGroups[key];
      }
    }
  },
  { immediate: true },
);

function toggleGroup(key: string) {
  collapsedGroups[key] = !collapsedGroups[key];
}

function selectTemporaryInstance(instanceId: string, source?: "click" | "contextmenu") {
  if (source !== "contextmenu") {
    temporaryListOpen.value = false;
  }
  emit("selectInstance", instanceId, source);
}

function expandTemporaryList() {
  temporaryListOpen.value = false;
  emit("expand");
}

function openNewInstanceFromTemporaryList() {
  temporaryListOpen.value = false;
  emit("newInstance");
}
</script>

<style scoped>
.instance-list {
  display: grid;
  position: relative;
  grid-template-rows: auto auto minmax(0, 1fr);
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--line);
  background: linear-gradient(180deg, var(--surface) 0%, var(--surface-inset) 100%);
  color: var(--terminal-text);
  box-shadow: inset -1px 0 0 var(--workspace-grid);
  padding: 12px;
}

.instance-list.collapsed {
  grid-template-rows: minmax(0, 1fr);
  padding: 8px;
}

.instance-resize-handle {
  position: absolute;
  top: 0;
  right: -5px;
  z-index: 20;
  width: 10px;
  height: 100%;
  border: 0;
  background: transparent;
  cursor: col-resize;
  padding: 0;
}

.instance-resize-handle::after {
  display: block;
  width: 2px;
  height: 100%;
  margin: 0 auto;
  background: transparent;
  content: "";
}

.instance-resize-handle:hover::after,
.instance-resize-handle:focus-visible::after {
  background: var(--brand-accent);
}

:global(body.instances-resizing .instance-resize-handle::after) {
  background: var(--brand-accent);
}

.instance-resize-handle:focus-visible {
  outline: none;
}

:global(body.instances-resizing),
:global(body.instances-resizing *) {
  cursor: col-resize !important;
  user-select: none;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.list-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.list-head div {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.list-head .list-head-actions {
  align-items: center;
  gap: 6px;
}

.list-head span {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 750;
}

.list-head strong {
  color: var(--text-strong);
  font-size: 18px;
}

.icon-button {
  width: 32px;
  padding: 0;
}

.list-head-actions :deep(.icon-button:not(.bg-primary)) {
  border-color: var(--control-plane-icon-button-border);
  background: var(--control-plane-icon-button-bg);
  color: var(--control-plane-icon-button-text);
}

.list-head-actions :deep(.icon-button:not(.bg-primary):hover),
.list-head-actions :deep(.icon-button:not(.bg-primary):focus-visible) {
  border-color: var(--control-plane-icon-button-hover-border);
  background: var(--control-plane-icon-button-hover-bg);
  color: var(--control-plane-icon-button-hover-text);
}

.instances-expand-rail {
  display: grid;
  align-content: start;
  justify-items: center;
  width: 36px;
  min-height: 100%;
  gap: 8px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-hover);
  color: var(--text-muted);
  cursor: pointer;
  padding: 10px 0;
}

.instances-expand-rail:hover,
.instances-expand-rail:focus-visible,
.instances-expand-rail[data-state="open"] {
  border-color: var(--brand-accent);
  background: var(--surface-active);
  outline: none;
}

.instances-expand-rail span {
  writing-mode: vertical-rl;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0;
  text-transform: uppercase;
}

.instances-expand-rail strong {
  color: var(--text-strong);
  font-size: 13px;
}

:global(.instances-temporary-popover) {
  width: var(--instances-width, 292px) !important;
  height: var(--reka-popover-trigger-height);
  overflow: hidden;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  padding: 0 !important;
}

:global(.instances-temporary-list) {
  width: 100%;
  height: 100%;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  box-shadow: var(--shadow-popover);
}

.list-filter {
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  min-height: 34px;
  margin-bottom: 10px;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--surface-hover);
  color: var(--text-strong);
  padding: 0 9px;
}

.list-filter input {
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--text-strong);
  font-size: 13px;
  outline: none;
}

.list-filter input::placeholder {
  color: var(--text-subtle);
}

.instance-rows {
  min-height: 0;
}

.instance-rows-content {
  min-height: 100%;
  padding-right: 2px;
}

.instance-group-status {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 4px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
}

.instance-group-status svg {
  flex: 0 0 auto;
  animation: instance-group-connecting-spin 900ms linear infinite;
}

.instance-list-pending {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 400;
  padding: 8px 4px 4px;
}

.instance-list-pending svg {
  flex: 0 0 auto;
  animation: instance-group-connecting-spin 900ms linear infinite;
}

@keyframes instance-group-connecting-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .instance-group-status svg,
  .instance-list-pending svg {
    animation: none;
  }
}

.instance-row {
  display: grid;
  position: relative;
  grid-template-columns: minmax(0, 1fr) auto;
  align-self: start;
  width: 100%;
  gap: 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--instance-list-row-bg);
  color: inherit;
  margin-bottom: 7px;
  padding: 0;
}

.instance-row:hover,
.instance-row:focus-within,
.instance-row.active {
  border-color: var(--instance-list-row-border);
  background: var(--instance-list-row-hover-bg);
  outline: none;
}

.instance-row.active {
  box-shadow: inset 3px 0 0 var(--brand-accent);
}

.instance-row-content {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  min-width: 0;
  gap: 2px 9px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 10px;
  text-align: left;
}

.instance-row-content:focus-visible {
  outline: none;
}

.instance-row-actions {
  position: relative;
  z-index: 2;
  display: grid;
  align-self: center;
  justify-self: end;
  padding-right: 8px;
}

.instance-menu-trigger {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  background: var(--surface-hover);
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transform: translateX(4px);
  transition:
    opacity 120ms ease,
    transform 120ms ease,
    background 120ms ease,
    color 120ms ease;
}

.instance-row:hover .instance-menu-trigger,
.instance-row:focus-within .instance-menu-trigger,
.instance-row-actions.open .instance-menu-trigger {
  opacity: 1;
  transform: translateX(0);
}

.instance-menu-trigger:hover,
.instance-menu-trigger:focus-visible,
.instance-row-actions.open .instance-menu-trigger {
  border-color: var(--control-plane-icon-button-hover-border);
  background: var(--control-plane-icon-button-hover-bg);
  color: var(--control-plane-icon-button-hover-text);
  outline: none;
}

.instance-action-menu {
  display: grid;
  width: 158px;
  gap: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-inset);
  box-shadow: var(--shadow-popover);
  padding: 5px;
}

.instance-group-label {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto 16px auto;
  align-items: center;
  width: 100%;
  min-height: 32px;
  gap: 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-strong);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 750;
  margin: 4px 0 3px;
  padding: 0 4px 0 0;
  text-align: left;
}

.instance-group-label:first-child {
  margin-top: 0;
}

.instance-group-label:hover,
.instance-group-label:focus-visible {
  background: var(--surface-hover);
  outline: none;
}

.instance-group-label span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.instance-group-icon {
  justify-self: center;
  color: var(--text-muted);
}

.instance-group-name {
  grid-column: 2;
}

.instance-group-status {
  grid-column: 3;
}

.instance-group-chevron {
  grid-column: 4;
  color: var(--text-muted);
  transform: rotate(0deg);
  transition: transform 120ms ease;
}

.instance-group-chevron.open {
  transform: rotate(90deg);
}

.instance-group-label strong {
  grid-column: 5;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.instance-action-submenu {
  display: grid;
  width: 132px;
  gap: 2px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-inset);
  box-shadow: var(--shadow-popover);
  padding: 5px;
}

.instance-action-item {
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
  padding: 0 8px;
  text-align: left;
}

.instance-action-item span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.instance-action-item svg:last-child:not(:first-child) {
  margin-left: auto;
  color: var(--text-subtle);
}

.instance-action-item:hover,
.instance-action-item:focus-visible,
.instance-action-item[data-highlighted],
.instance-action-item[data-state="open"] {
  background: var(--surface-active);
  color: var(--control-plane-menu-hover-text);
  outline: none;
}

.instance-action-item.danger {
  color: var(--status-danger);
}

.instance-action-item.danger:hover,
.instance-action-item.danger:focus-visible,
.instance-action-item.danger[data-highlighted] {
  background: var(--status-danger-bg);
  color: var(--status-danger);
}

.instance-action-item[data-disabled] {
  cursor: default;
  opacity: 0.52;
}

.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--text-subtle);
  margin-top: 5px;
}

.status-dot[data-state="online"] {
  background: var(--brand-accent);
  box-shadow: 0 0 14px var(--focus-ring);
}

.status-dot[data-state="offline"] {
  background: var(--status-warning);
}

.status-dot[data-state="endpoint-unreachable"] {
  background: var(--status-danger);
}

.instance-row-main {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.instance-row-title {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
}

.instance-runtime-icon {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--text-muted);
}

.instance-row-main strong,
.instance-row-main small,
.instance-row-session {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.instance-row-main strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--instance-list-title);
  font-size: 13px;
  font-weight: 750;
}

.instance-row-main small,
.instance-row-session,
.list-empty {
  color: var(--instance-list-meta);
  font-size: 11px;
}

.instance-row-main .image-provisioning-status {
  color: var(--status-warning);
}

.instance-row-session {
  grid-column: 2;
}

.list-empty {
  align-self: start;
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
  background: var(--instance-list-empty-bg);
  color: var(--instance-list-empty-text);
  padding: 12px;
}

.list-empty.error {
  color: var(--status-danger);
}

@media (max-width: 780px) {
  .instance-list {
    display: none;
  }
}
</style>
