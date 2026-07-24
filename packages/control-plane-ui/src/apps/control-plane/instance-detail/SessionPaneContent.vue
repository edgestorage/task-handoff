<template>
  <div class="session-pane-content">
    <div v-if="hasInstanceStatusPage(instance)" class="session-preview-status-page" :data-pending="isInstanceStatusPending(instance)" :data-state="instance.status">
      <RefreshCw v-if="isInstanceStatusPending(instance)" :size="34" />
      <CircleAlert v-else-if="instance.status === 'failed' || instance.status === 'unhealthy'" :size="34" />
      <CircleStop v-else :size="34" />
      <strong>{{ instanceStatusTitle(instance) }}</strong>
      <span>{{ instanceStatusDetail(instance) }}</span>
    </div>
    <AiSessionPanel
      v-else-if="session?.kind === 'ai'"
      :active-session="session"
      :instance="instance"
      :launchable-apps="launchableApps"
      :node-local-folders="nodeLocalFolders"
      :selected-ai-session="selectedAiSession"
      @open-ai-session-app="(target, aiSession) => $emit('openAiSessionApp', target, aiSession)"
      @open-repository-workspace="$emit('openRepositoryWorkspace', $event)"
      @select-ai-session="(instanceId, sessionId) => $emit('selectAiSession', instanceId, sessionId)"
    />
    <RepositoryChangesReviewTab v-else-if="session?.kind === 'repository' && session.source?.page === 'changes-review'" :instance-id="instance.id" :session="session" @open-workspace="$emit('openRepositoryWorkspace', $event)" />
    <RepositoryWorkspaceTab v-else-if="session?.kind === 'repository'" :instance-id="instance.id" :session="session" />
    <div v-else-if="activeFrameUrl" class="session-preview-live">
      <iframe class="session-preview-frame" :src="activeFrameUrl" :title="session?.label || 'App session'" allow="clipboard-read; clipboard-write; fullscreen" />
    </div>
    <div v-else-if="!activeTerminalSocketUrl" class="session-preview-body">
      <Terminal v-if="session?.kind === 'terminal'" :size="34" />
      <Monitor v-else :size="34" />
      <strong>{{ previewTitle(instance) }}</strong>
      <Button v-if="canLaunchApp" variant="outline" size="sm" class="session-preview-launch-button" :disabled="launchingApp" :title="appLaunchButtonTitle" @click="$emit('openLaunchMenu')">
        <Plus :size="15" />
        <span>App</span>
      </Button>
      <span v-else>{{ previewDetail(instance) }}</span>
    </div>
    <SessionTerminalPreview
      v-for="terminalSession in terminalSessions"
      v-show="!hasInstanceStatusPage(instance) && terminalSession.key === sessionKey"
      :key="terminalSession.key"
      :active="!hasInstanceStatusPage(instance) && terminalSession.key === sessionKey"
      :socket-url="terminalSession.socketUrl"
      class="session-preview-live session-terminal"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { CircleAlert, CircleStop, Monitor, Plus, RefreshCw, Terminal } from "@lucide/vue";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions, NodeLocalFolder } from "../../../api/types";
import { Button } from "../../../components/ui/button";
import type { LaunchableApp, RepositoryWorkspaceTabTarget, SessionTab } from "../useInstanceSessions";
import { previewDetail, previewTitle, sessionFrameUrl, sessionTerminalSocketUrl } from "../useInstanceSessions";
import { hasInstanceStatusPage, instanceStatusDetail, instanceStatusTitle, isInstanceStatusPending } from "../useInstanceStatus";
import AiSessionPanel from "./AiSessionPanel.vue";
import SessionTerminalPreview from "./SessionTerminalPreview.vue";
import RepositoryChangesReviewTab from "./RepositoryChangesReviewTab.vue";
import RepositoryWorkspaceTab from "./RepositoryWorkspaceTab.vue";

const props = defineProps<{
  appLaunchButtonTitle: string;
  canLaunchApp: boolean;
  instance: InstanceWithAiSessions;
  launchableApps: LaunchableApp[];
  launchingApp: boolean;
  nodeLocalFolders?: NodeLocalFolder[];
  selectedAiSession: (instance: InstanceBoardItem, sessions?: AiSessionSummary[]) => AiSessionSummary | undefined;
  session?: SessionTab;
  sessionKey: string;
  tabs: SessionTab[];
}>();

defineEmits<{
  openAiSessionApp: [instance: InstanceBoardItem, session?: AiSessionSummary];
  openRepositoryWorkspace: [target: RepositoryWorkspaceTabTarget];
  openLaunchMenu: [];
  selectAiSession: [instanceId: string, sessionId: string];
}>();

const activeFrameUrl = computed(() => props.session ? sessionFrameUrl(props.instance, props.session) : "");
const activeTerminalSocketUrl = computed(() => props.session ? sessionTerminalSocketUrl(props.instance, props.session) : "");
const terminalSessions = computed(() => props.tabs
  .filter((session) => session.kind === "terminal")
  .map((session) => ({ key: session.key, socketUrl: sessionTerminalSocketUrl(props.instance, session) }))
  .filter((session) => Boolean(session.socketUrl)));
</script>

<style scoped>
.session-pane-content { position: relative; display: grid; min-width: 0; min-height: 0; overflow: hidden; background: var(--terminal-bg); }
.session-preview-body, .session-preview-status-page { display: grid; min-height: 0; place-items: center; align-content: center; gap: 8px; color: var(--terminal-text); padding: 28px; text-align: center; }
.session-preview-body { background: linear-gradient(var(--workspace-grid) 1px, transparent 1px), linear-gradient(90deg, var(--workspace-grid) 1px, transparent 1px), var(--workspace-bg); background-size: 40px 40px; }
.session-preview-status-page svg { color: var(--status-success); }
.session-preview-status-page[data-pending="true"] svg { animation: session-pane-spin 1.1s linear infinite; }
.session-preview-status-page[data-state="failed"] svg, .session-preview-status-page[data-state="unhealthy"] svg { color: var(--status-danger); }
.session-preview-body strong, .session-preview-status-page strong { font-size: 18px; }
.session-preview-body > span, .session-preview-status-page span { max-width: 620px; overflow-wrap: anywhere; color: var(--text-muted); font-size: 12px; }
.session-preview-live { position: relative; min-height: 0; overflow: hidden; background: var(--terminal-bg); }
.session-preview-frame, .session-terminal { display: block; width: 100%; height: 100%; min-height: 0; border: 0; background: var(--terminal-bg); }
.session-terminal { position: relative; box-sizing: border-box; overflow: hidden; }
.session-terminal :deep(.xterm) { box-sizing: border-box; width: 100%; height: 100%; padding: 8px; }
.session-terminal :deep(.xterm-viewport) { overflow-y: hidden; background: var(--terminal-bg) !important; }
.session-preview-launch-button { display: inline-flex; width: 112px; height: 32px; align-items: center; justify-content: center; gap: 8px; border-color: var(--terminal-selection); background: var(--surface-raised); color: var(--brand-accent-muted); font-weight: 800; }
@keyframes session-pane-spin { to { transform: rotate(360deg); } }
</style>
