<template>
  <section class="session-preview" :class="{ expanded: previewExpanded }" :data-state="instance.connectionStatus">
    <div class="session-preview-toolbar">
      <div class="session-preview-primary-tools">
        <div class="session-preview-selector" aria-label="Session views" @click.stop>
          <button
            v-if="orderedAiSessionTab"
            type="button"
            class="session-ai-home"
            :class="{ active: orderedAiSessionTab.key === activeSessionKey, dragging: draggingSessionTabKey === orderedAiSessionTab.key }"
            draggable="true"
            :title="sessionMeta(orderedAiSessionTab)"
            @click="$emit('selectSession', orderedAiSessionTab.key)"
            @dragstart="startSessionTabDrag($event, orderedAiSessionTab)"
            @dragover.prevent
            @dragenter.prevent
            @drop.prevent="dropSessionTab($event, orderedAiSessionTab)"
            @dragend="endSessionTabDrag"
          >
            <span class="session-ai-icon">
              <Bot :size="15" />
              <span class="session-tab-dot" :data-state="orderedAiSessionTab.status" />
            </span>
            <span>AI</span>
          </button>
          <span v-if="orderedAiSessionTab && orderedAppSessionTabs.length" class="session-tab-divider" aria-hidden="true" />
          <ScrollArea v-if="orderedAppSessionTabs.length" class="session-tab-strip">
            <div class="session-tab-strip-content" role="tablist" aria-label="Session views">
              <ContextMenu v-for="session in orderedAppSessionTabs" :key="session.key">
                <ContextMenuTrigger as-child>
                  <span
                    class="session-tab-item"
                    :class="{ active: session.key === activeSessionKey, dragging: draggingSessionTabKey === session.key }"
                    :data-kind="session.kind"
                    role="tab"
                    tabindex="0"
                    :draggable="editingSessionKey !== session.key"
                    :aria-selected="session.key === activeSessionKey"
                    :title="`${sessionDisplayName(session)} · ${stoppingSessionId === session.key ? 'stopping' : session.status}`"
                    @click="$emit('selectSession', session.key)"
                    @dragstart="startSessionTabDrag($event, session)"
                    @dragover.prevent
                    @dragenter.prevent
                    @drop.prevent="dropSessionTab($event, session)"
                    @dragend="endSessionTabDrag"
                    @keydown.enter.prevent="$emit('selectSession', session.key)"
                    @keydown.space.prevent="$emit('selectSession', session.key)"
                  >
                    <span class="session-tab-button">
                      <AppWindow :size="14" class="session-tab-icon" />
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
                  <ContextMenuItem class="instance-action-item" @select="beginSessionRename(session)">
                    <Pencil :size="14" />
                    <span>Rename session</span>
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            </div>
          </ScrollArea>
          <DropdownMenu v-if="sessionTabs.length" :open="sessionMenuOpen" @update:open="$emit('update:sessionMenuOpen', $event)">
            <DropdownMenuTrigger as-child>
              <button type="button" class="session-tab-menu-trigger" :aria-expanded="sessionMenuOpen" title="All sessions" aria-label="All sessions">
                <ChevronDown :size="15" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent class="session-select-menu" align="end" :side-offset="8">
              <template v-if="groupSessionMenu">
                <DropdownMenuItem
                  v-if="aiSessionTab"
                  :key="aiSessionTab.key"
                  class="session-select-row"
                  :class="{ active: aiSessionTab.key === activeSessionKey }"
                  @select="$emit('selectSession', aiSessionTab.key)"
                >
                  <span class="session-select-option">
                    <span>
                      <strong>{{ appDisplayName(aiSessionTab.label) }}</strong>
                      <small>{{ sessionMeta(aiSessionTab) }}</small>
                    </span>
                  </span>
                </DropdownMenuItem>
                <div v-for="group in groupedAppSessions" :key="group.key" class="session-select-group">
                  <div class="session-select-group-label" :title="group.label">
                    <Folder :size="13" />
                    <span>{{ group.label }}</span>
                  </div>
                  <DropdownMenuItem
                    v-for="session in group.sessions"
                    :key="session.key"
                    class="session-select-row nested"
                    :class="{ active: session.key === activeSessionKey }"
                    @select="$emit('selectSession', session.key)"
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
                  v-for="session in sessionTabs"
                  :key="session.key"
                  class="session-select-row"
                  :class="{ active: session.key === activeSessionKey }"
                  @select="$emit('selectSession', session.key)"
                >
                  <span class="session-select-option">
                    <span>
                      <strong>{{ sessionDisplayName(session) }}</strong>
                      <small>{{ sessionMeta(session) }}</small>
                    </span>
                  </span>
                  <button
                    v-if="session.kind !== 'ai'"
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
            </DropdownMenuContent>
          </DropdownMenu>
          <span v-else class="session-select-empty">No app session</span>
        </div>
        <div class="app-launcher" :class="{ open: appLaunchMenuOpen }" @click.stop>
          <DropdownMenu :open="appLaunchMenuOpen" @update:open="$emit('update:appLaunchMenuOpen', $event)">
            <DropdownMenuTrigger as-child>
              <Button variant="outline" size="sm" :disabled="!canLaunchApp || launchingApp" :aria-expanded="appLaunchMenuOpen" :title="appLaunchButtonTitle">
                <Plus :size="14" />
                <span>{{ appLaunchButtonLabel }}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent class="app-launch-menu" align="start" :side-offset="6">
              <AppLaunchMenuItems :apps="launchableApps" :folders="nodeLocalFolders" :instance="instance" :launching="launchingApp" @launch="(appId, cwdFolderId) => launchApp(appId, cwdFolderId)" />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div class="session-preview-tools">
        <button type="button" class="preview-expand-button" :aria-label="previewExpanded ? 'Restore session preview' : 'Expand session preview'" :title="previewExpanded ? 'Restore preview' : 'Expand preview'" @click="$emit('update:previewExpanded', !previewExpanded)">
          <Minimize2 v-if="previewExpanded" :size="15" />
          <Maximize2 v-else :size="15" />
        </button>
      </div>
    </div>
    <div v-if="instanceConnecting" class="session-preview-connecting">
      <RefreshCw :size="34" />
      <strong>{{ instanceConnectionTitle(instance) }}</strong>
      <span>{{ instanceConnectionDetail(instance) }}</span>
    </div>
    <AiSessionPanel
      v-else-if="activeSession?.kind === 'ai'"
      :active-session="activeSession"
      :instance="instance"
      :selected-ai-session="selectedAiSession"
      @open-ai-session-app="(target, session) => $emit('openAiSessionApp', target, session)"
      @select-ai-session="(instanceId, sessionId) => $emit('selectAiSession', instanceId, sessionId)"
    />
    <div v-else-if="activeSessionFrameUrl" class="session-preview-live">
      <iframe class="session-preview-frame" :src="activeSessionFrameUrl" :title="activeSession?.label || 'App session'" allow="clipboard-read; clipboard-write; fullscreen" />
    </div>
    <div v-else-if="!activeTerminalSocketUrl" class="session-preview-body">
      <Terminal v-if="activeSession?.kind === 'terminal'" :size="34" />
      <Monitor v-else :size="34" />
      <strong>{{ previewTitle(instance) }}</strong>
      <DropdownMenu v-if="canLaunchApp" :open="previewLaunchMenuOpen" @update:open="previewLaunchMenuOpen = $event">
        <DropdownMenuTrigger as-child>
          <Button variant="outline" size="sm" class="session-preview-launch-button" :disabled="launchingApp" :aria-expanded="previewLaunchMenuOpen" :title="appLaunchButtonTitle">
            <Plus :size="15" />
            <span>App</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent class="app-launch-menu" align="center" :side-offset="6">
          <AppLaunchMenuItems :apps="launchableApps" :folders="nodeLocalFolders" :instance="instance" :launching="launchingApp" @launch="(appId, cwdFolderId) => launchApp(appId, cwdFolderId)" />
        </DropdownMenuContent>
      </DropdownMenu>
      <span v-else>{{ previewDetail(instance) }}</span>
    </div>
    <SessionTerminalPreview
      v-for="terminalSession in terminalSessionPreviews"
      v-show="!instanceConnecting && terminalSession.key === activeSessionKey"
      :key="terminalSession.key"
      :active="!instanceConnecting && terminalSession.key === activeSessionKey"
      :socket-url="terminalSession.socketUrl"
      class="session-preview-live session-terminal"
    />
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
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, type ComponentPublicInstance } from "vue";
import { AppWindow, Bot, ChevronDown, Copy, ExternalLink, Folder, Maximize2, Minimize2, Monitor, Pencil, Plus, RefreshCw, Terminal, X } from "@lucide/vue";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions, NodeLocalFolder } from "../../../api/types";
import { Button } from "../../../components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../../components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import AiSessionPanel from "./AiSessionPanel.vue";
import SessionTerminalPreview from "./SessionTerminalPreview.vue";
import AppLaunchMenuItems from "../shared/AppLaunchMenuItems.vue";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import {
  appDisplayName,
  groupedAppSessionTabs,
  previewDetail,
  previewTitle,
  sessionMeta,
  sessionDisplayName,
  sessionTerminalSocketUrl,
  shouldGroupAppSessionTabs,
  type LaunchableApp,
  type SessionTab,
} from "../useInstanceSessions";
import { instanceConnectionDetail, instanceConnectionTitle } from "../useInstanceStatus";

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
  instanceConnecting: boolean;
  launchableApps: LaunchableApp[];
  launchingApp: boolean;
  nodeLocalFolders?: NodeLocalFolder[];
  orderedSessionTabs: SessionTab[];
  previewExpanded: boolean;
  renameSession: (instance: InstanceBoardItem, session: SessionTab, title: string) => Promise<void>;
  selectedAiSession: (instance: InstanceBoardItem, sessions?: AiSessionSummary[]) => AiSessionSummary | undefined;
  sessionMenuOpen: boolean;
  sessionTabs: SessionTab[];
  stoppingSessionId: string;
}>();

const emit = defineEmits<{
  copyRegistration: [instance: InstanceBoardItem];
  launchApp: [instance: InstanceBoardItem, appId: string, cwdFolderId?: string];
  moveSessionTab: [sourceKey: string, targetKey: string, placement: "before" | "after"];
  openAiSessionApp: [instance: InstanceBoardItem, session?: AiSessionSummary];
  openUrl: [url: string];
  selectAiSession: [instanceId: string, sessionId: string];
  selectSession: [sessionKey: string];
  stopSession: [instance: InstanceBoardItem, session: SessionTab];
  "update:appLaunchMenuOpen": [open: boolean];
  "update:previewExpanded": [expanded: boolean];
  "update:sessionMenuOpen": [open: boolean];
}>();

const previewLaunchMenuOpen = ref(false);
const draggingSessionTabKey = ref("");
const editingSessionKey = ref("");
const sessionTitleDraft = ref("");
const sessionRenameError = ref("");
const renamingSession = ref(false);
const renameInput = ref<HTMLInputElement>();
const aiSessionTab = computed(() => props.sessionTabs.find((session) => session.kind === "ai"));
const orderedAiSessionTab = computed(() => props.orderedSessionTabs.find((session) => session.kind === "ai"));
const orderedAppSessionTabs = computed(() => props.orderedSessionTabs.filter((session) => session.kind !== "ai"));
const terminalSessionPreviews = computed(() =>
  props.orderedSessionTabs
    .filter((session) => session.kind === "terminal")
    .map((session) => ({ key: session.key, socketUrl: sessionTerminalSocketUrl(props.instance, session) }))
    .filter((session) => Boolean(session.socketUrl)),
);
const groupSessionMenu = computed(() => shouldGroupAppSessionTabs(props.instance, props.sessionTabs));
const groupedAppSessions = computed(() => groupedAppSessionTabs(props.instance, props.sessionTabs, props.activeSessionKey));

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
  previewLaunchMenuOpen.value = false;
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

function dropSessionTab(event: DragEvent, targetSession: SessionTab) {
  if (draggingSessionTabKey.value) {
    const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    const bounds = target?.getBoundingClientRect();
    const placement = bounds && event.clientX > bounds.left + bounds.width / 2 ? "after" : "before";
    emit("moveSessionTab", draggingSessionTabKey.value, targetSession.key, placement);
  }
  endSessionTabDrag();
}

function endSessionTabDrag() {
  draggingSessionTabKey.value = "";
}
</script>

<style scoped src="./SessionPreview.css"></style>
