<template>
  <div class="app-shell">
    <LauncherView @open-settings="openSettings" />
    <main class="workspace">
      <header class="topbar">
        <div class="topbar-status">
          <span class="brand">TaskHandoff</span>
          <span>{{ statusText }}</span>
          <span class="event-state" :data-state="events.connectionState">{{ events.connectionState }}</span>
          <span v-if="events.lastEventAt" class="last-event">{{ lastEventText }}</span>
        </div>
        <ScrollArea class="topbar-right">
          <div class="topbar-right-content">
          <div id="topbar-session-actions" class="topbar-session-slot">
            <div v-if="activeSession" class="workspace-session-actions">
              <span class="workspace-session-status">{{ activeSession.appId }} · {{ activeSession.status }}</span>
              <Button variant="outline" size="sm" @click="openLogs(activeSession)">Logs</Button>
              <Button v-if="activeSession.kind === 'gui' && activeSession.status === 'running'" variant="outline" size="sm" as="a" :href="screenshotUrl(activeSession)" target="_blank" rel="noreferrer">Screenshot</Button>
              <div v-if="activeSession.kind === 'gui' && activeSession.status === 'running'" class="segmented-control">
                <ToggleGroup type="single" :model-value="workspace.vncResizeMode" aria-label="VNC resize mode" @update:model-value="(value) => value && setVncResizeMode(value as 'scale' | 'remote')">
                  <ToggleGroupItem value="scale">Scale</ToggleGroupItem>
                  <ToggleGroupItem value="remote">Resize</ToggleGroupItem>
                </ToggleGroup>
                <Toggle :model-value="workspace.guiHidpi" aria-label="Toggle HiDPI" @update:model-value="setGuiHidpi">HiDPI</Toggle>
              </div>
              <Button variant="outline" size="sm" :disabled="activeSession.status !== 'running'" @click="stop(activeSession.id)">Stop</Button>
              <Button variant="outline" size="sm" @click="restart(activeSession.id)">Restart</Button>
            </div>
          </div>
          <div class="topbar-actions">
            <input
              v-if="authStatus.data.value?.enabled"
              v-model="tokenInput"
              class="token-input"
              type="password"
              placeholder="Web token"
              @change="updateToken"
            />
          </div>
          </div>
        </ScrollArea>
      </header>
      <WorkspaceTabs />
    </main>
    <SettingsModal v-if="settingsOpen" :section="settingsSection" @close="settingsOpen = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, watchEffect } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { publicUrl } from "../../api/base";
import { restartAppSession, stopAppSession, useAppSessionsQuery, useAuthStatusQuery, useStatusQuery } from "../../api/queries";
import type { AppSession } from "../../api/types";
import { Button } from "../../components/ui/button";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Toggle } from "../../components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group";
import LauncherView from "../../features/desktop/LauncherView.vue";
import SettingsModal from "../../features/desktop/SettingsModal.vue";
import WorkspaceTabs from "../../features/desktop/WorkspaceTabs.vue";
import { useAuthStore } from "../../stores/auth";
import { useEventsStore } from "../../stores/events";
import { sessionForWorkspaceTab, useWorkspaceStore, workspaceTabForSession } from "../../stores/workspace";

const queryClient = useQueryClient();
const auth = useAuthStore();
const events = useEventsStore();
const workspace = useWorkspaceStore();
const authStatus = useAuthStatusQuery();
const status = useStatusQuery();
const sessions = useAppSessionsQuery();
const tokenInput = ref(auth.token);
const settingsOpen = ref(false);
const settingsSection = ref("general");
const statusText = computed(() => (status.data.value ? "Instance ready" : "Web server ready"));
const lastEventText = computed(() => `last event ${formatEventTime(events.lastEventAt)}`);
const authStoreHasToken = computed(() => Boolean(auth.token));
const activeTab = computed(() => workspace.tabs.find((tab) => tab.id === workspace.activeTabId));
const activeSession = computed(() => sessionForWorkspaceTab(activeTab.value, sessions.data.value || []));
const eventsCanConnect = computed(() => {
  const auth = authStatus.data.value;
  return Boolean(auth && (!auth.enabled || authStoreHasToken.value));
});

watchEffect(() => {
  tokenInput.value = auth.token;
});

watch(
  [eventsCanConnect, () => auth.token],
  ([ready]) => {
    events.disconnect();
    if (ready) {
      events.connect(queryClient);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  events.disconnect();
});

function updateToken() {
  auth.setToken(tokenInput.value);
}

function openSettings(section: string) {
  settingsSection.value = section;
  settingsOpen.value = true;
}

function openLogs(session: AppSession) {
  workspace.open({ type: "logs", id: `logs:${session.id}`, sessionId: session.id, title: `${session.title} logs` });
}

function screenshotUrl(session: AppSession) {
  const params = new URLSearchParams();
  if (auth.token) {
    params.set("token", auth.token);
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return publicUrl(`/api/apps/sessions/${session.id}/screenshot${suffix}`);
}

async function stop(sessionId: string) {
  await stopAppSession(sessionId);
  await queryClient.invalidateQueries({ queryKey: ["status"] });
}

async function restart(sessionId: string) {
  const session = await restartAppSession(sessionId);
  workspace.open(workspaceTabForSession(session));
  await queryClient.invalidateQueries({ queryKey: ["status"] });
}

function setVncResizeMode(mode: "scale" | "remote") {
  workspace.setVncResizeMode(mode);
}

function setGuiHidpi(enabled: boolean) {
  workspace.setGuiHidpi(enabled);
}

function formatEventTime(value: string) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString();
}
</script>

<style src="../../styles/layout/app-shell.css"></style>
<style src="../../styles/layout/workspace.css"></style>
<style src="../../styles/themes/cockpit.css"></style>
