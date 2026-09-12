<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <article
        v-ai-session-card-auto-scroll="{ target: '.ai-board-preview-field-assistant', revision: promptIndex }"
        class="ai-board-card"
        :data-state="card.session.status"
        :data-selected="selected ? 'true' : undefined"
        :data-unread="card.session.unread ? 'true' : undefined"
        :data-app-session-origin="card.session.creationSource === 'app-session' ? 'true' : undefined"
        role="button"
        tabindex="0"
        @click="$emit('selectCard', card.key)"
        @keydown.enter.prevent="$emit('selectCard', card.key)"
        @keydown.space.prevent="$emit('selectCard', card.key)"
      >
    <span v-if="card.session.unread" class="ai-session-unread-dot" :aria-label="t('sessions.actions.unread')" :title="t('sessions.actions.unread')" />
    <AiSessionCardMarks :agent="card.session.agent" :creation-source="card.session.creationSource" :show-agent="false" />
    <div class="ai-board-card-headline">
      <TooltipProvider :delay-duration="120">
        <button type="button" class="ai-board-instance" @click.stop="$emit('selectCard', card.key)">
          <AiSessionStatusIndicator class="ai-board-status-indicator" :status="card.session.status" />
          <span class="ai-board-card-context">
            <template v-if="showWorkspace">
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="ai-board-card-context-item">
                    <Folder :size="14" aria-hidden="true" />
                    <span>{{ aiSessionBasename(card.session.cwd) || t("sessions.board.unknownFolder") }}</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent class="ai-session-path-tooltip" side="top" :side-offset="8">{{ card.session.cwd || t("sessions.board.unknownPath") }}</TooltipContent>
              </Tooltip>
              <span class="ai-board-card-context-separator" aria-hidden="true">·</span>
            </template>
            <Tooltip>
              <TooltipTrigger as-child>
                <span class="ai-board-card-context-item">
                  <Boxes :size="14" aria-hidden="true" />
                  <span>{{ instanceDisplayName(card.instance) }}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent class="ai-session-path-tooltip" side="top" :side-offset="8">{{ card.instance.node?.name || card.instance.nodeId }}</TooltipContent>
            </Tooltip>
            <template v-if="agentIcon">
              <span class="ai-board-card-context-separator" aria-hidden="true">·</span>
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="ai-board-card-agent" :aria-label="agentDisplayName">
                    <AiAgentIcon :agent="agentIcon" :size="14" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" :side-offset="8">{{ agentDisplayName }}</TooltipContent>
              </Tooltip>
            </template>
          </span>
        </button>
      </TooltipProvider>
    </div>

    <div class="ai-board-content">
      <div class="ai-board-preview-field ai-board-preview-field-user">
        <MarkdownContent class="ai-board-question" :content="displayAiSessionTitle(card.session, promptIndex, t)" />
      </div>
      <div class="ai-board-preview-field ai-board-preview-field-assistant">
        <AiSessionStreamingMarkdown
          class="ai-board-message"
          :content="displayAiSessionMessage(card.session, promptIndex, t)"
          :instance-id="card.instance.id"
          :is-latest="promptIndex >= promptCount - 1"
          :provider-turn-id="card.session.activeTurnId"
          :session-id="card.session.id"
          :turn-id="card.session.latestTurnRef?.id"
        />
      </div>
      <span v-if="promptCount > 1" class="ai-board-turn-nav">
        <button type="button" :aria-label="t('sessions.actions.previousMessage', { agent: card.session.agent })" :disabled="promptIndex <= 0" @click.stop="$emit('previousPrompt', card)">
          <ChevronLeft :size="13" />
        </button>
        <small>{{ promptIndex + 1 }} / {{ promptCount }}</small>
        <button type="button" :aria-label="t('sessions.actions.nextMessage', { agent: card.session.agent })" :disabled="promptIndex >= promptCount - 1" @click.stop="$emit('nextPrompt', card)">
          <ChevronRight :size="13" />
        </button>
      </span>
    </div>

    <AiSessionToolActivity
      v-if="promptIndex >= promptCount - 1 && !canResolveApproval(card.session)"
      class="ai-board-card-activity"
      :current-tool="card.session.currentTool"
      :phase="card.session.phase"
      :status="card.session.status"
      :summary="card.session.summary"
      :tool-calls-since-last-message="card.session.toolCallsSinceLastMessage"
      tone="board"
    />
    <span v-if="canResolveApproval(card.session)" class="ai-board-approval-actions">
      <button type="button" :disabled="approvalBusyKey === approvalKey(card, 'allow')" :title="t('sessions.actions.allow')" @click.stop="$emit('resolveApproval', card.instance, card.session, 'allow')">
        <Check :size="13" />
        <span>{{ t("sessions.actions.allow") }}</span>
      </button>
      <button type="button" :disabled="approvalBusyKey === approvalKey(card, 'skip')" :title="t('sessions.actions.skip')" @click.stop="$emit('resolveApproval', card.instance, card.session, 'skip')">
        <Ban :size="13" />
        <span>{{ t("sessions.actions.skip") }}</span>
      </button>
      <button type="button" :disabled="approvalBusyKey === approvalKey(card, 'deny')" :title="t('sessions.actions.deny')" @click.stop="$emit('resolveApproval', card.instance, card.session, 'deny')">
        <X :size="13" />
        <span>{{ t("sessions.actions.deny") }}</span>
      </button>
    </span>

      </article>
    </ContextMenuTrigger>
    <AiSessionCardContextMenu
      :bound-trigger-count="boundTriggers(card).length"
      :has-app-session="Boolean(card.session.appSessionId)"
      :can-open-app="Boolean(card.session.appSessionId || card.session.actions?.openApp)"
      :can-fork="card.session.actions?.fork === true"
      :is-forking="isForking"
      :is-stopping-app-session="isStoppingAppSession"
      :session-id="card.session.id"
      :session-name="card.session.title || displayAiSessionTitle(card.session, undefined, t) || card.session.id"
      :session-path="card.session.cwd"
      :is-trigger-bound="(configHash) => isTriggerBound(card, configHash)"
      :is-trigger-busy="(configHash) => triggerBusyKey === triggerActionKey(card, configHash)"
      :short-hash="shortHash"
      :story-target="storyTarget"
      :trigger-templates="triggerTemplates"
      @close-session="$emit('stopAppSession', card)"
      @open-app="$emit('openAiSessionApp', card.instance, card.session)"
      @fork-session="$emit('forkSession', card, $event)"
      @story-assigned="$emit('storyAssigned', card, $event)"
      @story-assign-failed="(target, error) => $emit('storyAssignFailed', card, target, error)"
      @toggle-trigger="$emit('toggleTrigger', card, $event)"
    />
  </ContextMenu>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Ban, Boxes, Check, ChevronLeft, ChevronRight, Folder, X } from "@lucide/vue";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import AiAgentIcon from "../../../components/AiAgentIcon.vue";
import AiSessionCardContextMenu from "../../../components/ai-session/AiSessionCardContextMenu.vue";
import AiSessionCardMarks from "../../../components/ai-session/AiSessionCardMarks.vue";
import AiSessionStatusIndicator from "../../../components/ai-session/AiSessionStatusIndicator.vue";
import AiSessionToolActivity from "../../../components/ai-session/AiSessionToolActivity.vue";
import { aiSessionStoryTarget, type AiSessionStoryTarget } from "../../../components/ai-session/storyTarget";
import type { AiSessionSummary, ControlPlaneTrigger, InstanceBoardItem, InstanceWithAiSessions, TriggerDeployment } from "../../../api/types";
import { ContextMenu, ContextMenuTrigger } from "../../../components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import AiSessionStreamingMarkdown from "../../../components/ai-session/AiSessionStreamingMarkdown.vue";
import { vAiSessionCardAutoScroll } from "../../../components/ai-session/aiSessionCardAutoScroll";
import {
  aiSessionBasename,
  displayAiSessionMessage,
  displayAiSessionTitle,
} from "../useInstanceSessions";
import type { AiBoardCard } from "./aiBoardTypes";

const { t } = useI18n();

const props = defineProps<{
  approvalBusyKey?: string;
  boundTriggers: (card: AiBoardCard) => TriggerDeployment[];
  canResolveApproval: (session: AiSessionSummary) => boolean;
  card: AiBoardCard;
  instanceDisplayName: (instance: InstanceBoardItem) => string;
  isTriggerBound: (card: AiBoardCard, configHash: string) => boolean;
  promptCount: number;
  promptIndex: number;
  selected?: boolean;
  showWorkspace?: boolean;
  shortHash: (value: string) => string;
  stoppingAppSessionKey?: string;
  forkingSessionKey?: string;
  triggerActionKey: (card: AiBoardCard, configHash: string) => string;
  triggerBusyKey: string;
  triggerTemplates: ControlPlaneTrigger[];
}>();

const emit = defineEmits<{
  nextPrompt: [card: AiBoardCard];
  openAiSessionApp: [instance: InstanceWithAiSessions, session?: AiSessionSummary];
  previousPrompt: [card: AiBoardCard];
  resolveApproval: [instance: InstanceWithAiSessions, session: AiSessionSummary, decision: "allow" | "deny" | "skip"];
  selectCard: [key: string];
  selectInstance: [instanceId: string];
  stopAppSession: [card: AiBoardCard];
  forkSession: [card: AiBoardCard, mode: "current" | "managed-worktree"];
  storyAssigned: [card: AiBoardCard, target: AiSessionStoryTarget];
  storyAssignFailed: [card: AiBoardCard, target: AiSessionStoryTarget, error: unknown];
  toggleTrigger: [card: AiBoardCard, configHash: string];
}>();

function approvalKey(card: AiBoardCard, decision: "allow" | "deny" | "skip") {
  return `${card.instance.id}:${card.session.id}:${decision}`;
}

const isStoppingAppSession = computed(() => props.stoppingAppSessionKey === props.card.key);
const isForking = computed(() => props.forkingSessionKey === props.card.key);
const storyTarget = computed(() => aiSessionStoryTarget(props.card.instance, props.card.session));
const agentIcon = computed<"codex" | "claude" | "opencode" | undefined>(() => {
  const agent = props.card.session.agent;
  return agent === "codex" || agent === "claude" || agent === "opencode" ? agent : undefined;
});
const agentDisplayName = computed(() => {
  const agent = props.card.session.agent;
  return agentIcon.value ? t(`common.products.${agent}`) : agent;
});
</script>

<style scoped>
.ai-board-card {
  box-sizing: border-box;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  position: relative;
  flex: 0 0 auto;
  width: 100%;
  height: 214px;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--ai-session-card-border);
  border-radius: 8px;
  background: var(--ai-board-card-bg);
}

.ai-board-card[data-selected="true"] {
  border-color: var(--ai-session-card-selected-border);
  background: var(--ai-session-card-selected-bg);
  outline: none;
}

.ai-board-card:focus-visible {
  outline: 2px solid var(--ai-board-active-border);
  outline-offset: 2px;
}

.ai-board-instance {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  align-items: center;
  gap: 9px;
  min-width: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 10px 0 10px 14px;
  text-align: left;
}

.ai-board-card-headline {
  min-width: 0;
}

.ai-board-card-context {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  color: var(--ai-board-muted);
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  white-space: nowrap;
}

.ai-board-card-context-item {
  display: inline-flex;
  align-items: center;
  flex: 0 1 auto;
  gap: 5px;
  min-width: 0;
}

.ai-board-card-context-item > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-board-card-context-item > svg,
.ai-board-card-context-separator,
.ai-board-card-agent {
  flex: 0 0 auto;
}

.ai-board-card-context-separator {
  color: var(--ai-board-column-border);
}

.ai-board-card-agent {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.ai-session-unread-dot {
  position: absolute;
  top: 13px;
  right: 32px;
  z-index: 4;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--status-info);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--status-info) 18%, transparent);
}

.ai-board-card:hover :deep(.ai-session-card-marks),
.ai-board-card:focus-within :deep(.ai-session-card-marks) {
  opacity: 1;
}

.ai-board-status-indicator {
  --ai-session-status-dot: var(--ai-board-dot-active);
  --ai-session-status-dot-shadow: var(--ai-board-dot-active-shadow);
  --ai-session-status-waiting: var(--ai-board-dot-waiting);
  --ai-session-status-waiting-shadow: var(--ai-board-dot-waiting-shadow);
  --ai-session-status-failed: var(--ai-board-dot-failed);
  --ai-session-status-failed-shadow: var(--ai-board-dot-failed-shadow);
  --ai-session-status-idle: var(--ai-board-dot-idle);
  --ai-session-status-idle-shadow: var(--ai-board-dot-idle-shadow);
}

.ai-board-content {
  display: grid;
  position: relative;
  grid-template-rows: max-content minmax(0, 1fr);
  gap: 6px;
  min-height: 0;
  min-width: 0;
  padding: 0 14px;
}

.ai-board-preview-field {
  display: grid;
  position: relative;
  min-width: 0;
}

.ai-board-preview-field-user {
  align-content: start;
  max-height: 18px;
  overflow: hidden;
  padding-block: 0;
}

.ai-board-preview-field-assistant {
  align-content: start;
  border-top: 1px solid var(--ai-session-card-divider);
  background: var(--ai-session-card-content-bg);
  font-size: 14px;
  line-height: 1.35;
  margin: 2px -14px 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: hidden;
  padding: 10px 14px 0;
  scrollbar-width: none;
}

.ai-board-preview-field-assistant::-webkit-scrollbar {
  display: none;
}

.ai-board-content::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 34px;
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--ai-session-card-content-bg) 0%, transparent),
    color-mix(in srgb, var(--ai-session-card-content-bg) 84%, transparent) 58%,
    var(--ai-session-card-content-bg)
  );
  pointer-events: none;
}

.ai-board-card[data-state="running"] .ai-board-content::after {
  height: 52px;
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--ai-session-card-content-bg) 0%, transparent),
    var(--ai-session-card-content-bg) 70%,
    var(--ai-session-card-content-bg) 100%
  );
}

.ai-board-question {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  overflow-wrap: anywhere;
  color: var(--ai-board-title);
  font-size: 14px;
  line-height: 1.35;
  word-break: break-word;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
}

.ai-board-message {
  display: block;
  min-width: 0;
  overflow: visible;
  overflow-wrap: anywhere;
  color: var(--ai-board-title);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.35;
  word-break: break-word;
}

.ai-board-message::after {
  content: "";
  display: block;
  height: 34px;
}

.ai-board-card[data-state="running"] .ai-board-message::after {
  height: 52px;
}

.ai-board-question :deep(*),
.ai-board-message :deep(*) {
  max-width: 100%;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.ai-board-question :deep(p),
.ai-board-message :deep(p) {
  margin: 0;
}

.ai-board-question :deep(code),
.ai-board-message :deep(code) {
  border-radius: 4px;
  background: var(--ai-board-code-bg);
  color: var(--ai-board-code-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.92em;
  font-weight: 400;
  padding: 1px 4px;
  white-space: normal;
}

.ai-board-message :deep(strong),
.ai-board-message :deep(b) {
  color: var(--ai-board-title);
}

.ai-board-turn-nav {
  display: inline-flex;
  position: absolute;
  right: 10px;
  bottom: 8px;
  z-index: 2;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
  height: 20px;
  min-height: 20px;
  border: 1px solid var(--ai-board-floating-border);
  border-radius: 6px;
  background: color-mix(in srgb, var(--ai-board-card-bg) 88%, transparent);
  color: var(--ai-board-floating-text);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  padding: 0 3px;
}

.ai-board-card-activity {
  position: absolute;
  right: 96px;
  bottom: 8px;
  left: 14px;
  z-index: 3;
  min-width: 0;
  overflow: hidden;
}

.ai-board-turn-nav button {
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.ai-board-turn-nav small {
  min-width: 26px;
  color: var(--ai-board-muted);
  font-size: 10px;
  line-height: 1;
  text-align: center;
}

.ai-board-turn-nav button:not(:disabled):hover {
  border-color: var(--ai-board-active-border);
  background: var(--ai-board-turn-hover-bg);
  color: var(--ai-board-floating-hover-text);
}

.ai-board-turn-nav button:disabled {
  cursor: default;
  opacity: 0.32;
}

.ai-board-approval-actions {
  display: inline-flex;
  position: absolute;
  bottom: 8px;
  left: 14px;
  z-index: 2;
  align-items: center;
  flex-wrap: nowrap;
  justify-content: flex-start;
  gap: 4px;
}

.ai-board-approval-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 0;
  height: 24px;
  border: 1px solid var(--ai-board-floating-border);
  border-radius: 6px;
  background: var(--ai-board-floating-bg);
  color: var(--ai-board-floating-text);
  cursor: pointer;
  font-size: 10px;
  font-weight: 800;
  padding: 0 6px;
}

.ai-board-approval-actions button:hover,
.ai-board-approval-actions button:focus-visible {
  border-color: var(--ai-board-floating-hover-border);
  color: var(--ai-board-floating-hover-text);
  outline: none;
}

.ai-board-approval-actions button:disabled {
  cursor: wait;
  opacity: 0.55;
}

</style>
