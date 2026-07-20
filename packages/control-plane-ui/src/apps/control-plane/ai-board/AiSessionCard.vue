<template>
  <article
    class="ai-board-card"
    :data-state="card.session.status"
    :data-selected="selected ? 'true' : undefined"
    role="button"
    tabindex="0"
    @click="$emit('selectCard', card.key)"
    @keydown.enter.prevent="$emit('selectCard', card.key)"
    @keydown.space.prevent="$emit('selectCard', card.key)"
  >
    <div class="ai-board-card-headline">
      <button type="button" class="ai-board-instance" @click.stop="$emit('selectCard', card.key)">
        <span class="ai-board-dot" />
        <span>
          <strong>{{ instanceDisplayName(card.instance) }}</strong>
          <small>{{ aiSessionAppDisplayName(card.appTab, card.session.agent) }}</small>
        </span>
      </button>
    </div>

    <div class="ai-board-content">
      <div class="ai-board-preview-field ai-board-preview-field-user">
        <MarkdownContent class="ai-board-question" :content="displayAiSessionTitle(card.session, promptIndex)" />
      </div>
      <div class="ai-board-preview-field ai-board-preview-field-assistant">
        <AiSessionStreamingMarkdown
          class="ai-board-message"
          :content="displayAiSessionMessage(card.session, promptIndex)"
          :instance-id="card.instance.id"
          :is-latest="promptIndex >= promptCount - 1"
          :session-id="card.session.id"
        />
      </div>
      <span v-if="promptCount > 1" class="ai-board-turn-nav">
        <button type="button" :aria-label="`Previous user message for ${card.session.agent}`" :disabled="promptIndex <= 0" @click.stop="$emit('previousPrompt', card)">
          <ChevronLeft :size="13" />
        </button>
        <small>{{ promptIndex + 1 }} / {{ promptCount }}</small>
        <button type="button" :aria-label="`Next user message for ${card.session.agent}`" :disabled="promptIndex >= promptCount - 1" @click.stop="$emit('nextPrompt', card)">
          <ChevronRight :size="13" />
        </button>
      </span>
    </div>

    <AiSessionToolActivity
      v-if="!canResolveApproval(card.session)"
      class="ai-board-card-activity"
      :current-tool="card.session.currentTool"
      :phase="card.session.phase"
      :status="card.session.status"
      :summary="card.session.summary"
      :tool-calls-since-last-message="card.session.toolCallsSinceLastMessage"
      tone="board"
    />
    <span v-if="canResolveApproval(card.session)" class="ai-board-approval-actions">
      <button type="button" :disabled="approvalBusyKey === approvalKey(card, 'allow')" title="Allow" @click.stop="$emit('resolveApproval', card.instance, card.session, 'allow')">
        <Check :size="13" />
        <span>Allow</span>
      </button>
      <button type="button" :disabled="approvalBusyKey === approvalKey(card, 'skip')" title="Skip" @click.stop="$emit('resolveApproval', card.instance, card.session, 'skip')">
        <Ban :size="13" />
        <span>Skip</span>
      </button>
      <button type="button" :disabled="approvalBusyKey === approvalKey(card, 'deny')" title="Deny" @click.stop="$emit('resolveApproval', card.instance, card.session, 'deny')">
        <X :size="13" />
        <span>Deny</span>
      </button>
    </span>

    <div class="ai-board-card-tools" aria-label="AI session card controls">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button type="button" class="ai-board-trigger-button ai-session-card-action" :data-bound="boundTriggers(card).length ? 'true' : undefined" :title="triggerButtonTitle(card)" @click.stop>
            <Zap :size="13" />
            <small v-if="boundTriggers(card).length">{{ boundTriggers(card).length }}</small>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent class="ai-board-trigger-menu" align="end" :side-offset="6" @click.stop>
          <div class="ai-board-trigger-search" @click.stop @keydown.stop>
            <input v-model="triggerSearch" type="search" placeholder="Search triggers" aria-label="Search triggers" />
          </div>
          <DropdownMenuItem v-if="!triggerTemplates.length" class="ai-board-trigger-menu-empty" disabled>No trigger templates</DropdownMenuItem>
          <DropdownMenuItem v-else-if="!filteredTriggerTemplates.length" class="ai-board-trigger-menu-empty" disabled>No matching triggers</DropdownMenuItem>
          <template v-else>
            <DropdownMenuItem
              v-for="trigger in filteredTriggerTemplates"
              :key="`${card.key}:${trigger.configHash}`"
              class="ai-board-trigger-menu-item"
              :disabled="triggerBusyKey === triggerActionKey(card, trigger.configHash)"
              @select="$emit('toggleTrigger', card, trigger.configHash)"
            >
              <Check v-if="isTriggerBound(card, trigger.configHash)" :size="13" />
              <Zap v-else :size="13" />
              <span>
                <strong>{{ trigger.config.name }}</strong>
                <small>{{ trigger.config.source.type }} · {{ shortHash(trigger.configHash) }}</small>
              </span>
              <small>{{ isTriggerBound(card, trigger.configHash) ? "Remove" : "Add" }}</small>
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
      <button type="button" class="ai-board-open ai-session-card-action" :aria-label="`Open app session for ${card.session.agent}`" title="Open app session" @click.stop="$emit('openAiSessionApp', card.instance, card.session)">
        <ExternalLink :size="14" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button type="button" class="ai-board-more ai-session-card-action" :aria-label="`More actions for ${card.session.agent}`" title="More actions" @click.stop>
            <MoreHorizontal :size="14" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent class="ai-board-card-menu" align="end" :side-offset="6" @click.stop>
          <DropdownMenuItem class="ai-board-card-menu-item danger" :disabled="isStoppingAppSession" @select="$emit('stopAppSession', card)">
            <Square :size="13" />
            <span>{{ isStoppingAppSession ? "Closing app session" : "Close app session" }}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { Ban, Check, ChevronLeft, ChevronRight, ExternalLink, MoreHorizontal, Square, X, Zap } from "@lucide/vue";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import AiSessionToolActivity from "../../../components/ai-session/AiSessionToolActivity.vue";
import type { AiSessionSummary, ControlPlaneTrigger, InstanceBoardItem, InstanceWithAiSessions, TriggerDeployment } from "../../../api/types";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import AiSessionStreamingMarkdown from "../../../components/ai-session/AiSessionStreamingMarkdown.vue";
import {
  aiSessionAppDisplayName,
  displayAiSessionMessage,
  displayAiSessionTitle,
} from "../useInstanceSessions";
import type { AiBoardCard } from "./aiBoardTypes";

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
  shortHash: (value: string) => string;
  stoppingAppSessionKey?: string;
  triggerActionKey: (card: AiBoardCard, configHash: string) => string;
  triggerBusyKey: string;
  triggerButtonTitle: (card: AiBoardCard) => string;
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
  toggleTrigger: [card: AiBoardCard, configHash: string];
}>();

function approvalKey(card: AiBoardCard, decision: "allow" | "deny" | "skip") {
  return `${card.instance.id}:${card.session.id}:${decision}`;
}

const triggerSearch = ref("");
const isStoppingAppSession = computed(() => props.stoppingAppSessionKey === props.card.key);
const filteredTriggerTemplates = computed(() => {
  const query = triggerSearch.value.trim().toLowerCase();
  if (!query) {
    return props.triggerTemplates;
  }
  return props.triggerTemplates.filter((trigger) => {
    const searchable = [
      trigger.config.name,
      trigger.config.source.type,
      trigger.configHash,
    ].join(" ").toLowerCase();
    return searchable.includes(query);
  });
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
  border: 1px solid var(--ai-board-column-border);
  border-radius: 8px;
  background: var(--ai-board-card-bg);
}

.ai-board-card[data-state="running"] {
  border-color: var(--ai-board-card-active-border);
}

.ai-board-card[data-state="waiting"] {
  border-color: var(--ai-board-card-waiting-border);
}

.ai-board-card[data-state="idle"] {
  border-color: var(--ai-board-card-idle-border);
}

.ai-board-card[data-state="failed"] {
  border-color: var(--ai-board-card-failed-border);
}

.ai-board-card[data-selected="true"] {
  border-color: var(--ai-board-active-border);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ai-board-active-border) 72%, transparent),
    0 14px 34px color-mix(in srgb, var(--ai-board-active-border) 18%, transparent);
  outline: none;
}

.ai-board-card:focus-visible {
  outline: 2px solid var(--ai-board-active-border);
  outline-offset: 2px;
}

.ai-board-instance {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr);
  align-items: start;
  gap: 9px;
  min-width: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 10px 112px 8px 14px;
  text-align: left;
}

.ai-board-instance span:last-child {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.ai-board-instance strong,
.ai-board-instance small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-board-instance strong {
  color: var(--ai-board-title);
  font-size: 13px;
  font-weight: 800;
  line-height: 1.2;
}

.ai-board-instance small {
  color: var(--ai-board-muted);
  font-size: 12px;
}

.ai-board-dot {
  width: 8px;
  height: 8px;
  margin-top: 4px;
  border-radius: 999px;
  background: var(--ai-board-dot-active);
  box-shadow: var(--ai-board-dot-active-shadow);
}

.ai-board-card[data-state="waiting"] .ai-board-dot {
  background: var(--ai-board-dot-waiting);
  box-shadow: var(--ai-board-dot-waiting-shadow);
}

.ai-board-card[data-state="failed"] .ai-board-dot {
  background: var(--ai-board-dot-failed);
  box-shadow: var(--ai-board-dot-failed-shadow);
}

.ai-board-card[data-state="idle"] .ai-board-dot {
  background: var(--ai-board-dot-idle);
  box-shadow: var(--ai-board-dot-idle-shadow);
}

.ai-board-content {
  display: grid;
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
  background: var(--ai-board-assistant-bg);
  margin: 2px -14px 0;
  min-height: 0;
  overflow: hidden;
  padding: 10px 14px 0;
}

.ai-board-preview-field-assistant::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 34px;
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--ai-board-assistant-bg) 0%, transparent),
    color-mix(in srgb, var(--ai-board-assistant-bg) 84%, transparent) 58%,
    var(--ai-board-assistant-bg)
  );
  pointer-events: none;
}

.ai-board-card[data-state="running"] .ai-board-preview-field-assistant::after {
  height: 52px;
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--ai-board-assistant-bg) 0%, transparent),
    var(--ai-board-assistant-bg) 70%,
    var(--ai-board-assistant-bg) 100%
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
  max-height: 100%;
  overflow: hidden;
  overflow-wrap: anywhere;
  color: var(--ai-board-title);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.35;
  word-break: break-word;
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

.ai-board-card-tools {
  display: flex;
  position: absolute;
  top: 9px;
  right: 10px;
  align-items: center;
  flex-wrap: nowrap;
  justify-content: flex-end;
  gap: 5px;
  width: max-content;
  max-width: calc(100% - 20px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
  z-index: 3;
}

.ai-board-card:hover .ai-board-card-tools,
.ai-board-card:focus-within .ai-board-card-tools {
  opacity: 1;
  pointer-events: auto;
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

.ai-board-trigger-button {
  gap: 2px;
  width: auto;
  padding: 0 5px;
}

.ai-board-trigger-button:not([data-bound="true"]) {
  width: 24px;
  padding: 0;
}

.ai-board-trigger-button[data-bound="true"] {
  border-color: var(--ai-board-active-border);
  color: var(--ai-board-active-text);
}

.ai-board-trigger-button small {
  font-size: 10px;
  font-weight: 850;
  line-height: 1;
}

:global(.ai-board-trigger-menu) {
  min-width: 250px;
  border: 1px solid var(--ai-board-column-border);
  background: color-mix(in srgb, var(--ai-board-column-bg) 94%, transparent);
  color: var(--ai-board-title);
  -webkit-backdrop-filter: blur(16px) saturate(1.16);
  backdrop-filter: blur(16px) saturate(1.16);
  padding: 6px;
}

:global(.ai-board-trigger-search) {
  padding: 4px 4px 6px;
}

:global(.ai-board-trigger-search input) {
  width: 100%;
  min-width: 0;
  height: 28px;
  border: 1px solid var(--ai-board-floating-border);
  border-radius: 6px;
  background: var(--ai-board-floating-bg);
  color: var(--ai-board-title);
  font-size: 12px;
  outline: none;
  padding: 0 8px;
}

:global(.ai-board-trigger-search input::placeholder) {
  color: var(--ai-board-muted);
}

:global(.ai-board-trigger-search input:focus) {
  border-color: var(--ai-board-active-border);
}

:global(.ai-board-trigger-menu-empty) {
  min-height: 30px;
  color: var(--ai-board-muted);
  font-size: 12px;
}

:global(.ai-board-trigger-menu-item) {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  gap: 8px;
  min-height: 34px;
  border-radius: 6px;
  font-size: 12px;
  padding: 6px 8px;
}

:global(.ai-board-trigger-menu-item span) {
  display: grid;
  min-width: 0;
}

:global(.ai-board-trigger-menu-item strong),
:global(.ai-board-trigger-menu-item small) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.ai-board-trigger-menu-item strong) {
  color: var(--ai-board-title);
  font-size: 12px;
  font-weight: 800;
  line-height: 1.2;
}

:global(.ai-board-trigger-menu-item small) {
  color: var(--ai-board-muted);
  font-size: 11px;
  line-height: 1.2;
}

:global(.ai-board-card-menu) {
  min-width: 190px;
  border: 1px solid var(--ai-board-column-border);
  background: color-mix(in srgb, var(--ai-board-column-bg) 94%, transparent);
  color: var(--ai-board-title);
  -webkit-backdrop-filter: blur(16px) saturate(1.16);
  backdrop-filter: blur(16px) saturate(1.16);
  padding: 6px;
}

:global(.ai-board-card-menu-item) {
  min-height: 32px;
  border-radius: 6px;
  font-size: 12px;
  padding: 6px 8px;
}

:global(.ai-board-card-menu-item.danger) {
  color: var(--ai-board-stale-text);
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
<style scoped src="../../../components/ai-session/AiSessionCardAction.css"></style>
