<template>
  <section class="instance-detail" :aria-label="t('instances.detail.label')">
    <div v-if="error" class="detail-empty error">{{ error }}</div>
    <div v-else-if="instance" class="instance-detail-layout" :class="{ 'preview-expanded': previewExpanded }">
      <header v-if="!previewExpanded" ref="detailHeadEl" class="detail-head">
        <div class="detail-identity">
          <div
            class="detail-name-field"
            :class="{ editing: editingNameId === instance.id }"
            :style="editingNameId === instance.id && editNameWidth ? { '--detail-name-edit-width': `${editNameWidth}px` } : undefined"
          >
            <input
              v-if="editingNameId === instance.id"
              ref="nameInput"
              v-model="instanceNameDraft"
              class="detail-name-input"
              :aria-label="t('instances.detail.editName', { name: instanceDisplayName(instance) })"
              :disabled="savingName"
              @blur="commitNameEdit"
              @keydown="handleNameEditKeydown"
            />
            <button
              v-else
              type="button"
              class="detail-name-button"
              :aria-label="t('instances.detail.editName', { name: instanceDisplayName(instance) })"
              :title="t('instances.detail.editNameTitle')"
              @click="beginNameEdit(instance, $event)"
            >
              <span class="detail-name-button-label">{{ instanceDisplayName(instance) }}</span>
            </button>
          </div>
          <TooltipProvider :delay-duration="120">
            <div class="detail-meta">
              <ContextMenu v-if="canOpenInstanceSourceFolder">
                <ContextMenuTrigger as-child>
                  <button type="button" class="detail-meta-folder" @click="openInstanceSourceFolder">
                    <Tooltip>
                      <TooltipTrigger as-child>
                        <span class="detail-meta-item"><Folder :size="14" aria-hidden="true" /><span>{{ instanceSourceLabel(instance, t) }}</span></span>
                      </TooltipTrigger>
                      <TooltipContent class="instance-detail-meta-tooltip" side="top" :side-offset="8">{{ instanceSourceLocation(instance) }}</TooltipContent>
                    </Tooltip>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent class="ai-session-context-menu">
                  <ContextMenuItem class="ai-session-path-group-menu-item" @select="openInstanceSourceFolder">
                    <FolderOpen :size="14" />
                    <span>{{ t("sessions.panel.openInFileManager") }}</span>
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              <Tooltip v-else>
                <TooltipTrigger as-child>
                  <span class="detail-meta-item"><Folder :size="14" aria-hidden="true" /><span>{{ instanceSourceLabel(instance, t) }}</span></span>
                </TooltipTrigger>
                <TooltipContent class="instance-detail-meta-tooltip" side="top" :side-offset="8">{{ instanceSourceLocation(instance) }}</TooltipContent>
              </Tooltip>

              <template v-if="instanceImageLabel(instance)">
                <span class="detail-meta-separator" aria-hidden="true">·</span>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <span class="detail-meta-item"><Package :size="14" aria-hidden="true" /><span>{{ instanceImageLabel(instance) }}</span></span>
                  </TooltipTrigger>
                  <TooltipContent class="instance-detail-meta-tooltip" side="top" :side-offset="8">{{ instanceImageTooltip(instance) }}</TooltipContent>
                </Tooltip>
              </template>

              <span class="detail-meta-separator" aria-hidden="true">·</span>
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="detail-meta-item"><Server :size="14" aria-hidden="true" /><span>{{ instanceNodeLabel(instance) }}</span></span>
                </TooltipTrigger>
                <TooltipContent class="instance-detail-meta-tooltip" side="top" :side-offset="8">{{ instance.nodeId }}</TooltipContent>
              </Tooltip>

              <span class="detail-meta-separator" aria-hidden="true">·</span>
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="detail-meta-item"><Box :size="14" aria-hidden="true" /><span>{{ instanceRuntimeLabel(instance) }}</span></span>
                </TooltipTrigger>
                <TooltipContent class="instance-detail-meta-tooltip" side="top" :side-offset="8">{{ instanceRuntimeTooltip(instance) }}</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
          <span v-if="instance.imageProvisioning && instance.imageProvisioning.phase !== 'ready' && !instance.imagePullProgress" class="image-provisioning-status">
            {{ imageProvisioningLabel(instance, t) }}<template v-if="instance.imageProvisioning.error"> · {{ instance.imageProvisioning.error }}</template>
          </span>
        </div>
        <div ref="detailSideEl" class="detail-side">
          <TooltipProvider :delay-duration="120">
            <div class="detail-badges">
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="diagnostic-badge" :aria-label="buildTitle(instance)">
                <Badge :variant="instance.access.status === 'reachable' || instance.connectionStatus === 'online' ? 'default' : 'secondary'">{{ connectionStatusLabel(instance.connectionStatus) }}</Badge>
                  </span>
                </TooltipTrigger>
                <TooltipContent class="diagnostic-tooltip" align="end" side="bottom">
                  <div class="diagnostic-tooltip-grid">
                    <span><b>{{ t("instances.detail.protocol") }}</b><em>{{ instance.protocolVersion || instance.build?.protocolVersion || t("common.status.unknown") }}</em></span>
                    <span><b>{{ t("instances.detail.build") }}</b><em>{{ buildLabel(instance) }}</em></span>
                    <span><b>{{ t("instances.detail.package") }}</b><em>{{ packageLabel(instance) }}</em></span>
                    <span v-if="instance.build?.imageRef"><b>{{ t("instances.detail.image") }}</b><em>{{ instance.build.imageRef }}</em></span>
                    <span v-if="instance.build?.builtAt"><b>{{ t("instances.detail.built") }}</b><em>{{ instance.build.builtAt }}</em></span>
                  </div>
                </TooltipContent>
              </Tooltip>
              <Badge variant="secondary">{{ instanceStatusLabel(instance.status) }}</Badge>
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="diagnostic-badge" :aria-label="buildTitle(instance)">
                    <Badge :variant="instance.protocolCompatible ? 'secondary' : 'destructive'">
                      {{ instance.protocolCompatible ? t("instances.detail.protocolOk") : t("instances.detail.protocolMismatch") }}
                    </Badge>
                  </span>
                </TooltipTrigger>
                <TooltipContent class="diagnostic-tooltip" align="end" side="bottom">
                  <div class="diagnostic-tooltip-grid">
                    <span><b>{{ t("instances.detail.protocol") }}</b><em>{{ instance.protocolVersion || instance.build?.protocolVersion || t("common.status.unknown") }}</em></span>
                    <span><b>{{ t("instances.detail.build") }}</b><em>{{ buildLabel(instance) }}</em></span>
                    <span><b>{{ t("instances.detail.package") }}</b><em>{{ packageLabel(instance) }}</em></span>
                    <span v-if="instance.build?.imageRef"><b>{{ t("instances.detail.image") }}</b><em>{{ instance.build.imageRef }}</em></span>
                    <span v-if="instance.build?.builtAt"><b>{{ t("instances.detail.built") }}</b><em>{{ instance.build.builtAt }}</em></span>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
          <TooltipProvider :delay-duration="120">
            <div ref="instanceControlsEl" class="instance-controls" :class="{ compact: compactInstanceControls }" :aria-label="t('instances.detail.controls')">
              <Tooltip v-if="!standalone">
                <TooltipTrigger as-child>
                  <Button variant="outline" size="icon-sm" :aria-label="t('instances.window.openInNewWindow')" @click="$emit('openWindow', instance)">
                    <ExternalLink :size="14" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{{ t("instances.window.openInNewWindow") }}</TooltipContent>
              </Tooltip>
              <Tooltip v-if="canShowInstanceAction(instance, 'start')">
                <TooltipTrigger as-child>
                  <Button variant="outline" size="sm" :aria-label="activeActionLabel(instance, 'start', t('instances.actions.start'))" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'start', instance)">
                    <Play :size="14" />
                    <span class="instance-action-label">{{ activeActionLabel(instance, "start", t("instances.actions.start")) }}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{{ activeActionLabel(instance, "start", t("instances.actions.start")) }}</TooltipContent>
              </Tooltip>
              <Tooltip v-if="canShowInstanceAction(instance, 'stop')">
                <TooltipTrigger as-child>
                  <Button variant="outline" size="sm" :aria-label="activeActionLabel(instance, 'stop', t('instances.actions.stop'))" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'stop', instance)">
                    <Square :size="14" />
                    <span class="instance-action-label">{{ activeActionLabel(instance, "stop", t("instances.actions.stop")) }}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{{ activeActionLabel(instance, "stop", t("instances.actions.stop")) }}</TooltipContent>
              </Tooltip>
              <Tooltip v-if="canShowInstanceAction(instance, 'restart')">
                <TooltipTrigger as-child>
                  <Button variant="outline" size="sm" :aria-label="activeActionLabel(instance, 'restart', t('instances.actions.restart'))" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'restart', instance)">
                    <RotateCw :size="14" />
                    <span class="instance-action-label">{{ activeActionLabel(instance, "restart", t("instances.actions.restart")) }}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{{ activeActionLabel(instance, "restart", t("instances.actions.restart")) }}</TooltipContent>
              </Tooltip>
              <Tooltip v-if="canShowInstanceAction(instance, 'retry-image')">
                <TooltipTrigger as-child>
                  <Button variant="outline" size="sm" :aria-label="activeActionLabel(instance, 'retry-image', t('instances.actions.retryImage'))" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'retry-image', instance)">
                    <RotateCw :size="14" />
                    <span class="instance-action-label">{{ activeActionLabel(instance, "retry-image", t("instances.actions.retryImage")) }}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{{ activeActionLabel(instance, "retry-image", t("instances.actions.retryImage")) }}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button variant="outline" size="sm" :aria-label="t('instances.actions.settings')" @click="$emit('openSettings', instance.id)">
                    <Settings :size="14" />
                    <span class="instance-action-label">{{ t("instances.actions.settings") }}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{{ t("instances.actions.settings") }}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger as-child>
                  <Button variant="destructive" size="sm" :aria-label="activeActionLabel(instance, 'delete', t('instances.actions.delete'))" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'delete', instance)">
                    <Trash2 :size="14" />
                    <span class="instance-action-label">{{ activeActionLabel(instance, "delete", t("instances.actions.delete")) }}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{{ activeActionLabel(instance, "delete", t("instances.actions.delete")) }}</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>
      </header>
      <SessionPreview
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
        :app-launch-menu-open="appLaunchMenuOpen"
        :can-launch-app="canLaunchApp"
        :copied-text="copiedText"
        :choose-project-folder="chooseProjectFolder"
        :instance="instance"
        :instance-sidebar-visible="instanceSidebarVisible"
        :is-instance-action-busy="isInstanceActionBusy"
        :launchable-apps="launchableApps"
        :launching-app="launchingApp"
        :last-refresh-label="lastRefreshLabel"
        :left-session="leftSession"
        :left-session-key="leftSessionKey"
        :left-session-tabs="leftSessionTabs"
        :node-local-folders="nodeLocalFolders"
        :preview-expanded="previewExpanded"
        :resource-metrics="resourceMetrics"
        :resource-metrics-error="resourceMetricsError"
        :right-session="rightSession"
        :right-session-key="rightSessionKey"
        :right-session-tabs="rightSessionTabs"
        :focused-session-pane="focusedSessionPane"
        :has-session-split="hasSessionSplit"
        :session-split-ratio="sessionSplitRatio"
        :rename-session="renameSession"
        :selected-ai-session="selectedAiSession"
        :ordered-session-tabs="orderedSessionTabs"
        :session-menu-open="sessionMenuOpen"
        :session-tabs="sessionTabs"
        :stopping-session-id="stoppingSessionId"
        :standalone="standalone"
        :toolbar-target="sessionToolbarTarget"
        @copy-registration="$emit('copyRegistration', $event)"
        @launch-app="(target, appId, cwdFolderId, options) => $emit('launchApp', target, appId, cwdFolderId, options)"
        @move-session-tab="(sourceKey, targetKey, placement, targetPane) => $emit('moveSessionTab', sourceKey, targetKey, placement, targetPane)"
        @move-session-to-pane="(sessionKey, pane) => $emit('moveSessionToPane', sessionKey, pane)"
        @focus-session-pane="$emit('focusSessionPane', $event)"
        @open-session-split="$emit('openSessionSplit')"
        @close-session-split="$emit('closeSessionSplit')"
        @set-session-split-ratio="$emit('setSessionSplitRatio', $event)"
        @open-ai-session-app="(target, session) => $emit('openAiSessionApp', target, session)"
        @open-repository-workspace="$emit('openRepositoryWorkspace', $event)"
        @open-settings="(instanceId, section) => $emit('openSettings', instanceId, section)"
        @open-url="$emit('openUrl', $event)"
        @run-action="(action, target) => $emit('runAction', action, target)"
        @select-ai-session="(instanceId, sessionId) => $emit('selectAiSession', instanceId, sessionId)"
        @select-session="(sessionKey, pane) => $emit('selectSession', sessionKey, pane)"
        @stop-session="(target, session) => $emit('stopSession', target, session)"
        @update:app-launch-menu-open="$emit('update:appLaunchMenuOpen', $event)"
        @update:instance-sidebar-visible="$emit('update:instanceSidebarVisible', $event)"
        @update:preview-expanded="$emit('update:previewExpanded', $event)"
        @update:session-menu-open="$emit('update:sessionMenuOpen', $event)"
      />

    </div>

    <section v-else-if="!loading" class="detail-empty">
      <h1>{{ t("instances.detail.emptyTitle") }}</h1>
      <p>{{ t("instances.detail.emptyDescription") }}</p>
      <Button v-if="!standalone" size="sm" @click="$emit('newInstance')">
        <Plus :size="15" />
        <span>{{ t("instances.list.new") }}</span>
      </Button>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Box, ExternalLink, Folder, FolderOpen, Package, Play, Plus, RotateCw, Server, Settings, Square, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import type { AiSessionSummary, InstanceBoardItem, InstanceResourceMetrics, InstanceWithAiSessions, NodeLocalFolder } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../../components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import SessionPreview from "./SessionPreview.vue";
import type { InstanceAction } from "../useInstanceActions";
import { canShowInstanceAction, imageProvisioningLabel, instanceSourceLabel } from "../useInstanceStatus";
import type { LaunchableApp, RepositoryWorkspaceTabTarget, SessionTab } from "../useInstanceSessions";
import type { SessionPaneId } from "./useActiveInstanceSessions";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { connectionStatusKeys, instanceStatusKeys, translateStatus } from "../../../i18n/status";
import { translateApiError } from "../../../i18n/apiError";
import type { NativeNodeFolderPicker } from "../nodePath";
import { desktopRuntimePathAccess } from "../../../components/ai-session/useAiSessionMentions";
import { canOpenDesktopLocalPath, openDesktopLocalPath } from "../../../lib/desktopBridge";

const { t } = useI18n();
const instanceStatusLabel = (status: string) => translateStatus(instanceStatusKeys, status, t);
const connectionStatusLabel = (status: string) => translateStatus(connectionStatusKeys, status, t);

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
  chooseProjectFolder?: NativeNodeFolderPicker;
  error?: string;
  instance?: InstanceWithAiSessions;
  instanceDisplayName: (instance: InstanceBoardItem) => string;
  instanceSidebarVisible?: boolean;
  isInstanceActionBusy: (instance: InstanceBoardItem) => boolean;
  lastRefreshLabel: string;
  leftSession?: SessionTab;
  leftSessionKey: string;
  leftSessionTabs: SessionTab[];
  launchableApps: LaunchableApp[];
  launchingApp: boolean;
  nodeLocalFolders?: NodeLocalFolder[];
  loading: boolean;
  previewExpanded: boolean;
  resourceMetrics?: InstanceResourceMetrics;
  resourceMetricsError?: string;
  rightSession?: SessionTab;
  rightSessionKey: string;
  rightSessionTabs: SessionTab[];
  focusedSessionPane: SessionPaneId;
  hasSessionSplit: boolean;
  sessionSplitRatio: number;
  renameInstance: (instance: InstanceBoardItem, name: string) => Promise<void>;
  renameSession: (instance: InstanceBoardItem, session: SessionTab, title: string) => Promise<void>;
  selectedAiSession: (instance: InstanceBoardItem, sessions?: AiSessionSummary[]) => AiSessionSummary | undefined;
  orderedSessionTabs: SessionTab[];
  sessionMenuOpen: boolean;
  sessionTabs: SessionTab[];
  stoppingSessionId: string;
  standalone?: boolean;
  sessionToolbarTarget?: string;
}>();

defineEmits<{
  copyRegistration: [instance: InstanceBoardItem];
  launchApp: [instance: InstanceBoardItem, appId: string, cwdFolderId?: string, options?: Record<string, unknown>];
  moveSessionTab: [sourceKey: string, targetKey: string, placement: "before" | "after", targetPane?: SessionPaneId];
  moveSessionToPane: [sessionKey: string, pane: SessionPaneId];
  focusSessionPane: [pane: SessionPaneId];
  openSessionSplit: [];
  closeSessionSplit: [];
  setSessionSplitRatio: [ratio: number];
  newInstance: [];
  openAiSessionApp: [instance: InstanceBoardItem, session?: AiSessionSummary];
  openRepositoryWorkspace: [target: RepositoryWorkspaceTabTarget];
  openWindow: [instance: InstanceBoardItem];
  openSettings: [instanceId: string, section?: "general" | "ai" | "models" | "apps"];
  openUrl: [url: string];
  runAction: [action: InstanceAction, instance: InstanceBoardItem];
  selectAiSession: [instanceId: string, sessionId: string];
  selectSession: [sessionKey: string, pane?: SessionPaneId];
  stopSession: [instance: InstanceBoardItem, session: SessionTab];
  "update:appLaunchMenuOpen": [open: boolean];
  "update:instanceSidebarVisible": [visible: boolean];
  "update:previewExpanded": [expanded: boolean];
  "update:sessionMenuOpen": [open: boolean];
}>();

const editingNameId = ref("");
const instanceNameDraft = ref("");
const nameInput = ref<HTMLInputElement | null>(null);
const savingName = ref(false);
const editNameWidth = ref(0);
const detailHeadEl = ref<HTMLElement | null>(null);
const detailSideEl = ref<HTMLElement | null>(null);
const instanceControlsEl = ref<HTMLElement | null>(null);
const compactInstanceControls = ref(false);
let instanceControlsResizeObserver: ResizeObserver | undefined;
let instanceControlsExpandAtWidth = 0;
let instanceControlsLayoutFrame = 0;

function instanceControlsOverflowWidth() {
  const head = detailHeadEl.value;
  const controls = instanceControlsEl.value;
  if (!head || !controls) return 0;
  return Math.max(
    0,
    controls.scrollWidth - controls.clientWidth,
    controls.getBoundingClientRect().right - head.getBoundingClientRect().right,
  );
}

function syncInstanceControlsLayout(forceExpandedProbe = false) {
  const head = detailHeadEl.value;
  if (!head) return;
  const headWidth = head.clientWidth;
  if (compactInstanceControls.value) {
    if (!forceExpandedProbe && headWidth < instanceControlsExpandAtWidth) return;
    compactInstanceControls.value = false;
    void nextTick(() => syncInstanceControlsLayout());
    return;
  }
  const overflowWidth = instanceControlsOverflowWidth();
  if (overflowWidth > 1) {
    instanceControlsExpandAtWidth = headWidth + Math.ceil(overflowWidth) + 8;
    compactInstanceControls.value = true;
  } else {
    instanceControlsExpandAtWidth = 0;
  }
}

function scheduleInstanceControlsLayout(forceExpandedProbe = false) {
  if (instanceControlsLayoutFrame) cancelAnimationFrame(instanceControlsLayoutFrame);
  instanceControlsLayoutFrame = requestAnimationFrame(() => {
    instanceControlsLayoutFrame = 0;
    syncInstanceControlsLayout(forceExpandedProbe);
  });
}

watch([detailHeadEl, detailSideEl, instanceControlsEl], () => {
  instanceControlsResizeObserver?.disconnect();
  instanceControlsResizeObserver = undefined;
  const elements = [detailHeadEl.value, detailSideEl.value, instanceControlsEl.value].filter((element): element is HTMLElement => Boolean(element));
  if (typeof ResizeObserver !== "undefined" && elements.length) {
    instanceControlsResizeObserver = new ResizeObserver(() => scheduleInstanceControlsLayout());
    for (const element of elements) instanceControlsResizeObserver.observe(element);
  }
  scheduleInstanceControlsLayout(true);
}, { flush: "post" });

const visibleInstanceActionLabels = computed(() => {
  const instance = props.instance;
  if (!instance) return "";
  return (["start", "stop", "restart", "retry-image", "delete"] as const)
    .filter((action) => action === "delete" || canShowInstanceAction(instance, action))
    .map((action) => props.activeActionLabel(instance, action, t(`instances.actions.${action === "retry-image" ? "retryImage" : action}`)))
    .concat(t("instances.actions.settings"))
    .join("\u0000");
});

watch(visibleInstanceActionLabels, () => scheduleInstanceControlsLayout(true), { flush: "post" });

onBeforeUnmount(() => {
  instanceControlsResizeObserver?.disconnect();
  if (instanceControlsLayoutFrame) cancelAnimationFrame(instanceControlsLayoutFrame);
});

watch(
  () => props.instance?.id,
  () => {
    cancelNameEdit();
  },
);

watch(
  () => props.instance?.name,
  (name) => {
    if (!editingNameId.value) {
      instanceNameDraft.value = name || "";
    }
  },
);

async function beginNameEdit(instance: InstanceBoardItem, event?: MouseEvent) {
  if (savingName.value) {
    return;
  }
  editNameWidth.value = Math.ceil((event?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect().width || 0);
  editingNameId.value = instance.id;
  instanceNameDraft.value = props.instanceDisplayName(instance);
  await nextTick();
  if (!editNameWidth.value) {
    editNameWidth.value = Math.ceil(nameInput.value?.getBoundingClientRect().width || 0);
  }
  nameInput.value?.focus();
  nameInput.value?.select();
}

function cancelNameEdit() {
  editingNameId.value = "";
  instanceNameDraft.value = "";
  editNameWidth.value = 0;
}

function handleNameEditKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    void commitNameEdit();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelNameEdit();
  }
}

async function commitNameEdit() {
  if (!props.instance || !editingNameId.value || savingName.value) {
    return;
  }
  const nextName = instanceNameDraft.value.trim();
  if (!nextName || nextName === props.instance.name) {
    cancelNameEdit();
    return;
  }
  savingName.value = true;
  try {
    await props.renameInstance(props.instance, nextName);
    cancelNameEdit();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t, t("instances.detail.renameFailed")));
    await nextTick();
    nameInput.value?.focus();
  } finally {
    savingName.value = false;
  }
}

function buildLabel(instance: InstanceBoardItem) {
  return instance.build?.buildId || instance.build?.gitCommit?.slice(0, 12) || t("common.status.unknown");
}

function packageLabel(instance: InstanceBoardItem) {
  return instance.build?.packageVersion || instance.instanceVersion || t("common.status.unknown");
}

function instanceSourceLocation(instance: InstanceBoardItem) {
  return instance.source.type === "local-folder" ? instance.source.path : instance.source.url;
}

const canOpenInstanceSourceFolder = computed(() => Boolean(
  props.instance?.source.type === "local-folder"
  && instanceSourceLocation(props.instance)
  && desktopRuntimePathAccess(props.instance) === "desktop-local"
  && canOpenDesktopLocalPath()
));

async function openInstanceSourceFolder() {
  const instance = props.instance;
  if (!instance || !canOpenInstanceSourceFolder.value) return;
  const result = await openDesktopLocalPath(instanceSourceLocation(instance));
  if (!result.ok) showControlPlaneToast(t("sessions.panel.openInFileManagerFailed"));
}

function instanceImageLabel(instance: InstanceBoardItem) {
  return instance.image?.name || instance.imageSelection?.imageId || "";
}

function instanceImageTooltip(instance: InstanceBoardItem) {
  const image = instance.image;
  if (image && "requestedReference" in image) return image.requestedReference;
  if (image && "reference" in image) return image.reference;
  return instance.imageSelection?.imageId || "";
}

function instanceNodeLabel(instance: InstanceBoardItem) {
  return instance.node?.name || instance.nodeId;
}

function instanceRuntimeLabel(instance: InstanceBoardItem) {
  return instance.runtime?.name || instance.runtimeId;
}

function instanceRuntimeTooltip(instance: InstanceBoardItem) {
  return [instance.runtime?.type, instance.runtimeId].filter(Boolean).join(" · ");
}

function buildTitle(instance: InstanceBoardItem) {
  const build = instance.build;
  return [
    `${t("instances.detail.protocol")}: ${instance.protocolVersion || build?.protocolVersion || t("common.status.unknown")}`,
    `${t("instances.detail.build")}: ${buildLabel(instance)}`,
    `${t("instances.detail.package")}: ${packageLabel(instance)}`,
    build?.imageRef ? `${t("instances.detail.image")}: ${build.imageRef}` : undefined,
    build?.builtAt ? `${t("instances.detail.built")}: ${build.builtAt}` : undefined,
  ].filter(Boolean).join("\n");
}
</script>

<style scoped src="./InstanceDetail.css"></style>
