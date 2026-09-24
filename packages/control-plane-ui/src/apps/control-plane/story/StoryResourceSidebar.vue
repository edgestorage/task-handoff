<template>
  <aside class="story-resource-sidebar" tabindex="-1" :aria-label="t('stories.resources.title')">
    <header class="story-resource-header">
      <StoryResourceTabStrip
        :items="tabItems"
        :active-key="activeKey"
        :rename-resource="renameAppSessionResource"
        @select="$emit('select', $event)"
        @close="$emit('close', $event)"
        @reorder="(sourceKey, targetKey, placement) => $emit('reorder', sourceKey, targetKey, placement)"
      />
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="story-resource-header-action" :disabled="!targetInstance || !targetAiSessionId" :aria-label="resourceMenuLabel" :title="resourceMenuLabel">
            <Plus :size="16" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent class="app-launch-menu" align="end" :collision-padding="12" :side-offset="8">
          <DropdownMenuLabel class="story-resource-target-label">
            <span class="story-resource-instance-status" :data-state="targetInstance?.connectionStatus" />
            <span class="story-resource-target-instance">
              <Boxes :size="14" aria-hidden="true" />
              <strong>{{ targetInstance?.name }}</strong>
            </span>
            <span class="story-resource-target-separator" aria-hidden="true">·</span>
            <span class="story-resource-target-node">
              <Server :size="14" aria-hidden="true" />
              <span>{{ targetInstance?.node?.name || targetInstance?.nodeId }}</span>
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{{ t("stories.resources.apps") }}</DropdownMenuLabel>
          <AppLaunchMenuItems
            v-if="targetInstance && launchableApps(targetInstance).length"
            :apps="launchableApps(targetInstance)"
            :cwd-selection="false"
            :instance="targetInstance"
            :launching="launching"
            @launch="launchTargetApp"
          />
          <DropdownMenuItem v-else class="app-launch-menu-item story-resource-menu-item" disabled>{{ targetInstance && supportsApps(targetInstance) ? t("stories.resources.noApps") : t("stories.resources.appsUnsupported") }}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{{ t("stories.resources.repository") }}</DropdownMenuLabel>
          <DropdownMenuItem class="app-launch-menu-item story-resource-menu-item" @select="openTargetRepository('files')"><FolderTree :size="14" />{{ t("stories.resources.files") }}</DropdownMenuItem>
          <DropdownMenuItem class="app-launch-menu-item story-resource-menu-item" @select="openTargetRepository('changes-review')"><FileDiff :size="14" />{{ t("stories.resources.reviewChanges") }}</DropdownMenuItem>
          <DropdownMenuItem class="app-launch-menu-item story-resource-menu-item" @select="openTargetRepository('worktrees')"><GitBranch :size="14" />{{ t("stories.resources.worktrees") }}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>

    <div v-if="!activeResource" class="story-resource-empty">
      <PanelRight :size="28" />
      <strong>{{ t("stories.resources.empty") }}</strong>
      <span>{{ t("stories.resources.emptyHint") }}</span>
    </div>
    <div v-else-if="!activeInstance" class="story-resource-empty story-resource-unavailable">
      <CircleAlert :size="28" />
      <strong>{{ t("stories.resources.unavailable") }}</strong>
    </div>
    <SessionPaneContent
      v-else-if="activeSession"
      class="story-resource-content"
      :active-action-label="idleActionLabel"
      app-launch-button-title=""
      :can-launch-app="false"
      :instance="activeInstance"
      :is-instance-action-busy="notBusy"
      :launchable-apps="[]"
      :launching-app="launching"
      :node-local-folders="nodeLocalFoldersByNodeId[activeInstance.nodeId] || []"
      pane="left"
      :selected-ai-session="noSelectedAiSession"
      :session="activeSession"
      :session-key="activeSession.key"
      @open-repository-workspace="openRepositoryFromContent"
    />
  </aside>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Boxes, CircleAlert, FileDiff, FolderTree, GitBranch, PanelRight, Plus, Server } from "@lucide/vue";
import { normalizeControlledInstanceCapabilities, supportsBrowserTunnel } from "@task-handoff/protocol/control-plane";
import { supportsDirectoryBrowserTunnel } from "@task-handoff/protocol/control-plane-directory";
import type { RepositorySessionKind } from "@task-handoff/protocol/repository";
import type { AiSessionSummary, InstanceBoardItem, InstanceWithAiSessions, NodeLocalFolder } from "../../../api/types";
import { Button } from "../../../components/ui/button";
import { canUseDesktopBrowserContext } from "../../../lib/desktopBridge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import SessionPaneContent from "../instance-detail/SessionPaneContent.vue";
import AppLaunchMenuItems from "../shared/AppLaunchMenuItems.vue";
import { buildAppSessionTabs, canRenameAppSession, EMBEDDED_BROWSER_APP_ID, launchableAppsForInstance, type RepositoryWorkspaceTabTarget, type SessionTab } from "../useInstanceSessions";
import { storyResourceKey, type StoryRepositoryPage, type StoryResourceRef } from "./storyResources";
import StoryResourceTabStrip, { type StoryResourceTabItem } from "./StoryResourceTabStrip.vue";
import type { StoryResourceDropPlacement } from "./storyResourceOrder.ts";

const props = defineProps<{
  resources: StoryResourceRef[];
  activeKey: string;
  instances: InstanceWithAiSessions[];
  targetInstance?: InstanceWithAiSessions;
  targetAiSessionId?: string;
  launching: boolean;
  closingKey?: string;
  nodeLocalFoldersByNodeId?: Record<string, NodeLocalFolder[]>;
  renameResource?: (instanceId: string, sessionId: string, title: string) => Promise<void>;
}>();
const emit = defineEmits<{
  select: [key: string];
  close: [key: string];
  reorder: [sourceKey: string, targetKey: string, placement: StoryResourceDropPlacement];
  launchApp: [instance: InstanceBoardItem, appId: string, cwdFolderId?: string, options?: Record<string, unknown>];
  openRepository: [instanceId: string, sessionKind: RepositorySessionKind, sessionId: string, page: StoryRepositoryPage, filePath?: string, cwdFolderId?: string];
}>();
const { t } = useI18n();
const resourceMenuLabel = computed(() => props.targetInstance && props.targetAiSessionId ? t("stories.resources.add") : t("stories.resources.selectAiSessionFirst"));
const targetAiSession = computed(() => props.targetInstance?.aiSessions.sessions.find((session) => session.id === props.targetAiSessionId));

const activeResource = computed(() => props.resources.find((resource) => storyResourceKey(resource) === props.activeKey));
const activeInstance = computed(() => props.instances.find((instance) => instance.id === activeResource.value?.instanceId));
const activeSession = computed<SessionTab | undefined>(() => {
  const resource = activeResource.value;
  const instance = activeInstance.value;
  if (!resource || !instance) return undefined;
  if (resource.kind === "app-session") return buildAppSessionTabs(instance, t).find((session) => session.key === resource.sessionId);
  if (resource.kind === "embedded-browser") return {
    key: storyResourceKey(resource),
    kind: "embedded-browser",
    label: EMBEDDED_BROWSER_APP_ID,
    title: resource.title || t("sessions.tabs.browser"),
    status: resource.status || "running",
    source: {
      browserTabId: resource.browserTabId,
      ...(resource.initialUrl ? { initialUrl: resource.initialUrl } : {}),
      ...(resource.currentUrl ? { currentUrl: resource.currentUrl } : {}),
    },
  };
  return {
    key: storyResourceKey(resource),
    kind: "repository",
    label: repositoryLabel(resource.page),
    status: "open",
    source: {
      sessionKind: resource.sessionKind,
      sessionId: resource.sessionId,
      ...(resource.cwdFolderId ? { cwdFolderId: resource.cwdFolderId } : {}),
      page: resource.page === "files" ? "workspace" : resource.page,
      initialView: resource.page === "changes-review" ? "changes" : "files",
      ...(resource.filePath ? { filePath: resource.filePath, fileRequestId: resource.fileRequestId } : {}),
    },
  };
});
const tabItems = computed<StoryResourceTabItem[]>(() => props.resources.map((resource) => {
  const instance = props.instances.find((candidate) => candidate.id === resource.instanceId);
  const app = resource.kind === "app-session" ? buildAppSessionTabs(instance, t).find((session) => session.key === resource.sessionId) : undefined;
  const instanceLabel = instance?.name || resource.instanceId;
  const browserLabel = resource.kind === "embedded-browser" ? resource.title || t("sessions.tabs.browser") : "";
  return {
    key: storyResourceKey(resource),
    label: resource.kind === "repository" ? repositoryLabel(resource.page) : resource.kind === "embedded-browser" ? browserLabel : app?.title || app?.label || resource.sessionId,
    instanceLabel,
    description: `${resource.kind === "repository" ? repositoryLabel(resource.page) : resource.kind === "embedded-browser" ? browserLabel : app?.title || app?.label || resource.sessionId} · ${instanceLabel}`,
    closeLabel: resource.kind === "app-session" ? t("stories.resources.stopApp") : t("stories.resources.closeTab"),
    kind: resource.kind === "repository" ? resource.page : resource.kind === "embedded-browser" ? "embedded-browser" : app?.kind === "terminal" ? "terminal" : "app",
    status: resource.kind === "embedded-browser" ? resource.status : app?.status,
    closing: props.closingKey === storyResourceKey(resource),
    rename: storyResourceRenameState(resource, instance),
  };
}));

function storyResourceRenameState(resource: StoryResourceRef, instance: InstanceWithAiSessions | undefined): StoryResourceTabItem["rename"] {
  if (resource.kind !== "app-session" || !props.renameResource) return undefined;
  return canRenameAppSession(instance, resource.sessionId) ? "enabled" : "unavailable";
}

async function renameAppSessionResource(key: string, title: string) {
  const resource = props.resources.find((candidate) => storyResourceKey(candidate) === key);
  if (resource?.kind !== "app-session" || !props.renameResource) return;
  await props.renameResource(resource.instanceId, resource.sessionId, title);
}

function supportsApps(instance: InstanceWithAiSessions) { return normalizeControlledInstanceCapabilities(instance.capabilities).features.appRuntime; }
function launchableApps(instance: InstanceWithAiSessions) {
  const apps = supportsApps(instance) ? launchableAppsForInstance(instance, t) : [];
  const browser = canUseDesktopBrowserContext()
    && (supportsBrowserTunnel(instance.capabilities) || supportsDirectoryBrowserTunnel(instance.capabilities))
    ? [{ id: EMBEDDED_BROWSER_APP_ID, label: t("sessions.tabs.browser") }]
    : [];
  return [...apps, ...browser];
}
function launchTargetApp(appId: string) {
  if (!props.targetInstance || !targetAiSession.value?.cwd) return;
  emit("launchApp", props.targetInstance, appId, undefined, { cwd: targetAiSession.value.cwd });
}
function openTargetRepository(page: StoryRepositoryPage) {
  if (!props.targetInstance || !props.targetAiSessionId) return;
  emit("openRepository", props.targetInstance.id, "ai-session", props.targetAiSessionId, page, undefined, targetAiSession.value?.cwdFolderId);
}
function repositoryLabel(page: StoryRepositoryPage) {
  if (page === "changes-review") return t("stories.resources.reviewChanges");
  if (page === "worktrees") return t("stories.resources.worktrees");
  return t("stories.resources.files");
}
function openRepositoryFromContent(target: RepositoryWorkspaceTabTarget) {
  const resource = activeResource.value;
  if (!resource) return;
  emit("openRepository", resource.instanceId, target.sessionKind, target.sessionId, target.page === "changes-review" || target.page === "worktrees" ? target.page : "files", target.filePath, target.cwdFolderId);
}
const idleActionLabel = (_instance: InstanceBoardItem, _action: unknown, label: string) => label;
const notBusy = () => false;
const noSelectedAiSession = (_instance: InstanceBoardItem, _sessions?: AiSessionSummary[]) => undefined;
</script>

<style scoped>
.story-resource-sidebar { display:grid; grid-template-rows:auto minmax(0,1fr); width:100%; height:100%; min-width:0; min-height:0; overflow:hidden; background:var(--terminal-bg); color:var(--terminal-text); }
.story-resource-header { display:flex; min-width:0; height:40px; align-items:stretch; padding-inline:8px; border-bottom:1px solid var(--line); background:var(--surface-raised); color:var(--text-muted); }
.story-resource-header-action { width:28px; min-width:28px; height:28px; flex:0 0 28px; align-self:center; margin:0 0 0 4px; border:0; border-radius:7px; background:transparent; color:var(--text-muted); padding:0; }
.story-resource-header-action:hover, .story-resource-header-action:focus-visible, .story-resource-header-action[data-state="open"] { background:color-mix(in srgb,var(--surface-raised) 92%,var(--white) 4%); color:var(--text-strong); }
.story-resource-empty { display:grid; place-items:center; align-content:center; gap:8px; min-width:0; min-height:0; padding:24px; background:var(--terminal-bg); color:var(--text-muted); text-align:center; }
.story-resource-empty strong { color:var(--text); font-size:13px; font-weight:500; }
.story-resource-empty span { max-width:280px; font-size:12px; }
.story-resource-content { min-width:0; min-height:0; }
:global(.story-resource-target-label) { display:flex; align-items:center; gap:6px; min-width:0; }
:global(.story-resource-target-instance), :global(.story-resource-target-node) { display:inline-flex; align-items:center; gap:5px; min-width:0; }
:global(.story-resource-target-instance > strong), :global(.story-resource-target-node > span) { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; letter-spacing:0; }
:global(.story-resource-target-instance > strong) { font-size:12px; font-weight:500; }
:global(.story-resource-target-node) { color:var(--text-muted); font-size:12px; font-weight:400; }
:global(.story-resource-target-instance > svg), :global(.story-resource-target-node > svg) { flex:0 0 auto; }
:global(.story-resource-target-separator) { flex:0 0 auto; color:var(--line-strong); }
:global(.app-launch-menu-item.story-resource-menu-item) { min-height:32px; }
.story-resource-instance-status { width:7px; height:7px; flex:0 0 auto; border-radius:50%; background:var(--text-muted); }
.story-resource-instance-status[data-state="online"] { background:var(--status-success); }
</style>
