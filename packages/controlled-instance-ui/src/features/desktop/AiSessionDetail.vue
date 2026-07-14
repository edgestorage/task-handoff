<template>
  <ScrollArea class="ai-session-detail" aria-label="AI session detail">
    <aside class="ai-session-detail-content">
      <header>
        <div>
          <span>{{ sessionTitle }}</span>
          <strong>{{ aiSessionStatusLabel(session) }}</strong>
        </div>
        <small>{{ relativeTime(session.updatedAt) }}</small>
      </header>
      <section class="ai-session-detail-block ai-session-detail-block-user">
        <span>User Message</span>
        <ScrollArea class="ai-session-detail-block-scroll">
          <MarkdownContent :content="displayAiSessionTitle(session, promptIndex)" />
        </ScrollArea>
      </section>
      <section class="ai-session-detail-block ai-session-detail-block-assistant">
        <span>AI Response / Progress</span>
        <ScrollArea class="ai-session-detail-block-scroll">
          <MarkdownContent :content="displayAiSessionMessage(session, promptIndex)" />
        </ScrollArea>
      </section>
      <div v-if="canResolveApproval(session)" class="ai-session-approval-actions">
        <button type="button" :disabled="busy" @click="$emit('resolve-approval', 'allow')">
          <Check :size="14" />
          <span>Allow</span>
        </button>
        <button type="button" :disabled="busy" @click="$emit('resolve-approval', 'skip')">
          <Ban :size="14" />
          <span>Skip</span>
        </button>
        <button type="button" :disabled="busy" @click="$emit('resolve-approval', 'deny')">
          <X :size="14" />
          <span>Deny</span>
        </button>
      </div>
      <section v-if="session.queue?.items.length" class="ai-session-detail-block ai-session-queue">
        <span>Queue · {{ session.queue.pendingCount }}</span>
        <div class="ai-session-queue-list">
          <article v-for="item in session.queue.items" :key="item.id" class="ai-session-queue-item" :data-state="item.status">
            <p>{{ item.message }}</p>
            <small v-if="item.error">{{ item.error }}</small>
            <div>
              <button type="button" :disabled="busy || !canInterrupt(session)" @click="$emit('steer-queued', item.id)">Steer</button>
              <button v-if="item.status === 'failed'" type="button" :disabled="busy" @click="$emit('retry-queued', item.id)">Retry</button>
              <button type="button" :disabled="busy" @click="$emit('remove-queued', item.id)">Remove</button>
            </div>
          </article>
        </div>
      </section>
      <AiSessionComposer
        :model-value="messageDraft"
        class="ai-session-compose"
        :busy="busy"
        :can-interrupt="canInterrupt(session)"
        :error="error"
        @update:model-value="$emit('update:messageDraft', $event)"
        @run="$emit('run-action')"
        @steer="$emit('steer-draft')"
      />
      <div v-if="session.currentTool?.name" class="ai-session-tool">
        <span>Current Tool</span>
        <strong>{{ session.currentTool.name }}</strong>
        <small v-if="session.currentTool.inputPreview">{{ session.currentTool.inputPreview }}</small>
      </div>
      <dl class="ai-session-meta">
        <div>
          <dt>Workspace</dt>
          <dd>{{ session.cwd || "Unknown" }}</dd>
        </div>
        <div>
          <dt>Session</dt>
          <dd>{{ session.providerSessionId || session.id }}</dd>
        </div>
        <div>
          <dt>App Binding</dt>
          <dd>{{ session.appSessionId || "Not bound" }}</dd>
        </div>
      </dl>
      <button v-if="hasAppSession" type="button" class="ai-session-detail-open" @click="$emit('open-app-session', session)">
        <ExternalLink :size="14" />
        <span>Open App Session</span>
      </button>
    </aside>
  </ScrollArea>
</template>

<script setup lang="ts">
import { Ban, Check, ExternalLink, X } from "@lucide/vue";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import type { AiSessionSummary } from "../../api/types";
import AiSessionComposer from "../../components/ai-session/AiSessionComposer.vue";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  aiSessionStatusLabel,
  canInterrupt,
  canResolveApproval,
  displayAiSessionMessage,
  displayAiSessionTitle,
  relativeTime,
} from "./useAiSessionDisplay";

defineProps<{
  busy: boolean;
  error: string;
  hasAppSession: boolean;
  messageDraft: string;
  promptIndex: number;
  session: AiSessionSummary;
  sessionTitle: string;
}>();

defineEmits<{
  "open-app-session": [session: AiSessionSummary];
  "remove-queued": [queueId: string];
  "resolve-approval": [decision: "allow" | "deny" | "skip"];
  "retry-queued": [queueId: string];
  "run-action": [];
  "steer-draft": [];
  "steer-queued": [queueId: string];
  "update:messageDraft": [value: string];
}>();
</script>

<style scoped>
.ai-session-detail {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--ai-session-detail-border);
  border-radius: 8px;
  background: var(--ai-session-row-bg);
}

.ai-session-detail-content {
  display: grid;
  align-content: start;
  gap: 12px;
  min-height: 100%;
  padding: 14px;
}

.ai-session-detail header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 12px;
}

.ai-session-detail header div {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.ai-session-detail header span,
.ai-session-detail header small,
.ai-session-tool span,
.ai-session-tool small,
.ai-session-meta dt {
  color: var(--ai-session-muted);
  font-size: 12px;
}

.ai-session-detail header strong {
  color: var(--ai-session-detail-heading);
  font-size: 15px;
  font-weight: 750;
}

.ai-session-detail-block {
  display: grid;
  gap: 7px;
  min-width: 0;
  border-top: 1px solid var(--ai-session-rule);
  padding-top: 10px;
}

.ai-session-detail-block-assistant {
  border: 0;
  border-radius: 0;
  background: var(--ai-session-assistant-bg);
  margin-inline: -14px;
  padding: 14px;
}

.ai-session-detail-block-assistant > span {
  color: var(--ai-session-assistant-pill-text);
}

.ai-session-detail-block-assistant > div {
  color: var(--ai-session-detail-heading);
  font-weight: 400;
}

.ai-session-detail-block-assistant :deep(strong),
.ai-session-detail-block-assistant :deep(b) {
  color: var(--ai-session-detail-heading);
}

.ai-session-detail-block > span {
  color: var(--ai-session-muted);
  font-size: 12px;
  font-weight: 800;
}

.ai-session-detail-block-scroll {
  max-height: 260px;
}

.ai-session-detail-block-scroll :deep(div) {
  color: var(--ai-session-row-text);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  white-space: normal;
}

.ai-session-detail-block :deep(code) {
  border-radius: 4px;
  background: var(--ai-session-inline-code-bg);
  padding: 1px 4px;
  color: var(--ai-session-detail-open-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.92em;
}

.ai-session-detail-block :deep(strong) {
  color: var(--ai-session-detail-heading);
  font-weight: 750;
}

.ai-session-compose {
  --ai-composer-border: var(--ai-session-detail-open-border);
  --ai-composer-bg: var(--ai-session-assistant-bg);
  --ai-composer-text: var(--ai-session-row-text);
  --ai-composer-muted: var(--ai-session-muted);
  --ai-composer-primary-bg: var(--ai-session-detail-open-bg);
  --ai-composer-primary-text: var(--ai-session-detail-open-text);
  --ai-composer-stop-bg: var(--status-danger-bg);
  --ai-composer-stop-text: var(--status-danger);
  --ai-composer-danger: var(--status-danger);
  --ai-composer-shadow: var(--shadow-popover);
}

.ai-session-approval-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  border-top: 1px solid var(--ai-session-rule);
  padding-top: 10px;
}

.ai-session-approval-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 30px;
  border: 1px solid var(--ai-session-detail-open-border);
  border-radius: 7px;
  background: var(--ai-session-detail-open-bg);
  color: var(--ai-session-detail-open-text);
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
  padding: 0 10px;
}

.ai-session-approval-actions button:hover,
.ai-session-approval-actions button:focus-visible {
  border-color: var(--ai-session-floating-hover-border);
  outline: none;
}

.ai-session-approval-actions button:disabled {
  cursor: wait;
  opacity: 0.55;
}

.ai-session-tool,
.ai-session-meta {
  display: grid;
  gap: 6px;
  min-width: 0;
  border-top: 1px solid var(--ai-session-rule);
  padding-top: 10px;
}

.ai-session-tool strong {
  color: var(--ai-session-detail-heading);
  font-size: 13px;
}

.ai-session-meta {
  margin: 0;
}

.ai-session-queue-list {
  display: grid;
  gap: 8px;
}

.ai-session-queue-item {
  display: grid;
  gap: 7px;
  min-width: 0;
  border: 1px solid var(--ai-session-rule);
  border-radius: 7px;
  background: var(--ai-session-row-bg);
  padding: 9px;
}

.ai-session-queue-item[data-state="failed"] {
  border-color: var(--status-danger);
}

.ai-session-queue-item p {
  margin: 0;
  color: var(--ai-session-row-text);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.ai-session-queue-item small {
  color: var(--status-danger);
  font-size: 11px;
  overflow-wrap: anywhere;
}

.ai-session-queue-item div {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ai-session-queue-item button {
  min-height: 26px;
  border: 1px solid var(--ai-session-detail-open-border);
  border-radius: 6px;
  background: var(--ai-session-detail-open-bg);
  color: var(--ai-session-detail-open-text);
  cursor: pointer;
  font-size: 11px;
  padding: 0 8px;
}

.ai-session-queue-item button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.ai-session-meta div {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.ai-session-meta dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--ai-session-row-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-session-detail-open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  width: fit-content;
  min-height: 32px;
  border: 1px solid var(--ai-session-detail-open-border);
  border-radius: 7px;
  background: var(--ai-session-detail-open-bg);
  color: var(--ai-session-detail-open-text);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  padding: 0 10px;
}

.ai-session-detail-open:focus-visible {
  outline: 2px solid var(--ai-session-focus-outline);
  outline-offset: 2px;
}
</style>
