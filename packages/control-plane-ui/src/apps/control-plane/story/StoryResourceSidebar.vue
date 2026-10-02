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
            @focus-session="(sessionId) => $emit('focusAppSession', targetInstance?.id || '', sessionId)"
          />
          <DropdownMenuItem v-else class="app-launch-menu-item story-resource-menu-item" disabled>{{ targetInstance && supportsApps(targetInstance) ? t("stories.resources.noApps") : t("stories.resources.appsUnsupported") }}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{{ t("stories.resources.repository") }}</DropdownMenuLabel>
          <DropdownMenuItem v-for="option in repositoryOpenOptions" :key="option.key" class="app-launch-menu-item story-resource-menu-item" @select="runOpenOption(option)">
            <component :is="option.icon" :size="14" />{{ option.label }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>

    <div v-if="!activeResource" class="story-resource-empty">
      <PanelRight :size="28" />
      <strong>{{ t("stories.resources.empty") }}</strong>
      <span class="story-resource-empty-hint">{{ resourceOpenHint }}</span>
      <div class="story-resource-empty-actions" role="group" :aria-label="t('stories.resources.quickActions')">
        <Button
          v-for="option in openOptions"
          :key="option.key"
          class="story-resource-empty-action"
          :disabled="optionDisabled(option)"
          :title="resourceOpenBlocked ? t('stories.resources.selectAiSessionFirst') : undefined"
          type="button"
          variant="outline"
          size="sm"
          @click="runOpenOption(option)"
        >
          <AppLaunchIcon v-if="option.kind === 'app'" :app="option.app" :size="16" />
          <component :is="option.icon" v-else :size="14" aria-hidden="true" />
          <span>{{ option.label }}</span>
        </Button>
      </div>
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
import { computed, type Component } from "vue";
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
import AppLaunchIcon from "../shared/AppLaunchIcon.vue";
import AppLaunchMenuItems from "../shared/AppLaunchMenuItems.vue";
import { buildAppSessionTabs, canRenameAppSession, EMBEDDED_BROWSER_APP_ID, launchableAppsForInstance, type LaunchableApp, type RepositoryWorkspaceTabTarget, type SessionTab } from "../useInstanceSessions";
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
  focusAppSession: [instanceId: string, sessionId: string];
  openRepository: [instanceId: string, sessionKind: RepositorySessionKind, sessionId: string, page: StoryRepositoryPage, filePath?: string, cwdFolderId?: string];
}>();
const { t } = useI18n();

type StoryResourceAppOpenOption = { key: string; kind: "app"; app: LaunchableApp; label: string };
type StoryResourceRepositoryOpenOption = { key: string; kind: "repository"; page: StoryRepositoryPage; label: string; icon: Component };
type StoryResourceOpenOption = StoryResourceAppOpenOption | StoryResourceRepositoryOpenOption;

const REPOSITORY_OPEN_OPTIONS: readonly { page: StoryRepositoryPage; labelKey: string; icon: Component }[] = [
  { page: "files", labelKey: "stories.resources.files", icon: FolderTree },
  { page: "changes-review", labelKey: "stories.resources.reviewChanges", icon: FileDiff },
  { page: "worktrees", labelKey: "stories.resources.worktrees", icon: GitBranch },
];

const resourceMenuLabel = computed(() => props.targetInstance && props.targetAiSessionId ? t("stories.resources.add") : t("stories.resources.selectAiSessionFirst"));
const targetAiSession = computed(() => props.targetInstance?.aiSessions.sessions.find((session) => session.id === props.targetAiSessionId));
const resourceOpenBlocked = computed(() => !props.targetInstance || !props.targetAiSessionId);
const resourceOpenHint = computed(() => resourceOpenBlocked.value ? t("stories.resources.selectAiSessionFirst") : t("stories.resources.emptyHint"));
const repositoryOpenOptions = computed<StoryResourceRepositoryOpenOption[]>(() => REPOSITORY_OPEN_OPTIONS.map((option) => ({
  key: `repository:${option.page}`,
  kind: "repository",
  page: option.page,
  label: t(option.labelKey),
  icon: option.icon,
})));
const appOpenOptions = computed<StoryResourceAppOpenOption[]>(() => {
  const instance = props.targetInstance;
  return instance
    ? launchableApps(instance).map((app) => ({ key: `app:${app.id}`, kind: "app", app, label: app.label }))
    : [];
});
const openOptions = computed<StoryResourceOpenOption[]>(() => [...appOpenOptions.value, ...repositoryOpenOptions.value]);

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
    title: resource.title || t("sessions.tabs.embeddedBrowser"),
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
  const browserLabel = resource.kind === "embedded-browser" ? resource.title || t("sessions.tabs.embeddedBrowser") : "";
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
    ? [{ id: EMBEDDED_BROWSER_APP_ID, label: t("sessions.tabs.embeddedBrowser") }]
    : [];
  return [...apps, ...browser];
}
function optionDisabled(option: StoryResourceOpenOption) {
  return resourceOpenBlocked.value || (option.kind === "app" && props.launching);
}
function runOpenOption(option: StoryResourceOpenOption) {
  if (optionDisabled(option)) return;
  if (option.kind === "app") launchTargetApp(option.app.id);
  else openTargetRepository(option.page);
}
function launchTargetApp(appId: string, _cwdFolderId?: string, profileId?: string) {
  if (!props.targetInstance || !targetAiSession.value?.cwd) return;
  emit("launchApp", props.targetInstance, appId, undefined, { cwd: targetAiSession.value.cwd, ...(profileId ? { profileId } : {}) });
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
.story-resource-empty { display:grid; place-items:center; align-content:center; gap:8px; min-width:0; min-height:0; overflow:auto; padding:24px; background:var(--terminal-bg); color:var(--text-muted); text-align:center; }
.story-resource-empty strong { color:var(--text); font-size:13px; font-weight:500; }
.story-resource-empty-hint { max-width:280px; font-size:12px; }
.story-resource-empty-actions { display:grid; width:min(280px,100%); min-width:0; gap:4px; margin-top:8px; }
.story-resource-empty-action { box-sizing:border-box; display:flex; width:100%; height:32px; min-height:32px; align-items:center; justify-content:flex-start; gap:8px; border-color:var(--terminal-selection); background:var(--surface-raised); color:var(--text); font-size:12px; font-weight:500; padding:0 10px; }
.story-resource-empty-action:hover:not(:disabled), .story-resource-empty-action:focus-visible:not(:disabled) { border-color:var(--brand-accent); background:var(--surface-active); color:var(--text-strong); }
.story-resource-empty-action > span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.story-resource-empty-action > svg { flex:0 0 auto; }
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
