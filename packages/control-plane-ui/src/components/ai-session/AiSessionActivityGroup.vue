<template>
  <section class="ai-session-activity-group">
    <button v-if="summaryVisible" type="button" class="ai-session-activity-group-summary" :aria-expanded="groupOpen" @click="toggleGroup">
      <ChevronRight :size="15" />
      <span>{{ summaryLabel }}</span>
      <small v-if="latest">{{ latest.title }}</small>
    </button>
    <Transition
      name="activity-disclosure"
      @before-enter="prepareDisclosureEnter"
      @enter="runDisclosureEnter"
      @after-enter="finishDisclosureEnter"
      @enter-cancelled="cancelDisclosureTransition"
      @before-leave="prepareDisclosureLeave"
      @leave="runDisclosureLeave"
      @after-leave="finishDisclosureLeave"
      @leave-cancelled="cancelDisclosureTransition"
    >
      <div v-if="groupOpen" class="ai-session-activity-list">
        <div class="ai-session-activity-list-content" :class="{ 'ai-session-activity-list-inline': !summaryVisible }">
          <div
            v-for="activity in activities"
            :key="activity.id"
            class="ai-session-activity-item"
            :data-status="activity.status"
          >
            <button v-if="hasDetails(activity)" type="button" class="ai-session-activity-item-head" :aria-expanded="activityOpen(activity)" @click="toggleActivity(activity.id, $event)">
              <ChevronRight v-if="!activityIcon(activity)" class="ai-session-activity-disclosure-icon" :size="14" aria-hidden="true" />
              <component :is="activityIcon(activity)" v-else class="ai-session-activity-kind-icon" :size="14" aria-hidden="true" />
              <span class="ai-session-activity-title">{{ activityLabel(activity) }}</span>
              <span v-if="activitySummary(activity)" class="ai-session-activity-summary" :title="activityHoverText(activity)">{{ activitySummary(activity) }}</span>
              <small v-if="!isCommandActivity(activity) && visibleStatus(activity.status)">{{ statusLabel(activity.status!) }}</small>
              <ChevronRight v-if="isCommandActivity(activity)" class="ai-session-command-disclosure-icon" :size="14" aria-hidden="true" />
            </button>
            <div v-else class="ai-session-activity-item-head">
              <component :is="activityIcon(activity)" v-if="activityIcon(activity)" class="ai-session-activity-kind-icon" :size="14" aria-hidden="true" />
              <span class="ai-session-activity-title">{{ activityLabel(activity) }}</span>
              <span v-if="activitySummary(activity)" class="ai-session-activity-summary" :title="activityHoverText(activity)">{{ activitySummary(activity) }}</span>
              <small v-if="!isCommandActivity(activity) && visibleStatus(activity.status)">{{ statusLabel(activity.status!) }}</small>
            </div>
            <Transition name="activity-disclosure" @before-enter="prepareDisclosureEnter" @enter="runDisclosureEnter" @after-enter="finishDisclosureEnter" @enter-cancelled="cancelDisclosureTransition" @before-leave="prepareDisclosureLeave" @leave="runDisclosureLeave" @after-leave="finishDisclosureLeave" @leave-cancelled="cancelDisclosureTransition">
              <div v-if="hasDetails(activity) && activityOpen(activity)" class="ai-session-activity-details">
                <div class="ai-session-activity-details-content">
                  <AiSessionFileChanges v-if="fileChanges(activity).length" :changes="fileChanges(activity)" />
                  <AiSessionCommandResult v-else-if="isCommandActivity(activity)" :command="activity.input" :output="activity.output" :exit-code="activity.exitCode" />
                  <section v-else-if="activity.input">
                    <small>{{ t("sessions.timeline.input") }}</small>
                    <ScrollArea type="auto" :horizontal="false" class="ai-session-activity-pre-scroll">
                      <pre>{{ activity.input }}</pre>
                    </ScrollArea>
                  </section>
                  <section v-if="activity.output && !isCommandActivity(activity) && !fileChanges(activity).length">
                    <ContextMenu v-if="activity.activityKind === 'reasoning'" v-model:open="reasoningMenuOpen">
                      <ContextMenuTrigger as-child>
                        <div @contextmenu="handleReasoningContextMenu">
                          <MarkdownContent :content="activity.output" :code-tools="markdownCodeTools" />
                        </div>
                      </ContextMenuTrigger>
                      <ContextMenuContent class="ai-session-response-context-menu">
                        <ContextMenuItem :disabled="!selectedReasoningText" @select="emit('addToConversation', selectedReasoningText)">
                          <MessageSquarePlus :size="14" />{{ t("sessions.actions.addToConversation") }}
                        </ContextMenuItem>
                        <ContextMenuItem @select="copyReasoningText">
                          <Copy :size="14" />{{ t("sessions.markdown.copy") }}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                    <template v-else>
                      <small>{{ t("sessions.timeline.output") }}</small>
                      <ScrollArea type="auto" :horizontal="false" class="ai-session-activity-pre-scroll">
                        <pre>{{ activity.output }}</pre>
                      </ScrollArea>
                    </template>
                  </section>
                  <small v-if="activity.exitCode !== undefined && !isCommandActivity(activity)">{{ t("sessions.timeline.exitCode", { code: activity.exitCode }) }}</small>
                </div>
              </div>
            </Transition>
          </div>
        </div>
      </div>
    </Transition>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import MarkdownContent from "@task-handoff/web-theme/MarkdownContent.vue";
import { Copy, MessageSquarePlus } from "@lucide/vue";
import {
  Bot,
  BookOpen,
  Brain,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  FilePenLine,
  FileSearch,
  Image as ImageIcon,
  ListTodo,
  Minimize2,
  Download,
  Plug,
  Search,
  Sparkles,
  SquareTerminal,
  Users,
  Wrench,
} from "@lucide/vue";
import type { AiSessionTimelineActivity } from "@task-handoff/protocol/ai-sessions";
import { ScrollArea } from "../ui/scroll-area";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu";
import AiSessionCommandResult from "./AiSessionCommandResult.vue";
import AiSessionFileChanges from "./AiSessionFileChanges.vue";
import { aiSessionFileChanges } from "./aiSessionFileChanges";
import {
  beginDisclosureTransition,
  cancelDisclosureTransition,
  finishDisclosureEnter,
  finishDisclosureLeave,
  prepareDisclosureEnter,
  prepareDisclosureLeave,
  runDisclosureEnter,
  runDisclosureLeave,
} from "./disclosureTransition";

const activityIcons: Record<string, Component> = {
  reasoning: Brain,
  plan: ListTodo,
  hookPrompt: CircleHelp,
  commandExecution: SquareTerminal,
  fileChange: FilePenLine,
  mcpToolCall: Plug,
  dynamicToolCall: Wrench,
  collabAgentToolCall: Users,
  subAgentActivity: Bot,
  webSearch: Search,
  imageView: ImageIcon,
  sleep: Clock3,
  imageGeneration: Sparkles,
  enteredReviewMode: ClipboardCheck,
  exitedReviewMode: ClipboardCheck,
  contextCompaction: Minimize2,
  fileRead: BookOpen,
  fileSearch: FileSearch,
  webFetch: Download,
  todoUpdate: ListTodo,
  userQuestion: CircleHelp,
  skillLoad: Brain,
  exitedPlanMode: ClipboardCheck,
};

const props = withDefaults(defineProps<{
  activities: AiSessionTimelineActivity[];
  open?: boolean;
  summaryVisible?: boolean;
  autoExpandKinds?: string[];
}>(), { open: false, summaryVisible: true, autoExpandKinds: () => [] });
const emit = defineEmits<{ "update:open": [open: boolean]; addToConversation: [content: string] }>();
const { t } = useI18n();
const markdownCodeTools = computed(() => ({
  copiedLabel: t("sessions.markdown.copied"),
  copyLabel: t("sessions.markdown.copy"),
  plainTextLabel: t("sessions.markdown.plainText"),
}));
const latest = computed(() => props.activities.at(-1));
const summaryLabel = computed(() => t("sessions.timeline.activityCount", { count: props.activities.length }));
const fileChangesByActivityId = computed(() => new Map(props.activities.map((activity) => [activity.id, aiSessionFileChanges(activity)])));
const groupOpen = ref(props.summaryVisible ? props.open : true);
const openActivities = ref(new Set<string>());
const autoExpandedActivityIds = new Set<string>();
const reasoningMenuOpen = ref(false);
const selectedReasoningText = ref("");
watch(() => props.open, (value) => { if (props.summaryVisible) groupOpen.value = value; });
watch(() => [props.activities, props.autoExpandKinds] as const, ([activities, autoExpandKinds]) => {
  const automatic = activities
    .filter((activity) => autoExpandKinds.includes(activity.activityKind) && !autoExpandedActivityIds.has(activity.id))
    .map((activity) => activity.id);
  if (!automatic.length) return;
  automatic.forEach((id) => autoExpandedActivityIds.add(id));
  openActivities.value = new Set([...openActivities.value, ...automatic]);
}, { immediate: true, deep: true });
function toggleGroup(event: MouseEvent) { beginDisclosureTransition(event.currentTarget as Element); groupOpen.value = !groupOpen.value; emit("update:open", groupOpen.value); }
function activityOpen(activity: AiSessionTimelineActivity) { return openActivities.value.has(activity.id); }
function toggleActivity(id: string, event: MouseEvent) { beginDisclosureTransition(event.currentTarget as Element); const next = new Set(openActivities.value); next.has(id) ? next.delete(id) : next.add(id); openActivities.value = next; }
function handleReasoningContextMenu(event: MouseEvent) {
  const selection = window.getSelection();
  const text = selection?.toString().trim() || "";
  const host = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  if (!text || !host || !selection?.anchorNode || !host.contains(selection.anchorNode)) {
    selectedReasoningText.value = "";
    event.preventDefault();
    reasoningMenuOpen.value = false;
    return;
  }
  selectedReasoningText.value = text;
}
async function copyReasoningText() {
  if (selectedReasoningText.value) await navigator.clipboard?.writeText(selectedReasoningText.value);
}
function hasDetails(activity: AiSessionTimelineActivity) {
  if (isCommandActivity(activity)) return Boolean(activity.input || activity.output || activity.exitCode !== undefined);
  return Boolean(activity.input || activity.output || activity.exitCode !== undefined);
}
function fileChanges(activity: AiSessionTimelineActivity) {
  return fileChangesByActivityId.value.get(activity.id) || [];
}
function statusLabel(status: NonNullable<AiSessionTimelineActivity["status"]>) {
  return t(`sessions.timeline.status.${status}`);
}
function visibleStatus(status: AiSessionTimelineActivity["status"]) {
  return status === "running" || status === "failed";
}
function isCommandActivity(activity: AiSessionTimelineActivity) {
  return activity.activityKind === "commandExecution";
}
function activityIcon(activity: AiSessionTimelineActivity) {
  return activityIcons[activity.activityKind];
}
function activityLabel(activity: AiSessionTimelineActivity) {
  if (!isCommandActivity(activity)) return activity.title;
  return t(`sessions.timeline.commandStatus.${activity.status || "unknown"}`);
}
function activitySummary(activity: AiSessionTimelineActivity) {
  if (isCommandActivity(activity)) return activity.input?.trim() || "";
  if (activity.activityKind === "fileChange" && activity.paths?.length) {
    return activity.paths.map(runtimePathBasename).join(", ");
  }
  return activity.summary || activity.paths?.join(", ") || "";
}
function activityHoverText(activity: AiSessionTimelineActivity) {
  if (isCommandActivity(activity)) return activity.input?.trim() || undefined;
  return activity.activityKind === "fileChange" && activity.paths?.length
    ? activity.paths.join("\n")
    : undefined;
}
function runtimePathBasename(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
}
</script>

<style scoped>
.ai-session-activity-group {
  min-width: 0;
  color: var(--text-muted);
}
.ai-session-activity-group-summary {
  display: flex;
  align-items: center;
  gap: 5px;
  width: fit-content;
  max-width: 100%;
  cursor: pointer;
  list-style: none;
  user-select: none;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 14px;
  text-align: left;
}
.ai-session-activity-group-summary svg {
  flex: 0 0 auto;
  transition: transform 120ms ease;
}
.ai-session-activity-group-summary[aria-expanded="true"] svg { transform: rotate(90deg); }
.ai-session-activity-group-summary span {
  color: var(--text-muted);
  font-weight: 400;
}
.ai-session-activity-group-summary small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: inherit;
  line-height: inherit;
  white-space: nowrap;
}
.ai-session-activity-group-summary small::before { content: "\00b7"; margin-right: 5px; }
.ai-session-activity-list {
  min-width: 0;
}
.ai-session-activity-list-content {
  display: grid;
  gap: 6px;
  padding: 8px 0 0 20px;
}
.ai-session-activity-list-inline { padding: 0; }
.ai-session-activity-item {
  display: grid;
  gap: 0;
  min-width: 0;
}
.ai-session-activity-item-head {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
  color: var(--text-muted);
  font-size: 14px;
  line-height: 1.45;
  list-style: none;
  white-space: nowrap;
}
.ai-session-activity-item > button {
  cursor: pointer;
  user-select: none;
  border: 0;
  padding: 0;
  background: transparent;
  font-family: inherit;
  text-align: left;
}
.ai-session-activity-item-head > svg {
  flex: 0 0 auto;
  align-self: center;
  transition: transform 120ms ease;
}
.ai-session-activity-item-head > .ai-session-activity-kind-icon {
  color: var(--text-muted);
  transition: none;
}
.ai-session-activity-item > button[aria-expanded="true"] > .ai-session-activity-disclosure-icon { transform: rotate(90deg); }
.ai-session-activity-item-head > .ai-session-activity-title {
  flex: 0 0 auto;
  color: var(--text-muted);
  font-size: inherit;
  font-weight: 400;
}
.ai-session-activity-item-head > .ai-session-activity-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ai-session-activity-item-head > .ai-session-command-disclosure-icon { flex: 0 0 auto; margin-left: auto; transition: transform 120ms ease; }
.ai-session-activity-item-head[aria-expanded="true"] > .ai-session-command-disclosure-icon { transform: rotate(90deg); }
.ai-session-activity-item-head > .ai-session-activity-summary::before { content: "\00b7"; margin-right: 5px; }
.ai-session-activity-item-head small {
  flex: 0 0 auto;
  margin-left: auto;
  font-size: inherit;
}
.ai-session-activity-item[data-status="failed"] .ai-session-activity-item-head small { color: var(--status-danger); }
.ai-session-activity-item[data-status="failed"] .ai-session-activity-kind-icon,
.ai-session-activity-item[data-status="failed"] .ai-session-activity-title { color: var(--status-danger); }
.ai-session-activity-details {
  min-width: 0;
}
.ai-session-activity-details-content {
  padding-top: 9px;
  background-image: linear-gradient(var(--line-subtle), var(--line-subtle));
  background-repeat: no-repeat;
  background-position: 0 4px;
  background-size: 100% 1px;
}
.ai-session-activity-details section { display: grid; gap: 4px; margin-top: 4px; }
.ai-session-activity-details :deep(.markdown-content) {
  font-size: 14px;
  line-height: 1.55;
}
.ai-session-activity-details :deep(.markdown-content > :first-child) { margin-top: 0; }
.ai-session-activity-details :deep(.markdown-content > :last-child) { margin-bottom: 0; }
.ai-session-activity-pre-scroll {
  max-width: 100%;
  min-width: 0;
  border-left: 1px solid var(--line-subtle);
}
.ai-session-activity-pre-scroll :deep([data-reka-scroll-area-viewport]) {
  max-height: 280px;
}
.ai-session-activity-details pre {
  margin: 0;
  padding: 7px 0 7px 10px;
  border: 0;
  background: transparent;
  color: var(--text);
  font: 12px/1.45 var(--font-mono, monospace);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.activity-disclosure-enter-active,
.activity-disclosure-leave-active { overflow: hidden; transition: height 180ms ease, opacity 180ms ease; will-change: height; }
.activity-disclosure-enter-from,
.activity-disclosure-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .activity-disclosure-enter-active,
  .activity-disclosure-leave-active { transition-duration: 0ms; }
}
</style>
