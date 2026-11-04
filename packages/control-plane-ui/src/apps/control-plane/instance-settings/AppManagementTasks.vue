<template>
  <div class="app-tasks">
    <p v-if="!groups.active.length && !groups.recent.length" class="app-tasks-empty">{{ t("instances.settings.noAppTasks") }}</p>
    <section v-for="group in taskSections" v-show="group.jobs.length" :key="group.id" class="app-task-group" :aria-label="group.label">
      <h4>{{ group.label }} <span>{{ group.jobs.length }}</span></h4>
      <Collapsible v-for="job in group.jobs" :key="job.id" :open="selectedJobId === job.id" class="app-task" @update:open="selectedJobId = $event ? job.id : ''">
        <div class="app-task-row">
          <LoaderCircle v-if="job.state === 'running'" class="app-task-icon animate-spin motion-reduce:animate-none" :size="16" aria-hidden="true" />
          <Clock3 v-else-if="job.state === 'queued'" class="app-task-icon" :size="16" aria-hidden="true" />
          <CheckCircle2 v-else-if="job.state === 'succeeded'" class="app-task-success" :size="16" aria-hidden="true" />
          <CircleX v-else-if="job.state === 'cancelled'" class="app-task-note" :size="16" aria-hidden="true" />
          <CircleAlert v-else class="app-task-error" :size="16" aria-hidden="true" />
          <div class="app-task-copy">
            <span class="app-task-name">{{ appName(job) }} <span class="app-task-operation">{{ operationLabel(job) }}</span></span>
            <span class="app-task-status" :class="{ 'app-task-error': job.state === 'failed' || job.state === 'interrupted' }" role="status">
              {{ t(appTaskStatusKey(job), { operation: operationLabel(job) }) }}<template v-if="job.state === 'running' && job.phase"> · {{ phaseLabel(job.phase) }}</template><template v-if="job.state === 'running' && appTaskProgress(job) !== undefined"> · {{ Math.round(appTaskProgress(job)!) }}%</template>
            </span>
            <Progress v-if="job.state === 'running' && appTaskProgress(job) !== undefined" :model-value="appTaskProgress(job)" class="app-task-progress" />
            <time class="app-task-time" :datetime="job.finishedAt || job.requestedAt">{{ dateLabel(job.finishedAt || job.requestedAt) }}</time>
          </div>
          <div class="app-task-actions">
            <Button v-if="retryableAppTask(snapshot, job)" size="sm" variant="outline" :disabled="Boolean(submitting)" @click="emit('retry', job)">{{ t("instances.settings.retry") }}</Button>
            <CollapsibleTrigger as-child>
              <Button size="sm" variant="ghost" :aria-label="t('instances.settings.appTaskDetails', { name: appName(job), operation: operationLabel(job) })">
                {{ t("instances.settings.taskDetails") }}<ChevronDown :size="14" :class="{ 'app-task-chevron-open': selectedJobId === job.id }" aria-hidden="true" />
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <div class="app-task-detail">
            <dl>
              <div><dt>{{ t("instances.settings.taskRequestedAt") }}</dt><dd>{{ dateLabel(job.requestedAt) }}</dd></div>
              <div v-if="job.startedAt"><dt>{{ t("instances.settings.taskStartedAt") }}</dt><dd>{{ dateLabel(job.startedAt) }}</dd></div>
              <div v-if="job.finishedAt"><dt>{{ t("instances.settings.taskFinishedAt") }}</dt><dd>{{ dateLabel(job.finishedAt) }}</dd></div>
              <div v-if="job.startedAt"><dt>{{ t("instances.settings.taskDuration") }}</dt><dd>{{ durationLabel(job) }}</dd></div>
            </dl>
            <p v-if="job.error" class="app-task-error">{{ job.error.message }}</p>
            <Collapsible v-if="job.command || job.logTail" class="app-task-output">
              <CollapsibleTrigger class="app-task-output-trigger">
                <TerminalSquare :size="14" aria-hidden="true" />
                {{ job.state === "running" ? t("instances.settings.liveInstallerOutput") : t("instances.settings.installerOutput") }}<template v-if="job.logTruncated"> · {{ t("instances.settings.latestLog") }}</template>
                <ChevronDown :size="14" class="app-task-output-chevron" aria-hidden="true" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ScrollArea class="app-task-log" :horizontal="false" tabindex="0" role="region" :aria-label="t('instances.settings.installerOutput')">
                  <pre>{{ executionOutput(job) }}</pre>
                </ScrollArea>
              </CollapsibleContent>
            </Collapsible>
            <p v-else class="app-task-note">{{ job.state === 'queued' || job.state === 'running' ? t("instances.settings.waitingInstaller") : t("instances.settings.noInstallerOutput") }}</p>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { CheckCircle2, ChevronDown, CircleAlert, CircleX, Clock3, LoaderCircle, TerminalSquare } from "@lucide/vue";
import type { AppManagementJob, AppManagementSnapshot } from "../../../api/types";
import { Button } from "../../../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { Progress } from "../../../components/ui/progress";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { useControlPlaneLocale } from "../../../i18n/index";
import { formatDateTime } from "../../../i18n/presentation";
import { appTaskGroups, appTaskProgress, appTaskStatusKey, retryableAppTask } from "./appTaskPresentation";

const props = defineProps<{ snapshot: AppManagementSnapshot; submitting: string }>();
const selectedJobId = defineModel<string>("selectedJobId", { default: "" });
const emit = defineEmits<{ retry: [job: AppManagementJob] }>();
const { t, te } = useI18n();
const { locale } = useControlPlaneLocale();
const groups = computed(() => appTaskGroups(props.snapshot));
const taskSections = computed(() => [
  { id: "active", label: t("instances.settings.activeAppTasks"), jobs: groups.value.active },
  { id: "recent", label: t("instances.settings.recentAppTasks"), jobs: groups.value.recent },
]);

function appName(job: AppManagementJob) {
  return props.snapshot.apps.find((app) => app.id === job.appId)?.name || job.appId;
}
function operationLabel(job: AppManagementJob) {
  return t(`instances.settings.${job.operation === "install" ? "installation" : job.operation === "uninstall" ? "uninstallation" : "update"}`);
}
function phaseLabel(phase: string) {
  const key = `instances.settings.appTaskPhases.${phase}`;
  return te(key) ? t(key) : phase.replace(/[-_]+/g, " ");
}
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatDateTime(date, locale.value);
}
function durationLabel(job: AppManagementJob) {
  // Event timestamps keep this derived value authoritative without a timer.
  const seconds = Math.max(0, Math.floor((Date.parse(job.finishedAt || job.updatedAt) - Date.parse(job.startedAt!)) / 1000));
  return t("instances.settings.taskDurationValue", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}
function executionOutput(job: AppManagementJob) {
  if (job.logTail) return job.logTail;
  if (!job.command) return t("instances.settings.waitingInstaller");
  return `$ ${[job.command.executable, ...job.command.args].map((value) => /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value)).join(" ")}\n`;
}
</script>

<style scoped>
.app-tasks { min-width: 0; }
.app-tasks-empty { margin: 0; padding: 24px 12px; color: var(--text-muted); font-size: 13px; text-align: center; }
.app-task-group h4 { display: flex; gap: 8px; margin: 0; padding: 10px 12px; background: var(--surface-inset); color: var(--text); font-size: 12px; font-weight: 500; }
.app-task-group h4 span { color: var(--text-muted); font-weight: 400; font-variant-numeric: tabular-nums; }
.app-task-group + .app-task-group, .app-task { border-top: 1px solid var(--line); }
.app-task-row { display: flex; align-items: flex-start; gap: 10px; padding: 12px; }
.app-task-row > svg { flex-shrink: 0; margin-top: 3px; }
.app-task-icon { color: var(--brand-accent-muted); }
.app-task-success { color: var(--status-success); }
.app-task-error { color: var(--status-danger); overflow-wrap: anywhere; }
.app-task-copy { display: grid; flex: 1; min-width: 0; gap: 4px; }
.app-task-name { color: var(--text-strong); font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.app-task-operation { margin-left: 6px; color: var(--text-muted); font-size: 12px; font-weight: 400; }
.app-task-status, .app-task-time, .app-task-note { color: var(--text-muted); font-size: 12px; overflow-wrap: anywhere; }
.app-task-status.app-task-error { color: var(--status-danger); }
.app-task-progress { width: min(280px, 100%); height: 4px; margin-block: 2px; }
.app-task-actions { display: flex; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; gap: 4px; }
.app-task-actions button { font-size: 12px; font-weight: 400; }
.app-task-chevron-open { transform: rotate(180deg); }
.app-task-detail { display: grid; gap: 12px; padding: 0 12px 12px 38px; font-size: 12px; }
.app-task-detail dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; margin: 0; }
.app-task-detail dl div { display: grid; gap: 3px; }
.app-task-detail dt { color: var(--text-muted); font-weight: 400; }
.app-task-detail dd { color: var(--text); margin: 0; overflow-wrap: anywhere; }
.app-task-detail p { margin: 0; }
.app-task-output { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 6px; background: var(--surface-inset); }
.app-task-output-trigger { display: flex; align-items: center; gap: 6px; width: 100%; padding: 8px 10px; color: var(--text); font-size: 12px; font-weight: 400; text-align: left; }
.app-task-output-chevron { margin-left: auto; flex-shrink: 0; }
.app-task-output-trigger[data-state="open"] .app-task-output-chevron { transform: rotate(180deg); }
.app-task-log { height: 180px; border-top: 1px solid var(--line); }
.app-task-log pre { margin: 0; padding: 10px; color: var(--text); font-family: var(--font-mono); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 680px) {
  .app-task-row { flex-wrap: wrap; }
  .app-task-actions { width: 100%; }
  .app-task-detail { padding-left: 12px; }
  .app-task-detail dl { grid-template-columns: minmax(0, 1fr); }
}
</style>
