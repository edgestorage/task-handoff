<template>
  <section class="settings-pane">
    <div class="section-head">
      <h2>Sessions</h2>
      <div class="section-actions">
        <span>{{ visibleSessions.length }} sessions</span>
        <Button v-if="restoredSessions.length" variant="outline" size="sm" @click="showRestoredSessions = !showRestoredSessions">
          {{ showRestoredSessions ? "Hide restored" : `Show restored (${restoredSessions.length})` }}
        </Button>
      </div>
    </div>
    <div class="settings-list">
      <Card v-for="session in visibleSessions" :key="session.id">
        <CardHeader class="session-header">
          <div>
            <CardTitle>{{ session.title }}</CardTitle>
            <CardDescription>{{ session.appId }} · {{ shortDate(session.updatedAt) }}</CardDescription>
          </div>
          <div class="session-actions">
            <Badge :variant="session.status === 'running' ? 'default' : 'secondary'">{{ session.status }}</Badge>
            <Button variant="outline" size="sm" :disabled="session.status !== 'running'" @click="stop(session.id)">Stop</Button>
            <Button variant="outline" size="sm" @click="restart(session.id)">Restart</Button>
            <Button variant="outline" size="sm" :disabled="!canOpenRuntime(session)" @click="openRuntime(session)">Open</Button>
            <Button variant="outline" size="sm" @click="openLogs(session)">Logs</Button>
            <Button variant="outline" size="sm" @click="remove(session.id)">Delete</Button>
          </div>
        </CardHeader>
        <CardContent>
          <p v-if="session.error" class="session-error">{{ session.error.code }}: {{ session.error.message }}</p>
          <dl class="session-metadata">
            <div v-if="session.tty?.cwd || session.launch?.cwd">
              <dt>CWD</dt>
              <dd>{{ session.launch?.cwd || session.tty?.cwd }}</dd>
            </div>
            <div v-if="session.display">
              <dt>Display</dt>
              <dd>{{ session.display.display }} {{ session.display.width }}x{{ session.display.height }}x{{ session.display.depth }}</dd>
            </div>
            <div v-if="session.vnc">
              <dt>Ports</dt>
              <dd>{{ session.vnc.backend === "kasmvnc" ? "kasmvnc" : "vnc" }} {{ session.vnc.port }}<span v-if="session.vnc.websockifyPort"> · ws {{ session.vnc.websockifyPort }}</span><span v-if="session.automation"> · cdp {{ session.automation.port }}</span></dd>
            </div>
            <div v-if="session.process">
              <dt>Process</dt>
              <dd>{{ session.process.command }}<span v-if="session.process.pid"> · pid {{ session.process.pid }}</span></dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { deleteAppSession, restartAppSession, stopAppSession, useAppSessionsQuery } from "../../api/queries";
import type { AppSession } from "../../api/types";
import { sharedDisplayIdsForSessions, useWorkspaceStore, workspaceTabForSession } from "../../stores/workspace";

const queryClient = useQueryClient();
const sessions = useAppSessionsQuery();
const workspace = useWorkspaceStore();
const showRestoredSessions = ref(false);
const restoredSessions = computed(() => (sessions.data.value || []).filter(isRestoredWithoutProcess));
const visibleSessions = computed(() =>
  showRestoredSessions.value ? sessions.data.value || [] : (sessions.data.value || []).filter((session) => !isRestoredWithoutProcess(session)),
);

function shortDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function canOpenRuntime(session: AppSession) {
  return session.status === "running" && (session.kind === "tty" || (session.kind === "gui" && Boolean(session.vnc)));
}

function isRestoredWithoutProcess(session: AppSession) {
  return session.error?.code === "APP_SESSION_RESTORED_WITHOUT_PROCESS";
}

function openRuntime(session: AppSession) {
  if (!canOpenRuntime(session)) {
    openLogs(session);
    return;
  }
  workspace.open(workspaceTabForSession(session));
}

function openLogs(session: AppSession) {
  workspace.open({ type: "logs", id: `logs:${session.id}`, sessionId: session.id, title: `${session.title} logs` });
}

async function stop(sessionId: string) {
  await stopAppSession(sessionId);
  await queryClient.invalidateQueries({ queryKey: ["status"] });
}

async function restart(sessionId: string) {
  const session = await restartAppSession(sessionId);
  openRuntime(session);
  await queryClient.invalidateQueries({ queryKey: ["status"] });
}

async function remove(sessionId: string) {
  await deleteAppSession(sessionId);
  const remainingSessions = (sessions.data.value || []).filter((session) => session.id !== sessionId);
  workspace.pruneSession(new Set(remainingSessions.map((session) => session.id)), sharedDisplayIdsForSessions(remainingSessions));
  await queryClient.invalidateQueries({ queryKey: ["status"] });
}

</script>

<style src="../../styles/features/apps/sessions-settings.css"></style>
