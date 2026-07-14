<template>
  <section class="desktop-workspace">
    <div v-if="workspace.tabs.length" class="desktop-tabs">
      <div class="workspace-workbar">
        <ScrollArea class="workspace-tab-list-scroll">
          <div class="workspace-tab-list">
            <ContextMenu v-for="tab in workspace.tabs" :key="tab.id">
              <ContextMenuTrigger as-child>
                <div
                  class="workspace-tab"
                  role="button"
                  tabindex="0"
                  :draggable="editingTabId !== tab.id"
                  :class="{ active: workspace.activeTabId === tab.id, dragging: draggingTabId === tab.id, editing: editingTabId === tab.id }"
                  @click="workspace.setActive(tab.id)"
                  @keydown.enter="workspace.setActive(tab.id)"
                  @keydown.space.prevent="workspace.setActive(tab.id)"
                  @dragstart="startTabDrag($event, tab)"
                  @dragover.prevent
                  @dragenter.prevent
                  @drop.prevent="dropTab($event, tab)"
                  @dragend="endTabDrag"
                >
                  <input
                    v-if="editingTabId === tab.id"
                    :ref="setRenameInput"
                    v-model="renameDraft"
                    class="workspace-tab-title-input"
                    :aria-invalid="Boolean(renameError)"
                    :disabled="renameSaving"
                    :title="renameError"
                    maxlength="120"
                    @click.stop
                    @keydown.enter.stop.prevent="commitRename(tab)"
                    @keydown.escape.stop.prevent="cancelRename"
                    @blur="commitRename(tab)"
                  />
                  <span v-else class="workspace-tab-title">{{ tab.title }}</span>
                  <span class="tab-kind">{{ tabKind(tab) }}</span>
                  <span class="tab-close" title="Close tab" aria-label="Close tab" @click.stop="closeTab(tab)">
                    <XIcon :size="13" :stroke-width="2.2" />
                  </span>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem :disabled="!isRenameableTab(tab)" @select="startRename(tab)">Rename session</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </div>
        </ScrollArea>
      </div>
      <div class="workspace-tab-panel desktop-tab-panel" :class="{ 'workspace-log-panel': activeTab?.type === 'logs', 'workspace-ai-panel': activeTab?.type === 'ai-sessions' }">
        <AiSessionsPanel v-if="activeTab?.type === 'ai-sessions'" />
        <template v-else-if="activeSession && activeTab">
          <TerminalSession v-if="activeTab.type === 'app-tty' && activeSession.status === 'running'" :session="activeSession" />
          <iframe v-else-if="activeTab.type === 'app-web' && activeSession.status === 'running' && activeSession.web" class="web-frame" :src="webUrl(activeSession)" :title="activeSession.title" allow="clipboard-read; clipboard-write; fullscreen" />
          <div v-else-if="activeTab.type === 'app-vnc' || activeTab.type === 'shared-vnc'" class="gui-session">
            <iframe
              v-if="activeSession.vnc"
              :key="`${activeSession.id}:${workspace.vncResizeMode}:${workspace.guiHidpi ? 'hidpi' : '1x'}`"
              class="vnc-frame workspace-vnc-frame"
              :src="noVncUrl(activeSession)"
              :title="`${activeTab.title} VNC`"
              allow="clipboard-read; clipboard-write; fullscreen"
              @load="syncKasmVncResize($event, activeSession)"
            />
            <p v-else class="logs-empty">VNC is unavailable for this session.</p>
          </div>
          <ScrollArea v-else-if="activeTab.type === 'logs'" class="workspace-log-scroll">
            <SessionLogs :session="activeSession" />
          </ScrollArea>
          <p v-else class="logs-empty">Runtime view is unavailable for this session state.</p>
        </template>
        <p v-else class="logs-empty">The selected workspace tab no longer has a running session.</p>
      </div>
    </div>
    <div v-else class="desktop-empty">
      <h1>TaskHandoff Desktop</h1>
      <p>Launch an app from the dock.</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watchEffect, type ComponentPublicInstance } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { X as XIcon } from "@lucide/vue";
import { publicPathParam, publicUrl } from "../../api/base";
import { renameAppSession, stopAppSession, useAppSessionsQuery } from "../../api/queries";
import type { AppSession } from "../../api/types";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../components/ui/context-menu";
import { ScrollArea } from "../../components/ui/scroll-area";
import { useAuthStore } from "../../stores/auth";
import type { WorkspaceTab } from "../../stores/workspace";
import { sessionForWorkspaceTab, sharedDisplayIdsForSessions, useWorkspaceStore } from "../../stores/workspace";
import SessionLogs from "../apps/SessionLogs.vue";
import TerminalSession from "../apps/TerminalSession.vue";
import AiSessionsPanel from "./AiSessionsPanel.vue";

const queryClient = useQueryClient();
const auth = useAuthStore();
const workspace = useWorkspaceStore();
const sessions = useAppSessionsQuery();

const activeTab = computed(() => workspace.tabs.find((tab) => tab.id === workspace.activeTabId));
const activeSession = computed(() => sessionForWorkspaceTab(activeTab.value, sessions.data.value || []));
const draggingTabId = ref("");
const editingTabId = ref("");
const renameDraft = ref("");
const renameError = ref("");
const renameSaving = ref(false);
const renameInput = ref<HTMLInputElement>();

function setRenameInput(element: Element | ComponentPublicInstance | null) {
  renameInput.value = element instanceof HTMLInputElement ? element : undefined;
}

watchEffect(() => {
  if (!sessions.data.value) {
    return;
  }
  const currentSessions = sessions.data.value || [];
  workspace.pruneSession(new Set(currentSessions.map((session) => session.id)), sharedDisplayIdsForSessions(currentSessions));
  workspace.syncSessionTitles(currentSessions);
});

function isRenameableTab(tab: WorkspaceTab): tab is Extract<WorkspaceTab, { type: "app-vnc" | "app-web" | "app-tty" }> {
  return tab.type === "app-vnc" || tab.type === "app-web" || tab.type === "app-tty";
}

function startRename(tab: WorkspaceTab) {
  if (!isRenameableTab(tab)) {
    return;
  }
  workspace.setActive(tab.id);
  editingTabId.value = tab.id;
  renameDraft.value = tab.title;
  renameError.value = "";
  renameSaving.value = false;
  void nextTick(() => renameInput.value?.select());
}

function cancelRename() {
  editingTabId.value = "";
  renameDraft.value = "";
  renameError.value = "";
  renameSaving.value = false;
}

async function commitRename(tab: WorkspaceTab) {
  if (editingTabId.value !== tab.id || !isRenameableTab(tab) || renameSaving.value) {
    return;
  }
  const title = renameDraft.value.trim();
  if (!title) {
    renameError.value = "Session title is required.";
    void nextTick(() => renameInput.value?.focus());
    return;
  }
  if (title === tab.title) {
    cancelRename();
    return;
  }
  renameSaving.value = true;
  try {
    const session = await renameAppSession(tab.sessionId, title);
    workspace.syncSessionTitles([session]);
    cancelRename();
  } catch (error) {
    renameSaving.value = false;
    renameError.value = error instanceof Error ? error.message : String(error);
    void nextTick(() => renameInput.value?.focus());
  }
}

function noVncUrl(session: AppSession) {
  if (session.vnc?.backend === "kasmvnc") {
    const guiScale = workspace.guiHidpi ? devicePixelRatio() : 1;
    const params = new URLSearchParams({
      path: publicPathParam(`/api/apps/sessions/${session.id}/web/websockify`),
      autoconnect: "1",
      resize: workspace.vncResizeMode,
      enable_hidpi: workspace.guiHidpi && guiScale > 1 ? "1" : "0",
      show_control_bar: "1",
    });
    const resolution = kasmVncResolution(session, guiScale);
    if (workspace.vncResizeMode === "scale" && resolution) {
      params.set("forced_resolution_x", String(resolution.width));
      params.set("forced_resolution_y", String(resolution.height));
    }
    if (auth.token) {
      params.set("token", auth.token);
    }
    return `${publicUrl(session.vnc.webPath)}?${params.toString()}`;
  }
  const token = auth.token ? `?token=${encodeURIComponent(auth.token)}` : "";
  const path = session.vnc?.webPath ? `${publicPathParam(session.vnc.webPath)}${token}` : "";
  const params = new URLSearchParams({
    path,
    autoconnect: "1",
    resize: workspace.vncResizeMode,
  });
  return publicUrl(`/api/novnc/vnc.html?${params.toString()}`);
}

function syncKasmVncResize(event: Event, session: AppSession) {
  if (session.vnc?.backend !== "kasmvnc") {
    return;
  }
  const frame = event.target;
  if (!(frame instanceof HTMLIFrameElement)) {
    return;
  }
  frame.contentWindow?.postMessage({ action: "resize", value: workspace.vncResizeMode }, "*");
  const resolution = kasmVncResolution(session, workspace.guiHidpi ? devicePixelRatio() : 1);
  if (workspace.vncResizeMode === "scale" && resolution) {
    frame.contentWindow?.postMessage({ action: "set_resolution", value_x: resolution.width, value_y: resolution.height }, "*");
  }
}

function kasmVncResolution(session: AppSession, guiScale: number) {
  if (!session.display) {
    return undefined;
  }
  const scale = guiScale > 1 ? guiScale : 1;
  return {
    width: Math.max(1, Math.round(session.display.width / scale)),
    height: Math.max(1, Math.round(session.display.height / scale)),
  };
}

function devicePixelRatio() {
  return typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
}

function webUrl(session: AppSession) {
  const base = publicUrl(session.web?.webPath || "");
  if (!auth.token) {
    return base;
  }
  return `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(auth.token)}`;
}

function tabKind(tab: WorkspaceTab) {
  if (tab.type === "ai-sessions") {
    return "ai";
  }
  if (tab.type === "logs") {
    return "logs";
  }
  if (tab.type === "shared-vnc") {
    return "shared";
  }
  if (tab.type === "app-vnc") {
    return "vnc";
  }
  if (tab.type === "app-web") {
    return "web";
  }
  return "tty";
}

function startTabDrag(event: DragEvent, tab: WorkspaceTab) {
  draggingTabId.value = tab.id;
  event.dataTransfer?.setData("text/plain", tab.id);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
  }
}

function dropTab(event: DragEvent, targetTab: WorkspaceTab) {
  if (draggingTabId.value) {
    const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    const bounds = target?.getBoundingClientRect();
    const placement = bounds && event.clientX > bounds.left + bounds.width / 2 ? "after" : "before";
    workspace.moveTab(draggingTabId.value, targetTab.id, placement);
  }
  endTabDrag();
}

function endTabDrag() {
  draggingTabId.value = "";
}

async function closeTab(tab: WorkspaceTab) {
  if (tab.type === "ai-sessions") {
    workspace.close(tab.id);
    return;
  }
  if (tab.type === "app-vnc" || tab.type === "app-web" || tab.type === "app-tty") {
    await stopAppSession(tab.sessionId);
    workspace.close(tab.id);
    await queryClient.invalidateQueries({ queryKey: ["status"] });
    return;
  }
  workspace.close(tab.id);
}

</script>

<style src="../../styles/features/apps/desktop-workspace-tabs.css"></style>
