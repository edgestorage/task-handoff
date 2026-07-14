<template>
  <section class="ai-sessions-panel" aria-label="AI sessions">
    <header class="ai-sessions-head">
      <div>
        <span>AI Sessions</span>
        <span class="ai-session-chips" aria-label="AI session counts">
          <strong data-tone="active">{{ sessionCounts.active }} Active</strong>
          <strong data-tone="idle">{{ sessionCounts.idle }} Idle</strong>
          <strong data-tone="waiting">{{ sessionCounts.waiting }} Waiting</strong>
        </span>
      </div>
      <small>{{ updatedLabel }}</small>
    </header>

    <div v-if="sessions.isLoading.value" class="ai-sessions-empty">Loading sessions...</div>
    <div v-else-if="!visibleSessions.length" class="ai-sessions-empty">No AI sessions yet.</div>
    <div v-else class="ai-session-workspace">
      <ScrollArea class="ai-session-list" role="listbox" aria-label="AI session list">
        <div class="ai-session-list-content">
          <AiSessionListRow
            v-for="session in visibleSessions"
            :key="session.id"
            :expanded-preview="expandedPreview"
            :has-app-session="Boolean(matchingAppSession(session))"
            :prompt-count="promptCount(session)"
            :prompt-index="promptIndexFor(session)"
            :selected="selectedSession?.id === session.id"
            :session="session"
            :session-title="appSessionTitle(session)"
            @collapse-expanded-preview="collapseExpandedPreview"
            @expand-message="expandMessage"
            @expand-prompt="expandPrompt"
            @next-prompt="nextPrompt"
            @open-app-session="openAppSession"
            @previous-prompt="previousPrompt"
            @select="selectSession"
          />
        </div>
      </ScrollArea>
      <AiSessionDetail
        v-if="selectedSession"
        v-model:message-draft="messageDraft"
        :busy="aiSessionActionBusy"
        :error="aiSessionActionError"
        :has-app-session="Boolean(matchingAppSession(selectedSession))"
        :prompt-index="promptIndexFor(selectedSession)"
        :session="selectedSession"
        :session-title="appSessionTitle(selectedSession)"
        @open-app-session="openAppSession"
        @remove-queued="removeQueuedMessage"
        @resolve-approval="resolveSelectedApproval"
        @retry-queued="retryQueuedMessage"
        @run-action="runSelectedSessionAction"
        @steer-draft="steerMessageDraft"
        @steer-queued="steerQueuedMessage"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { interruptAiSession, removeAiSessionQueuedMessage, resolveAiSessionApproval, retryAiSessionQueuedMessage, sendAiSessionMessage, steerAiSessionQueuedMessage, useAiSessionsQuery, useAppSessionsQuery } from "../../api/queries";
import type { AiSessionSummary } from "../../api/types";
import { ScrollArea } from "../../components/ui/scroll-area";
import { useWorkspaceStore, workspaceTabForSession } from "../../stores/workspace";
import AiSessionDetail from "./AiSessionDetail.vue";
import AiSessionListRow from "./AiSessionListRow.vue";
import {
  aiSessionCounts,
  canInterrupt,
  canResolveApproval,
  relativeTime,
  sortedAiSessions,
  useAiSessionExpandedPreview,
  useAiSessionPrompts,
} from "./useAiSessionDisplay";

const sessions = useAiSessionsQuery();
const appSessions = useAppSessionsQuery();
const workspace = useWorkspaceStore();
const visibleSessions = computed(() => sortedAiSessions(sessions.data.value?.sessions || []));
const selectedSessionId = ref("");
const selectedSession = computed(() => visibleSessions.value.find((session) => session.id === selectedSessionId.value) || visibleSessions.value[0]);
const { nextPrompt, previousPrompt, promptCount, promptIndexFor } = useAiSessionPrompts();
const { collapseExpandedPreview, expandMessage, expandedPreview, expandPrompt } = useAiSessionExpandedPreview();
const messageDraft = ref("");
const aiSessionActionBusy = ref(false);
const aiSessionActionError = ref("");

const sessionCounts = computed(() => aiSessionCounts(visibleSessions.value));

const updatedLabel = computed(() => {
  const updatedAt = sessions.data.value?.updatedAt;
  return updatedAt ? `updated ${relativeTime(updatedAt)}` : "";
});

watch(visibleSessions, (nextSessions) => {
  if (!nextSessions.length) {
    selectedSessionId.value = "";
    return;
  }
  if (!nextSessions.some((session) => session.id === selectedSessionId.value)) {
    selectedSessionId.value = nextSessions[0].id;
  }
}, { immediate: true });

watch(selectedSession, () => {
  aiSessionActionError.value = "";
});

function selectSession(id: string) {
  collapseExpandedPreview();
  selectedSessionId.value = id;
}

function openAppSession(aiSession: AiSessionSummary) {
  const match = matchingAppSession(aiSession);
  if (match) {
    workspace.open(workspaceTabForSession(match));
  }
}

async function runSelectedSessionAction() {
  const session = selectedSession.value;
  if (!session || aiSessionActionBusy.value || (!messageDraft.value.trim() && !canInterrupt(session))) {
    return;
  }
  if (messageDraft.value.trim()) {
    await sendSelectedSessionMessage();
    return;
  }
  await interruptSelectedSession();
}

async function sendSelectedSessionMessage() {
  const session = selectedSession.value;
  const message = messageDraft.value.trim();
  if (!session || !message || aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  aiSessionActionError.value = "";
  try {
    await sendAiSessionMessage(session.id, message);
    messageDraft.value = "";
  } catch (error) {
    aiSessionActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function steerMessageDraft() {
  const session = selectedSession.value;
  const message = messageDraft.value.trim();
  if (!session || !message || aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  aiSessionActionError.value = "";
  try {
    await sendAiSessionMessage(session.id, message, "steer");
    messageDraft.value = "";
    await sessions.refetch();
  } catch (error) {
    aiSessionActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function steerQueuedMessage(queueId: string) {
  const session = selectedSession.value;
  if (!session) {
    return;
  }
  await runQueueAction(() => steerAiSessionQueuedMessage(session.id, queueId));
}

async function retryQueuedMessage(queueId: string) {
  const session = selectedSession.value;
  if (!session) {
    return;
  }
  await runQueueAction(() => retryAiSessionQueuedMessage(session.id, queueId));
}

async function removeQueuedMessage(queueId: string) {
  const session = selectedSession.value;
  if (!session) {
    return;
  }
  await runQueueAction(() => removeAiSessionQueuedMessage(session.id, queueId));
}

async function runQueueAction(action: () => Promise<unknown>) {
  if (aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  aiSessionActionError.value = "";
  try {
    await action();
    await sessions.refetch();
  } catch (error) {
    aiSessionActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function interruptSelectedSession() {
  const session = selectedSession.value;
  if (!session || !canInterrupt(session) || aiSessionActionBusy.value || messageDraft.value.trim()) {
    return;
  }
  aiSessionActionBusy.value = true;
  aiSessionActionError.value = "";
  try {
    await interruptAiSession(session.id);
    await sessions.refetch();
  } catch (error) {
    aiSessionActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    aiSessionActionBusy.value = false;
  }
}

async function resolveSelectedApproval(decision: "allow" | "deny" | "skip") {
  const session = selectedSession.value;
  if (!session || !canResolveApproval(session) || aiSessionActionBusy.value) {
    return;
  }
  aiSessionActionBusy.value = true;
  aiSessionActionError.value = "";
  try {
    await resolveAiSessionApproval(session.id, decision);
    await sessions.refetch();
  } catch (error) {
    aiSessionActionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    aiSessionActionBusy.value = false;
  }
}

function matchingAppSession(aiSession: AiSessionSummary) {
  const sessions = appSessions.data.value || [];
  if (aiSession.appSessionId) {
    const match = sessions.find((session) => session.id === aiSession.appSessionId && session.status === "running");
    if (match) {
      return match;
    }
  }
  const short = typeof aiSession.providerMeta?.short === "string" ? aiSession.providerMeta.short : "";
  return short
    ? sessions.find((session) => session.status === "running" && (session.ai as { claude?: { short?: string } } | undefined)?.claude?.short === short)
    : undefined;
}

function appSessionTitle(aiSession: AiSessionSummary) {
  return matchingAppSession(aiSession)?.title || aiSession.agent;
}
</script>

<style scoped>
.ai-sessions-panel {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  align-content: start;
  gap: 10px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  border-top: 1px solid var(--ai-session-floating-border);
  background: var(--workspace-bg);
  padding: 12px;
}

.ai-sessions-head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
}

.ai-sessions-head div {
  display: grid;
  gap: 2px;
}

.ai-sessions-head span,
.ai-sessions-head small {
  color: var(--text-muted);
  font-size: 12px;
}

.ai-sessions-head strong {
  color: var(--text);
  font-size: 14px;
  font-weight: 650;
}

.ai-session-workspace {
  display: grid;
  grid-template-columns: minmax(300px, 0.48fr) minmax(0, 1fr);
  gap: 10px;
  min-height: 0;
  overflow: hidden;
}

.ai-session-list {
  min-height: 0;
}

.ai-session-list-content {
  display: grid;
  align-content: start;
  gap: 6px;
  min-height: 100%;
}

.ai-session-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.ai-session-chips strong {
  border: 1px solid var(--ai-session-chip-border);
  border-radius: 999px;
  padding: 2px 7px;
  background: var(--ai-session-chip-bg);
  font-size: 11px;
  font-weight: 650;
}

.ai-session-chips strong[data-tone="active"] {
  border-color: var(--ai-session-chip-active-border);
  color: var(--ai-session-chip-active-text);
}

.ai-session-chips strong[data-tone="waiting"] {
  border-color: var(--ai-session-chip-waiting-border);
  color: var(--ai-session-chip-waiting-text);
}

.ai-session-chips strong[data-tone="idle"] {
  color: var(--ai-session-chip-idle-text);
}

.ai-sessions-empty {
  color: var(--ai-session-muted);
  font-size: 13px;
  margin: 0;
}

@media (max-width: 760px) {
  .ai-session-workspace {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
