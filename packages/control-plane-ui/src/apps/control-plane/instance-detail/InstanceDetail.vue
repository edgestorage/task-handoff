<template>
  <section class="instance-detail" aria-label="Instance detail">
    <div v-if="loading" class="detail-empty">Loading control plane...</div>
    <div v-else-if="error" class="detail-empty error">{{ error }}</div>
    <div v-else-if="instance" class="instance-detail-layout" :class="{ 'preview-expanded': previewExpanded }">
      <header v-if="!previewExpanded" class="detail-head">
        <div>
          <p>{{ instanceSourceLabel(instance) }}</p>
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
              :aria-label="`Edit name for ${instanceDisplayName(instance)}`"
              :disabled="savingName"
              @blur="commitNameEdit"
              @keydown.enter.prevent="commitNameEdit"
              @keydown.esc.prevent="cancelNameEdit"
            />
            <button
              v-else
              type="button"
              class="detail-name-button"
              :aria-label="`Edit name for ${instanceDisplayName(instance)}`"
              title="Edit instance name"
              @click="beginNameEdit(instance, $event)"
            >
              <span class="detail-name-button-label">{{ instanceDisplayName(instance) }}</span>
            </button>
          </div>
          <span>{{ instance.image?.name || instance.imageId }} · {{ instance.node?.name || instance.nodeId }} / {{ instance.runtime?.name || instance.runtimeId }}</span>
          <span v-if="instance.imageProvisioning && instance.imageProvisioning.phase !== 'ready'" class="image-provisioning-status">
            {{ imageProvisioningLabel(instance) }}<template v-if="instance.imageProvisioning.error"> · {{ instance.imageProvisioning.error }}</template>
          </span>
        </div>
        <div class="detail-side">
          <TooltipProvider :delay-duration="120">
            <div class="detail-badges">
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="diagnostic-badge" :aria-label="buildTitle(instance)">
                    <Badge :variant="instance.access.status === 'reachable' || instance.connectionStatus === 'online' ? 'default' : 'secondary'">{{ instance.connectionStatus }}</Badge>
                  </span>
                </TooltipTrigger>
                <TooltipContent class="diagnostic-tooltip" align="end" side="bottom">
                  <div class="diagnostic-tooltip-grid">
                    <span><b>Protocol</b><em>{{ instance.protocolVersion || instance.build?.protocolVersion || "unknown" }}</em></span>
                    <span><b>Build</b><em>{{ buildLabel(instance) }}</em></span>
                    <span><b>Package</b><em>{{ packageLabel(instance) }}</em></span>
                    <span v-if="instance.build?.imageRef"><b>Image</b><em>{{ instance.build.imageRef }}</em></span>
                    <span v-if="instance.build?.builtAt"><b>Built</b><em>{{ instance.build.builtAt }}</em></span>
                  </div>
                </TooltipContent>
              </Tooltip>
              <Badge variant="secondary">{{ instance.status }}</Badge>
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="diagnostic-badge" :aria-label="buildTitle(instance)">
                    <Badge :variant="instance.protocolCompatible ? 'secondary' : 'destructive'">
                      {{ instance.protocolCompatible ? "protocol ok" : "protocol mismatch" }}
                    </Badge>
                  </span>
                </TooltipTrigger>
                <TooltipContent class="diagnostic-tooltip" align="end" side="bottom">
                  <div class="diagnostic-tooltip-grid">
                    <span><b>Protocol</b><em>{{ instance.protocolVersion || instance.build?.protocolVersion || "unknown" }}</em></span>
                    <span><b>Build</b><em>{{ buildLabel(instance) }}</em></span>
                    <span><b>Package</b><em>{{ packageLabel(instance) }}</em></span>
                    <span v-if="instance.build?.imageRef"><b>Image</b><em>{{ instance.build.imageRef }}</em></span>
                    <span v-if="instance.build?.builtAt"><b>Built</b><em>{{ instance.build.builtAt }}</em></span>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
          <div class="instance-controls" aria-label="Instance controls">
            <Button v-if="canShowInstanceAction(instance, 'start')" variant="outline" size="sm" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'start', instance)">
              <Play :size="14" />
              <span>{{ activeActionLabel(instance, "start", "Start") }}</span>
            </Button>
            <Button v-if="canShowInstanceAction(instance, 'stop')" variant="outline" size="sm" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'stop', instance)">
              <Square :size="14" />
              <span>{{ activeActionLabel(instance, "stop", "Stop") }}</span>
            </Button>
            <Button v-if="canShowInstanceAction(instance, 'restart')" variant="outline" size="sm" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'restart', instance)">
              <RotateCw :size="14" />
              <span>{{ activeActionLabel(instance, "restart", "Restart") }}</span>
            </Button>
            <Button v-if="canShowInstanceAction(instance, 'retry-image')" variant="outline" size="sm" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'retry-image', instance)">
              <RotateCw :size="14" />
              <span>{{ activeActionLabel(instance, "retry-image", "Retry image") }}</span>
            </Button>
            <Button variant="outline" size="sm" @click="$emit('openSettings', instance.id)">
              <Settings :size="14" />
              <span>Settings</span>
            </Button>
            <Button variant="destructive" size="sm" :disabled="isInstanceActionBusy(instance)" @click="$emit('runAction', 'delete', instance)">
              <Trash2 :size="14" />
              <span>{{ activeActionLabel(instance, "delete", "Delete") }}</span>
            </Button>
          </div>
        </div>
      </header>
      <SessionPreview
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
        :instance="instance"
        :instance-connecting="instanceConnecting"
        :launchable-apps="launchableApps"
        :launching-app="launchingApp"
        :node-local-folders="nodeLocalFolders"
        :preview-expanded="previewExpanded"
        :rename-session="renameSession"
        :selected-ai-session="selectedAiSession"
        :ordered-session-tabs="orderedSessionTabs"
        :session-menu-open="sessionMenuOpen"
        :session-tabs="sessionTabs"
        :stopping-session-id="stoppingSessionId"
        @copy-registration="$emit('copyRegistration', $event)"
        @launch-app="(target, appId, cwdFolderId) => $emit('launchApp', target, appId, cwdFolderId)"
        @move-session-tab="(sourceKey, targetKey, placement) => $emit('moveSessionTab', sourceKey, targetKey, placement)"
        @open-ai-session-app="(target, session) => $emit('openAiSessionApp', target, session)"
        @open-url="$emit('openUrl', $event)"
        @select-ai-session="(instanceId, sessionId) => $emit('selectAiSession', instanceId, sessionId)"
        @select-session="$emit('selectSession', $event)"
        @stop-session="(target, session) => $emit('stopSession', target, session)"
        @update:app-launch-menu-open="$emit('update:appLaunchMenuOpen', $event)"
        @update:preview-expanded="$emit('update:previewExpanded', $event)"
        @update:session-menu-open="$emit('update:sessionMenuOpen', $event)"
      />

      <section v-if="!previewExpanded" class="detail-meta">
        <p class="detail-meta-status">
          <span>Health {{ instance.health }}</span>
          <span>Workspace {{ instance.workspace.status }}</span>
          <span>Last refresh {{ lastRefreshLabel }}</span>
        </p>
      </section>
    </div>

    <section v-else class="detail-empty">
      <h1>Ready for a first instance</h1>
      <p>Create a project-backed controlled instance to register a worker into this control plane.</p>
      <Button size="sm" @click="$emit('newInstance')">
        <Plus :size="15" />
        <span>New instance</span>
      </Button>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Play, Plus, RotateCw, Settings, Square, Trash2 } from "@lucide/vue";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions, NodeLocalFolder } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import SessionPreview from "./SessionPreview.vue";
import type { InstanceAction } from "../useInstanceActions";
import { canShowInstanceAction, imageProvisioningLabel, instanceSourceLabel } from "../useInstanceStatus";
import type { LaunchableApp, SessionTab } from "../useInstanceSessions";
import { showControlPlaneToast } from "../useControlPlaneToasts";

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
  error?: string;
  instance?: InstanceWithAiSessions;
  instanceConnecting: boolean;
  instanceDisplayName: (instance: InstanceBoardItem) => string;
  isInstanceActionBusy: (instance: InstanceBoardItem) => boolean;
  lastRefreshLabel: string;
  launchableApps: LaunchableApp[];
  launchingApp: boolean;
  nodeLocalFolders?: NodeLocalFolder[];
  loading: boolean;
  previewExpanded: boolean;
  renameInstance: (instance: InstanceBoardItem, name: string) => Promise<void>;
  renameSession: (instance: InstanceBoardItem, session: SessionTab, title: string) => Promise<void>;
  selectedAiSession: (instance: InstanceBoardItem, sessions?: AiSessionSummary[]) => AiSessionSummary | undefined;
  orderedSessionTabs: SessionTab[];
  sessionMenuOpen: boolean;
  sessionTabs: SessionTab[];
  stoppingSessionId: string;
}>();

defineEmits<{
  copyRegistration: [instance: InstanceBoardItem];
  launchApp: [instance: InstanceBoardItem, appId: string, cwdFolderId?: string];
  moveSessionTab: [sourceKey: string, targetKey: string, placement: "before" | "after"];
  newInstance: [];
  openAiSessionApp: [instance: InstanceBoardItem, session?: AiSessionSummary];
  openSettings: [instanceId: string];
  openUrl: [url: string];
  runAction: [action: InstanceAction, instance: InstanceBoardItem];
  selectAiSession: [instanceId: string, sessionId: string];
  selectSession: [sessionKey: string];
  stopSession: [instance: InstanceBoardItem, session: SessionTab];
  "update:appLaunchMenuOpen": [open: boolean];
  "update:previewExpanded": [expanded: boolean];
  "update:sessionMenuOpen": [open: boolean];
}>();

const editingNameId = ref("");
const instanceNameDraft = ref("");
const nameInput = ref<HTMLInputElement | null>(null);
const savingName = ref(false);
const editNameWidth = ref(0);

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
    showControlPlaneToast(error instanceof Error ? error.message : "Failed to rename instance.");
    await nextTick();
    nameInput.value?.focus();
  } finally {
    savingName.value = false;
  }
}

function buildLabel(instance: InstanceBoardItem) {
  return instance.build?.buildId || instance.build?.gitCommit?.slice(0, 12) || "unknown";
}

function packageLabel(instance: InstanceBoardItem) {
  return instance.build?.packageVersion || instance.instanceVersion || "unknown";
}

function buildTitle(instance: InstanceBoardItem) {
  const build = instance.build;
  return [
    `Protocol: ${instance.protocolVersion || build?.protocolVersion || "unknown"}`,
    `Build: ${buildLabel(instance)}`,
    `Package: ${packageLabel(instance)}`,
    build?.imageRef ? `Image: ${build.imageRef}` : undefined,
    build?.builtAt ? `Built: ${build.builtAt}` : undefined,
  ].filter(Boolean).join("\n");
}
</script>

<style scoped src="./InstanceDetail.css"></style>
