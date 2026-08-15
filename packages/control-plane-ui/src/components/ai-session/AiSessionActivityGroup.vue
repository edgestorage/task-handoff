<template>
  <component
    :is="summaryVisible ? 'details' : 'div'"
    class="ai-session-activity-group"
    :open="summaryVisible ? open : undefined"
    @toggle="handleToggle"
  >
    <summary v-if="summaryVisible">
      <ChevronRight :size="15" />
      <span>{{ summaryLabel }}</span>
      <small v-if="latest">{{ latest.title }}</small>
    </summary>
    <div class="ai-session-activity-list" :class="{ 'ai-session-activity-list-inline': !summaryVisible }">
      <component
        :is="hasDetails(activity) ? 'details' : 'div'"
        v-for="activity in activities"
        :key="activity.id"
        class="ai-session-activity-item"
        :data-status="activity.status"
      >
        <summary v-if="hasDetails(activity)" class="ai-session-activity-item-head">
          <ChevronRight :size="14" aria-hidden="true" />
          <span class="ai-session-activity-title">{{ activity.title }}</span>
          <span v-if="activitySummary(activity)" class="ai-session-activity-summary" :title="activityHoverText(activity)">{{ activitySummary(activity) }}</span>
          <small v-if="visibleStatus(activity.status)">{{ statusLabel(activity.status!) }}</small>
        </summary>
        <div v-else class="ai-session-activity-item-head">
          <span class="ai-session-activity-title">{{ activity.title }}</span>
          <span v-if="activitySummary(activity)" class="ai-session-activity-summary" :title="activityHoverText(activity)">{{ activitySummary(activity) }}</span>
          <small v-if="visibleStatus(activity.status)">{{ statusLabel(activity.status!) }}</small>
        </div>
        <div v-if="hasDetails(activity)" class="ai-session-activity-details">
          <section v-if="activity.input">
            <small>{{ t("sessions.timeline.input") }}</small>
            <pre>{{ activity.input }}</pre>
          </section>
          <section v-if="activity.output">
            <small>{{ t("sessions.timeline.output") }}</small>
            <pre>{{ activity.output }}</pre>
          </section>
          <small v-if="activity.exitCode !== undefined">{{ t("sessions.timeline.exitCode", { code: activity.exitCode }) }}</small>
        </div>
      </component>
    </div>
  </component>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronRight } from "@lucide/vue";
import type { AiSessionTimelineActivity } from "@task-handoff/protocol/ai-sessions";

const props = withDefaults(defineProps<{
  activities: AiSessionTimelineActivity[];
  open?: boolean;
  summaryVisible?: boolean;
}>(), { open: false, summaryVisible: true });
const emit = defineEmits<{ "update:open": [open: boolean] }>();
const { t } = useI18n();
const latest = computed(() => props.activities.at(-1));
const summaryLabel = computed(() => t("sessions.timeline.activityCount", { count: props.activities.length }));
function handleToggle(event: Event) {
  if (props.summaryVisible) emit("update:open", (event.currentTarget as HTMLDetailsElement).open);
}
function hasDetails(activity: AiSessionTimelineActivity) {
  return Boolean(activity.input || activity.output || activity.exitCode !== undefined);
}
function statusLabel(status: NonNullable<AiSessionTimelineActivity["status"]>) {
  return t(`sessions.timeline.status.${status}`);
}
function visibleStatus(status: AiSessionTimelineActivity["status"]) {
  return status === "running" || status === "failed";
}
function activitySummary(activity: AiSessionTimelineActivity) {
  if (activity.activityKind === "fileChange" && activity.paths?.length) {
    return activity.paths.map(runtimePathBasename).join(", ");
  }
  return activity.summary || activity.paths?.join(", ") || "";
}
function activityHoverText(activity: AiSessionTimelineActivity) {
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
.ai-session-activity-group > summary {
  display: flex;
  align-items: center;
  gap: 5px;
  width: fit-content;
  max-width: 100%;
  cursor: pointer;
  list-style: none;
  font-size: 14px;
  user-select: none;
}
.ai-session-activity-group > summary::-webkit-details-marker,
.ai-session-activity-item > summary::-webkit-details-marker { display: none; }
.ai-session-activity-group > summary svg {
  flex: 0 0 auto;
  transition: transform 120ms ease;
}
.ai-session-activity-group[open] > summary svg { transform: rotate(90deg); }
.ai-session-activity-group > summary span {
  color: var(--text-muted);
  font-weight: 400;
}
.ai-session-activity-group > summary small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: inherit;
  line-height: inherit;
  white-space: nowrap;
}
.ai-session-activity-group > summary small::before { content: "\00b7"; margin-right: 5px; }
.ai-session-activity-list {
  display: grid;
  gap: 6px;
  margin: 8px 0 0 20px;
}
.ai-session-activity-list-inline { margin: 0; }
.ai-session-activity-item {
  display: grid;
  gap: 5px;
  min-width: 0;
}
.ai-session-activity-item-head {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.45;
  list-style: none;
  white-space: nowrap;
}
.ai-session-activity-item > summary { cursor: pointer; user-select: none; }
.ai-session-activity-item-head > svg {
  flex: 0 0 auto;
  align-self: center;
  transition: transform 120ms ease;
}
.ai-session-activity-item[open] > summary > svg { transform: rotate(90deg); }
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
.ai-session-activity-item-head > .ai-session-activity-summary::before { content: "\00b7"; margin-right: 5px; }
.ai-session-activity-item-head small {
  flex: 0 0 auto;
  margin-left: auto;
  font-size: 12px;
}
.ai-session-activity-item[data-status="failed"] .ai-session-activity-item-head small { color: var(--status-danger); }
.ai-session-activity-details {
  margin-top: 2px;
  padding-top: 7px;
  border-top: 1px solid var(--line-subtle);
}
.ai-session-activity-details section { display: grid; gap: 4px; margin-top: 8px; }
.ai-session-activity-details pre {
  max-height: 280px;
  margin: 0;
  padding: 7px 0 7px 10px;
  overflow: auto;
  border: 0;
  border-left: 1px solid var(--line-subtle);
  background: transparent;
  color: var(--text);
  font: 12px/1.45 var(--font-mono, monospace);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
