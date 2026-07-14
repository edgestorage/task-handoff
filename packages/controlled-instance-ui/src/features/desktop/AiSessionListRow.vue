<template>
  <article
    class="ai-session-row"
    :data-state="session.status"
    :data-selected="selected"
    :data-expanded="expandedPreview?.sessionId === session.id ? expandedPreview.kind : undefined"
  >
    <div
      class="ai-session-select"
      role="button"
      tabindex="0"
      @click="$emit('select', session.id)"
      @keydown.enter.prevent="$emit('select', session.id)"
      @keydown.space.prevent="$emit('select', session.id)"
    >
      <div class="ai-session-status">
        <span class="ai-session-dot" />
        <strong>{{ sessionTitle }}</strong>
        <small>{{ aiSessionStatusLabel(session) }}</small>
      </div>
      <div class="ai-session-preview-field ai-session-preview-field-user" data-ai-preview-trigger @click.stop="$emit('expand-prompt', session.id)">
        <MarkdownContent class="ai-session-question" :content="displayAiSessionTitle(session, promptIndex)" />
        <small>展开用户消息</small>
      </div>
      <div class="ai-session-preview-field ai-session-preview-field-assistant" data-ai-preview-trigger @click.stop="$emit('expand-message', session.id)">
        <MarkdownContent class="ai-session-message" :content="displayAiSessionMessage(session, promptIndex)" />
        <small>展开 AI 进展</small>
      </div>
      <div class="ai-session-card-meta">
        <small class="ai-session-context">{{ aiSessionContext(session) }}</small>
        <span v-if="promptCount > 1" class="ai-session-turn-nav">
          <button type="button" :aria-label="`Previous user message for ${session.agent}`" @click.stop="$emit('previous-prompt', session)">
            <ChevronLeft :size="13" />
          </button>
          <small>{{ promptIndex + 1 }} / {{ promptCount }}</small>
          <button type="button" :aria-label="`Next user message for ${session.agent}`" @click.stop="$emit('next-prompt', session)">
            <ChevronRight :size="13" />
          </button>
        </span>
      </div>
    </div>
    <div v-if="expandedPreview?.sessionId === session.id" class="ai-session-expanded-preview" @click.stop="$emit('collapse-expanded-preview')">
      <div class="ai-session-expanded-head">
        <strong>{{ expandedPreview.kind === "prompt" ? "User Message" : "AI Response / Progress" }}</strong>
        <small>滚动查看完整内容</small>
      </div>
      <ScrollArea class="ai-session-expanded-content">
        <MarkdownContent class="ai-session-expanded-content-inner" :content="expandedContent()" />
      </ScrollArea>
    </div>
    <div class="ai-session-card-tools" aria-label="AI session card controls">
      <button
        v-if="hasAppSession"
        type="button"
        class="ai-session-open"
        :aria-label="`Open app session for ${session.agent}`"
        title="Open app session"
        @click="$emit('open-app-session', session)"
      >
        <ExternalLink :size="14" />
      </button>
    </div>
  </article>
</template>

<script setup lang="ts">
import { ChevronLeft, ChevronRight, ExternalLink } from "@lucide/vue";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import type { AiSessionSummary } from "../../api/types";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  aiSessionContext,
  aiSessionStatusLabel,
  displayAiSessionMessage,
  displayAiSessionTitle,
  type ExpandedAiSessionPreview,
} from "./useAiSessionDisplay";

const props = defineProps<{
  expandedPreview?: ExpandedAiSessionPreview;
  hasAppSession: boolean;
  promptCount: number;
  promptIndex: number;
  selected: boolean;
  session: AiSessionSummary;
  sessionTitle: string;
}>();

defineEmits<{
  "collapse-expanded-preview": [];
  "expand-message": [sessionId: string];
  "expand-prompt": [sessionId: string];
  "next-prompt": [session: AiSessionSummary];
  "open-app-session": [session: AiSessionSummary];
  "previous-prompt": [session: AiSessionSummary];
  select: [sessionId: string];
}>();

function expandedContent() {
  const content = props.expandedPreview?.kind === "prompt"
    ? displayAiSessionTitle(props.session, props.promptIndex)
    : displayAiSessionMessage(props.session, props.promptIndex);
  return content;
}
</script>

<style scoped>
.ai-session-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  position: relative;
  flex: 0 0 auto;
  width: 100%;
  height: 162px;
  min-width: 0;
  border: 1px solid var(--ai-session-row-border);
  border-radius: 8px;
  background: var(--ai-session-row-bg);
  color: var(--ai-session-row-text);
  overflow: hidden;
}

.ai-session-row[data-selected="true"] {
  border-color: var(--ai-session-row-selected-border);
  background: var(--ai-session-row-selected-bg);
}

.ai-session-select {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  gap: 6px;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  min-width: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 10px 112px 6px 14px;
  text-align: left;
}

.ai-session-row[data-state="waiting"] {
  border-color: var(--ai-session-row-waiting-border);
}

.ai-session-row[data-state="idle"] {
  border-color: var(--ai-session-row-idle-border);
}

.ai-session-row[data-state="failed"] {
  border-color: var(--ai-session-row-failed-border);
}

.ai-session-row:hover,
.ai-session-select:focus-visible {
  background: var(--ai-session-row-selected-bg);
}

.ai-session-select:focus-visible,
.ai-session-open:focus-visible {
  outline: 2px solid var(--ai-session-focus-outline);
  outline-offset: 2px;
}

.ai-session-status {
  display: grid;
  grid-template-columns: 8px minmax(0, 1fr) auto;
  min-width: 0;
  gap: 8px;
  align-items: center;
}

.ai-session-status strong,
.ai-session-question,
.ai-session-message,
.ai-session-context {
  overflow: hidden;
}

.ai-session-row small {
  color: var(--text-muted);
  font-size: 12px;
}

.ai-session-preview-field {
  display: grid;
  position: relative;
  min-width: 0;
  cursor: zoom-in;
}

.ai-session-preview-field-assistant {
  align-content: start;
  background: var(--ai-session-assistant-bg);
  margin: 2px -14px 0;
  min-height: 0;
  overflow: hidden;
  padding: 10px 14px;
}

.ai-session-preview-field-assistant::after {
  content: "";
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 34px;
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--ai-session-assistant-bg) 0%, transparent),
    color-mix(in srgb, var(--ai-session-assistant-bg) 84%, transparent) 58%,
    var(--ai-session-assistant-bg)
  );
  pointer-events: none;
}

.ai-session-preview-field > small {
  position: absolute;
  right: 8px;
  bottom: 6px;
  z-index: 1;
  border: 1px solid var(--ai-session-preview-pill-border);
  border-radius: 999px;
  background: var(--ai-session-preview-pill-bg);
  color: var(--ai-session-preview-pill-text);
  font-size: 10px;
  font-weight: 800;
  line-height: 16px;
  opacity: 0;
  padding: 0 7px;
  pointer-events: none;
  transform: translateY(-2px);
  transition:
    opacity 120ms ease,
    transform 120ms ease;
}

.ai-session-preview-field-assistant > small {
  border-color: var(--ai-session-assistant-pill-border);
  background: var(--ai-session-assistant-pill-bg);
  color: var(--ai-session-assistant-pill-text);
}

.ai-session-preview-field:hover > small,
.ai-session-preview-field:focus-within > small {
  opacity: 1;
  transform: translateY(0);
}

.ai-session-question {
  display: -webkit-box;
  min-width: 0;
  overflow: hidden;
  color: var(--ai-session-title);
  font-size: 13px;
  font-weight: 800;
  line-height: 1.35;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.ai-session-message {
  display: block;
  min-width: 0;
  max-height: 100%;
  overflow: hidden;
  color: var(--ai-session-title);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.35;
}

.ai-session-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--ai-session-dot-running);
}

.ai-session-row[data-state="waiting"] .ai-session-dot {
  background: var(--ai-session-dot-waiting);
}

.ai-session-row[data-state="idle"] .ai-session-dot {
  background: var(--ai-session-dot-idle);
}

.ai-session-row[data-state="failed"] .ai-session-dot {
  background: var(--ai-session-dot-failed);
}

.ai-session-message :deep(code) {
  border-radius: 4px;
  background: var(--ai-session-code-bg);
  padding: 0 3px;
  color: var(--ai-session-code-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 0.92em;
  font-weight: 400;
}

.ai-session-message :deep(strong),
.ai-session-message :deep(b) {
  color: var(--ai-session-title);
}

.ai-session-open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--ai-session-floating-border);
  border-radius: 6px;
  background: var(--ai-session-chip-bg);
  color: var(--ai-session-floating-text);
  cursor: pointer;
}

.ai-session-card-tools {
  display: flex;
  position: absolute;
  top: 9px;
  right: 10px;
  align-items: center;
  gap: 5px;
  justify-content: flex-end;
  flex-wrap: nowrap;
  min-width: 77px;
  max-width: calc(100% - 20px);
  z-index: 3;
}

.ai-session-expanded-preview {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  position: absolute;
  inset: 0;
  z-index: 4;
  gap: 8px;
  border-radius: 8px;
  background: var(--ai-session-expanded-bg);
  color: var(--ai-session-expanded-text);
  cursor: default;
  padding: 13px 14px;
}

.ai-session-expanded-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.ai-session-expanded-head strong {
  color: var(--ai-session-title);
  font-size: 12px;
  font-weight: 850;
}

.ai-session-expanded-head small {
  color: var(--ai-session-muted);
  font-size: 11px;
}

.ai-session-expanded-content {
  min-height: 0;
}

.ai-session-expanded-content-inner {
  color: var(--ai-session-expanded-text);
  font-size: 13px;
  line-height: 1.48;
  overflow-wrap: anywhere;
  padding-right: 4px;
  white-space: normal;
}

.ai-session-turn-nav {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  height: 20px;
  min-height: 20px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ai-session-floating-text);
  gap: 2px;
  padding: 0;
  cursor: pointer;
}

.ai-session-turn-nav button {
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

.ai-session-turn-nav small {
  min-width: 26px;
  color: var(--ai-session-muted);
  font-size: 10px;
  line-height: 1;
  text-align: center;
}

.ai-session-turn-nav button:hover {
  border-color: var(--ai-board-active-border);
  background: var(--ai-session-turn-hover-bg);
  color: var(--ai-session-detail-open-text);
}

.ai-session-open:hover {
  border-color: var(--ai-session-floating-hover-border);
  color: var(--ai-session-detail-open-text);
}

.ai-session-card-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  min-height: 20px;
}

.ai-session-card-meta > small {
  flex: 1 1 auto;
}
</style>
