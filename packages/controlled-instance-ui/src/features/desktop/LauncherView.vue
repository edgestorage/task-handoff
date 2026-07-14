<template>
  <aside class="desktop-launcher" aria-label="App launcher">
    <ContextMenu v-for="app in launcherApps" :key="app.id">
      <HoverCard :open-delay="250" :close-delay="150">
        <ContextMenuTrigger as-child>
          <HoverCardTrigger as-child>
            <div class="launcher-item">
              <button type="button" class="launcher-button" :title="app.name" :disabled="launchingId === app.id" @click="openOrLaunch(app)">
                <span class="launcher-icon"><component :is="iconFor(app.id, app.kind)" :size="22" /></span>
                <span class="launcher-label">{{ app.name }}</span>
                <span v-if="runningSessions(app.id).length" class="launcher-running">{{ runningSessions(app.id).length }}</span>
              </button>
            </div>
          </HoverCardTrigger>
        </ContextMenuTrigger>
        <HoverCardContent class="launcher-popover p-0" side="right" align="start" :side-offset="8">
        <div class="launcher-popover-content">
        <div class="launcher-popover-head">
          <strong>{{ app.name }}</strong>
          <div class="launcher-popover-meta">
            <span>{{ runningSessions(app.id).length }} running</span>
            <button
              type="button"
              class="launcher-new-instance"
              title="New instance"
              aria-label="New instance"
              :disabled="launchingId === app.id"
              @click.stop="launch(app)"
            >
              <Plus :size="14" :stroke-width="2.2" />
            </button>
          </div>
        </div>
        <div
          v-for="session in runningSessions(app.id)"
          :key="session.id"
          class="launcher-session"
          role="menuitem"
        >
          <button type="button" class="launcher-session-open" @click="openSession(session)">
            <span class="launcher-session-title">{{ session.title }}</span>
            <span class="launcher-session-meta">{{ session.kind }} · {{ shortSessionId(session.id) }}</span>
          </button>
          <button type="button" class="launcher-session-close" title="Stop session" aria-label="Stop session" @click.stop="stopSession(session)">
            <XIcon :size="14" :stroke-width="2.2" />
          </button>
        </div>
        <div v-if="!runningSessions(app.id).length" class="launcher-session-empty">No running sessions</div>
        </div>
        </HoverCardContent>
      </HoverCard>
      <ContextMenuContent class="launcher-context-menu">
      <ContextMenuItem class="launcher-context-item" @select="openOrLaunch(app)">
        <Play :size="15" />
        <span>Open</span>
      </ContextMenuItem>
      <ContextMenuItem class="launcher-context-item" @select="launch(app)">
        <Plus :size="15" />
        <span>New Instance</span>
      </ContextMenuItem>
      <template v-if="app.kind === 'gui'">
        <ContextMenuSeparator />
        <ContextMenuItem class="launcher-context-item" @select="launch(app, { displayTarget: { mode: 'shared', id: 'main', autoCreate: true } })">
          <Rows3 :size="15" />
          <span>Open Shared Screen</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          v-for="preset in displayPresets"
          :key="preset.label"
          class="launcher-context-item"
          @select="launch(app, { displayTarget: { mode: 'isolated' }, display: { width: preset.width, height: preset.height, depth: preset.depth } })"
        >
          <Monitor :size="15" />
          <span>{{ preset.label }}</span>
        </ContextMenuItem>
      </template>
      <template v-if="runningSessions(app.id).length">
        <ContextMenuSeparator />
        <ContextMenuItem class="launcher-context-item danger" @select="closeAll(app)">
          <XIcon :size="15" />
          <span>Close All</span>
        </ContextMenuItem>
      </template>
      </ContextMenuContent>
    </ContextMenu>

    <div class="launcher-spacer" />

    <button type="button" class="launcher-button" title="AI Sessions" @click="openAiSessions">
      <span class="launcher-icon"><Activity :size="22" /></span>
      <span class="launcher-label">AI</span>
    </button>
    <button type="button" class="launcher-button" title="Custom Apps" @click="$emit('open-settings', 'apps')">
      <span class="launcher-icon"><Puzzle :size="22" /></span>
      <span class="launcher-label">Apps</span>
    </button>
    <button type="button" class="launcher-button" title="Sessions" @click="$emit('open-settings', 'sessions')">
      <span class="launcher-icon"><Rows3 :size="22" /></span>
      <span class="launcher-label">Sessions</span>
    </button>
    <button type="button" class="launcher-button" title="Settings" @click="$emit('open-settings', 'general')">
      <span class="launcher-icon"><Settings :size="22" /></span>
      <span class="launcher-label">Settings</span>
    </button>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { Activity, Bot, Code2, Globe, Monitor, Play, Plus, Puzzle, Rows3, Settings, Sparkles, SquareTerminal, X as XIcon } from "@lucide/vue";
import { startAppSession, stopAppSession, useAppCatalogQuery, useAppSessionsQuery } from "../../api/queries";
import type { AppCatalogItem, AppLaunchOptions, AppSession } from "../../api/types";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../../components/ui/context-menu";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../../components/ui/hover-card";
import { AI_SESSIONS_TAB, sharedDisplayIdsForSessions, useWorkspaceStore, workspaceTabForSession } from "../../stores/workspace";

defineEmits<{
  "open-settings": [section: string];
}>();

const queryClient = useQueryClient();
const catalog = useAppCatalogQuery();
const sessions = useAppSessionsQuery();
const workspace = useWorkspaceStore();
const launchingId = ref("");

const displayPresets = [
  { label: "New 1280 x 720", width: 1280, height: 720, depth: 24 },
  { label: "New 1440 x 900", width: 1440, height: 900, depth: 24 },
  { label: "New 1920 x 1080", width: 1920, height: 1080, depth: 24 },
];

const launcherApps = computed(() => {
  const preferred = ["vscode-web", "chromium", "terminal-tty", "codex", "claude", "terminal-gui"];
  const apps = catalog.data.value || [];
  return [
    ...preferred.map((id) => apps.find((app) => app.id === id)).filter((app): app is AppCatalogItem => Boolean(app)),
    ...apps.filter((app) => !preferred.includes(app.id)),
  ];
});

function iconFor(appId: string, kind: AppCatalogItem["kind"]) {
  if (appId === "vscode-web" || kind === "web") {
    return Code2;
  }
  if (appId === "chromium") {
    return Globe;
  }
  if (appId === "terminal-tty") {
    return SquareTerminal;
  }
  if (appId === "codex") {
    return Bot;
  }
  if (appId === "claude") {
    return Sparkles;
  }
  if (appId === "terminal-gui" || kind === "gui") {
    return Monitor;
  }
  return Puzzle;
}

function runningSessions(appId: string) {
  return (sessions.data.value || []).filter((session) => session.appId === appId && session.status === "running");
}

function latestRunningSession(appId: string) {
  return [...runningSessions(appId)].sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))[0];
}

function shortSessionId(id: string) {
  return id.replace(/^app_/, "").slice(0, 12);
}

async function openOrLaunch(app: AppCatalogItem) {
  const session = latestRunningSession(app.id);
  if (session) {
    openSession(session);
    return;
  }
  await launch(app);
}

async function launch(app: AppCatalogItem, options: AppLaunchOptions = {}) {
  launchingId.value = app.id;
  try {
    const session = await startAppSession(app.id, withGuiScale(app, options));
    openSession(session);
    await queryClient.invalidateQueries({ queryKey: ["status"] });
  } finally {
    launchingId.value = "";
  }
}

function withGuiScale(app: AppCatalogItem, options: AppLaunchOptions): AppLaunchOptions {
  if (app.kind !== "gui") {
    return options;
  }
  const scale = workspace.guiHidpi ? currentGuiScaleNumber() : 1;
  const env = { ...(options.env || {}) };
  if (!env.TASK_HANDOFF_GUI_SCALE) {
    env.TASK_HANDOFF_GUI_SCALE = formatGuiScale(scale);
  }
  const display = scaledDisplay(options.display || app.display, scale);
  return { ...options, env, ...(display ? { display } : {}) };
}

function currentGuiScaleNumber() {
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.min(3, Math.max(1, ratio));
}

function formatGuiScale(scale: number) {
  return scale.toFixed(2).replace(/\.?0+$/, "");
}

function scaledDisplay(display: AppLaunchOptions["display"] | AppCatalogItem["display"], scale: number) {
  if (!display?.width || !display.height) {
    return display;
  }
  return {
    ...display,
    width: Math.round(display.width * scale),
    height: Math.round(display.height * scale),
  };
}

async function closeAll(app: AppCatalogItem) {
  const targets = runningSessions(app.id);
  if (!targets.length) {
    return;
  }
  await Promise.all(targets.map((session) => stopAppSession(session.id)));
  const stoppedIds = new Set(targets.map((session) => session.id));
  const remainingSessions = (sessions.data.value || []).filter((item) => !stoppedIds.has(item.id));
  workspace.pruneSession(new Set(remainingSessions.map((item) => item.id)), sharedDisplayIdsForSessions(remainingSessions));
  await queryClient.invalidateQueries({ queryKey: ["status"] });
}

async function stopSession(session: AppSession) {
  await stopAppSession(session.id);
  const remainingSessions = (sessions.data.value || []).filter((item) => item.id !== session.id);
  workspace.pruneSession(new Set(remainingSessions.map((item) => item.id)), sharedDisplayIdsForSessions(remainingSessions));
  await queryClient.invalidateQueries({ queryKey: ["status"] });
}

function openSession(session: AppSession) {
  workspace.open(workspaceTabForSession(session));
}

function openAiSessions() {
  workspace.open(AI_SESSIONS_TAB);
}

</script>

<style src="../../styles/features/launcher.css"></style>
