<template>
  <div class="story-automations">
    <div class="story-automations-heading">
      <div><h3>{{ t("stories.automation.title") }}</h3><span>{{ automations.length }}</span></div>
      <Button variant="outline" size="sm" :disabled="disabled" @click="openCreate"><Plus :size="14" />{{ t("stories.automation.add") }}</Button>
    </div>
    <div v-if="loading" class="story-automation-state"><LoaderCircle class="story-automation-spin" :size="14" /> {{ t("stories.automation.loading") }}</div>
    <div v-else-if="error" class="story-automation-state story-automation-error" role="alert">{{ error }}</div>
    <div v-else-if="!automations.length" class="story-automation-state">{{ t("stories.automation.empty") }}</div>
    <div v-for="entry in automations" :key="entry.automation.id" class="story-automation-row" :data-automation-id="entry.automation.id" tabindex="-1">
      <CalendarClock :size="15" />
      <div class="story-automation-copy">
        <div class="story-automation-primary">
          <span>{{ scheduleLabel(entry.automation.schedule) }}</span>
          <small>{{ t(`stories.automation.status.${entry.effectiveStatus}`) }}<template v-if="entry.nextRunAt"> · {{ formatTime(entry.nextRunAt) }}</template></small>
        </div>
        <div class="story-automation-meta">
          <small class="story-automation-action">{{ actionTitle(entry.automation.actionId) }}</small>
          <span aria-hidden="true">·</span>
          <Popover>
            <PopoverTrigger as-child>
              <button type="button" class="story-automation-history-trigger" :aria-label="t('stories.automation.historyCount', { count: entry.recentRuns.length })">
                <History :size="13" aria-hidden="true" />
                <span>{{ t("stories.automation.historyCount", { count: entry.recentRuns.length }) }}</span>
                <ChevronDown :size="13" aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent class="story-automation-history-popover p-0" align="start" :collision-padding="12" :side-offset="6">
              <header class="story-automation-history-head">
                <strong>{{ t("stories.automation.history") }}</strong>
                <span>{{ t("stories.automation.historyCount", { count: entry.recentRuns.length }) }}</span>
              </header>
              <ScrollArea v-if="entry.recentRuns.length" class="story-automation-history-scroll" :horizontal="false">
                <div class="story-automation-history-list">
                  <div v-for="runEntry in entry.recentRuns" :key="runEntry.id" class="story-automation-history-row">
                    <span>{{ t(`stories.automation.runStatus.${runEntry.status}`) }}</span>
                    <time>{{ formatTime(runEntry.queuedAt) }}</time>
                    <Button v-if="runEntry.aiSessionId" variant="ghost" size="icon-sm" :disabled="!automationSessionExists(runEntry)" :aria-label="t(automationSessionExists(runEntry) ? 'stories.automation.openRunSession' : 'stories.automation.sessionUnavailable')" :title="t(automationSessionExists(runEntry) ? 'stories.automation.openRunSession' : 'stories.automation.sessionUnavailable')" @click="emit('open-session', runEntry.targetInstanceId, runEntry.aiSessionId)"><ExternalLink :size="12" /></Button>
                  </div>
                </div>
              </ScrollArea>
              <p v-else class="story-automation-history-empty">{{ t("stories.automation.historyEmpty") }}</p>
            </PopoverContent>
          </Popover>
        </div>
        <small v-if="entry.blockedReason || entry.lastRun?.error" class="story-automation-error">{{ (entry.blockedReason || entry.lastRun?.error)?.message }}</small>
      </div>
      <div class="story-automation-actions">
        <Button variant="ghost" size="icon-sm" :disabled="busyId === entry.automation.id" :aria-label="t('stories.automation.run')" :title="t('stories.automation.run')" @click="run(entry)"><Play :size="13" /></Button>
        <Button variant="ghost" size="icon-sm" :disabled="busyId === entry.automation.id" :aria-label="t(entry.automation.enabled ? 'stories.automation.disable' : 'stories.automation.enable')" :title="t(entry.automation.enabled ? 'stories.automation.disable' : 'stories.automation.enable')" @click="toggle(entry)"><Pause v-if="entry.automation.enabled" :size="13" /><Power v-else :size="13" /></Button>
        <Button variant="ghost" size="icon-sm" :disabled="busyId === entry.automation.id" :aria-label="t('common.actions.edit')" :title="t('common.actions.edit')" @click="openEdit(entry)"><Pencil :size="13" /></Button>
        <Button variant="ghost" size="icon-sm" :disabled="busyId === entry.automation.id" :aria-label="t('common.actions.delete')" :title="t('common.actions.delete')" @click="remove(entry)"><Trash2 :size="13" /></Button>
      </div>
    </div>
  </div>

  <Dialog v-model:open="editorOpen">
    <DialogContent class="story-automation-dialog" :class="{ 'story-automation-dialog-with-action': !editingId && actionMode === 'new' }">
      <DialogHeader class="story-automation-dialog-header space-y-0" :class="{ 'story-automation-dialog-header-create': !editingId }">
        <div class="story-automation-dialog-heading">
          <DialogTitle>{{ t(editingId ? "stories.automation.edit" : "stories.automation.add") }}</DialogTitle>
          <DialogDescription>{{ !editingId && actionMode === "new" ? t("stories.actionEditor.description") : selectedAction?.title || t("stories.automation.selectAction") }}</DialogDescription>
        </div>
        <div v-if="!editingId" class="story-automation-action-mode">
          <Tabs v-model="actionMode">
            <TabsList class="story-automation-action-tabs">
              <TabsTrigger value="existing">{{ t("stories.automation.useExistingAction") }}</TabsTrigger>
              <TabsTrigger value="new">{{ t("stories.automation.createAction") }}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </DialogHeader>
      <ScrollArea class="story-automation-dialog-scroll" :horizontal="false">
      <div class="story-automation-dialog-body">
        <StoryActionEditorContent
          v-if="!editingId && actionMode === 'new'"
          ref="actionCreationPanel"
          v-model:mode="newActionMode"
          v-model:target-instance-id="newActionTargetId"
          v-model:title="newActionTitle"
          :initial-preset="undefined"
          initial-prompt=""
          :instances="instances"
          :node-local-folders-by-node-id="nodeLocalFoldersByNodeId"
          :revision="actionEditorRevision"
          :submitting="saving"
          @submit="saveWithNewAction"
          @update:submit-ready="actionSubmitReady = $event"
        />
        <div class="story-automation-fields">
          <label v-if="!editingId && actionMode === 'existing'">{{ t("stories.automation.action") }}<ControlPlaneSelect v-model="selectedActionId" :placeholder="t('stories.automation.selectAction')"><ControlPlaneSelectItem v-for="candidate in schedulableActions" :key="candidate.id" :value="candidate.id">{{ candidate.title }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
        <label>{{ t("stories.automation.scheduleKind") }}<ControlPlaneSelect v-model="scheduleKind"><ControlPlaneSelectItem value="interval">{{ t("stories.automation.interval") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="daily">{{ t("stories.automation.daily") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="weekly">{{ t("stories.automation.weekly") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
        <label v-if="scheduleKind === 'interval'">{{ t("stories.automation.intervalMinutes") }}<Input v-model.number="intervalMinutes" type="number" min="1" /></label>
        <template v-else>
          <label>{{ t("stories.automation.timeOfDay") }}<ControlPlaneTimePicker v-model="timeOfDay" :hour-label="t('stories.automation.hour')" :minute-label="t('stories.automation.minute')" /></label>
          <label>{{ t("stories.automation.timezone") }}<Input v-model="timezone" /></label>
        </template>
        <label v-if="scheduleKind === 'weekly'">{{ t("stories.automation.weekdays") }}<span class="story-automation-weekdays"><label v-for="weekday in weekdayOptions" :key="weekday.value"><Checkbox :model-value="weekdays.includes(weekday.value)" @update:model-value="setWeekday(weekday.value, Boolean($event))" />{{ weekday.label }}</label></span></label>
        <label>{{ t("stories.automation.whenBusy") }}<ControlPlaneSelect v-model="whenBusy"><ControlPlaneSelectItem value="skip">{{ t("stories.automation.skip") }}</ControlPlaneSelectItem><ControlPlaneSelectItem value="queue">{{ t("stories.automation.queue") }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
        <label>{{ t("stories.automation.maxConcurrentRuns") }}<Input v-model.number="maxConcurrentRuns" type="number" min="1" max="20" /></label>
        <label>{{ t("stories.automation.cooldownMinutes") }}<Input v-model.number="cooldownMinutes" type="number" min="0" max="1440" /></label>
        <label class="story-automation-enabled"><Checkbox v-model="enabled" />{{ t("stories.automation.enabled") }}</label>
        <div v-if="editorError" class="story-automation-error" role="alert">{{ editorError }}</div>
        </div>
      </div>
      </ScrollArea>
      <DialogFooter><Button variant="outline" :disabled="saving" @click="editorOpen = false">{{ t("common.actions.cancel") }}</Button><Button :disabled="saving || (!editingId && actionMode === 'new' && !actionSubmitReady)" @click="save">{{ t("common.actions.save") }}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useQuery } from "@tanstack/vue-query";
import { CalendarClock, ChevronDown, ExternalLink, History, LoaderCircle, Pause, Pencil, Play, Plus, Power, Trash2 } from "@lucide/vue";
import type { Story, StoryAction, StoryAutomationRun, StoryAutomationSchedule, StoryAutomationStatus, StorySessionPreset } from "@task-handoff/protocol/stories";
import type { InstanceWithAiSessions, NodeLocalFolder } from "../../../api/types";
import { sharedControlPlaneClient } from "../../../api/sharedClient.ts";
import { controlPlaneQueryKeys } from "../../../api/queryKeys.ts";
import { createBrowserUuid } from "../../../lib/random-id";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import Input from "../../../components/ui/input/Input.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import ControlPlaneTimePicker from "../shared/ControlPlaneTimePicker.vue";
import type { AiSessionCreationPresetDraft } from "../instance-detail/AiSessionPanel.vue";
import StoryActionEditorContent from "./StoryActionEditorContent.vue";

type AutomationView = StoryAutomationStatus & { recentRuns: StoryAutomationRun[] };
type AutomationConfig = { schedule: StoryAutomationSchedule; enabled: boolean; policy: { maxConcurrentRuns: number; whenBusy: "skip" | "queue"; cooldownMs?: number } };
const props = defineProps<{
  actions: StoryAction[];
  createWithAction: (payload: { action: StoryAction; config: AutomationConfig }) => Promise<void>;
  disabled?: boolean;
  instances: InstanceWithAiSessions[];
  nodeLocalFoldersByNodeId: Record<string, NodeLocalFolder[]>;
  story: Story;
}>();
const emit = defineEmits<{
  "open-session": [instanceId: string, sessionId: string];
  loaded: [entries: AutomationView[]];
}>();
const { locale, t } = useI18n();
const mutationError = ref("");
const busyId = ref("");
const editorOpen = ref(false);
const editingId = ref("");
const saving = ref(false);
const editorError = ref("");
const scheduleKind = ref<"interval" | "daily" | "weekly">("interval");
const intervalMinutes = ref(60);
const timeOfDay = ref("09:00");
const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
const weekdays = ref<number[]>([1]);
const whenBusy = ref<"skip" | "queue">("skip");
const maxConcurrentRuns = ref(1);
const cooldownMinutes = ref(0);
const enabled = ref(true);
const selectedActionId = ref("");
const actionMode = ref<"existing" | "new">("existing");
const actionEditorRevision = ref(0);
const actionCreationPanel = ref<InstanceType<typeof StoryActionEditorContent>>();
const actionSubmitReady = ref(false);
const newActionTitle = ref("");
const newActionTargetId = ref("");
const newActionMode = ref<StorySessionPreset["mode"] | "">("");
const weekdayOptions = [0, 1, 2, 3, 4, 5, 6].map((value) => ({ value, label: new Intl.DateTimeFormat(locale.value, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 7, 2 + value))) }));
const schedulableActions = computed(() => props.actions.filter((action) => Boolean(action.targetInstanceId)));
const selectedAction = computed(() => props.actions.find((action) => action.id === selectedActionId.value));
const automationQuery = useQuery({
  queryKey: computed(() => [...controlPlaneQueryKeys.stories(props.story.ownerNodeId), props.story.id, "automations"]),
  queryFn: async () => {
    const statuses = (await sharedControlPlaneClient.stories.listAutomations(props.story.id, props.story.ownerNodeId)).automations
    return Promise.all(statuses.map(async (entry): Promise<AutomationView> => ({
      ...entry,
      recentRuns: (await sharedControlPlaneClient.stories.automationRuns(props.story.id, entry.automation.id, props.story.ownerNodeId)).runs,
    })));
  },
  retry: false,
});
const automations = computed(() => automationQuery.data.value || []);
const loading = computed(() => automationQuery.isPending.value);
const error = computed(() => mutationError.value || (automationQuery.error.value instanceof Error ? automationQuery.error.value.message : automationQuery.error.value ? String(automationQuery.error.value) : ""));
watch(automations, (entries) => emit("loaded", entries), { immediate: true });

async function load() {
  await automationQuery.refetch();
}

function resetEditor() {
  actionMode.value = "existing";
  actionEditorRevision.value += 1;
  actionSubmitReady.value = false;
  newActionTitle.value = "";
  newActionTargetId.value = props.instances[0]?.id || "";
  newActionMode.value = "";
  editingId.value = "";
  scheduleKind.value = "interval";
  intervalMinutes.value = 60;
  timeOfDay.value = "09:00";
  timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  weekdays.value = [1];
  whenBusy.value = "skip";
  maxConcurrentRuns.value = 1;
  cooldownMinutes.value = 0;
  enabled.value = true;
  selectedActionId.value = schedulableActions.value[0]?.id || "";
  editorError.value = "";
}
function openCreate() { resetEditor(); editorOpen.value = true; }
function openEdit(entry: StoryAutomationStatus) {
  resetEditor();
  editingId.value = entry.automation.id;
  selectedActionId.value = entry.automation.actionId;
  const schedule = entry.automation.schedule;
  scheduleKind.value = schedule.scheduleKind;
  if (schedule.scheduleKind === "interval") intervalMinutes.value = schedule.intervalMs / 60_000;
  else { timeOfDay.value = schedule.timeOfDay; timezone.value = schedule.timezone; if (schedule.scheduleKind === "weekly") weekdays.value = [...schedule.weekdays]; }
  whenBusy.value = entry.automation.policy.whenBusy;
  maxConcurrentRuns.value = entry.automation.policy.maxConcurrentRuns;
  cooldownMinutes.value = (entry.automation.policy.cooldownMs || 0) / 60_000;
  enabled.value = entry.automation.enabled;
  editorOpen.value = true;
}
function setWeekday(value: number, selected: boolean) { weekdays.value = selected ? [...new Set([...weekdays.value, value])].sort() : weekdays.value.filter((entry) => entry !== value); }
function scheduleInput(): StoryAutomationSchedule {
  if (scheduleKind.value === "interval") return { scheduleKind: "interval", intervalMs: Math.round(intervalMinutes.value * 60_000) };
  if (scheduleKind.value === "daily") return { scheduleKind: "daily", timeOfDay: timeOfDay.value, timezone: timezone.value.trim() };
  return { scheduleKind: "weekly", weekdays: weekdays.value, timeOfDay: timeOfDay.value, timezone: timezone.value.trim() };
}
function automationConfig(): AutomationConfig {
  return { schedule: scheduleInput(), enabled: enabled.value, policy: { maxConcurrentRuns: maxConcurrentRuns.value, whenBusy: whenBusy.value, ...(cooldownMinutes.value ? { cooldownMs: Math.round(cooldownMinutes.value * 60_000) } : {}) } };
}
async function save() {
  if (!editingId.value && actionMode.value === "new") {
    actionCreationPanel.value?.submitCreation();
    return;
  }
  const action = selectedAction.value;
  if (!action) { editorError.value = t("stories.automation.selectAction"); return; }
  saving.value = true;
  editorError.value = "";
  const config = automationConfig();
  try {
    if (editingId.value) await sharedControlPlaneClient.stories.updateAutomation(props.story.id, editingId.value, props.story.ownerNodeId, config);
    else await sharedControlPlaneClient.stories.createAutomation(props.story.id, props.story.ownerNodeId, { storyId: props.story.id, actionId: action.id, ...config });
    editorOpen.value = false;
    await load();
  } catch (cause) {
    editorError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}
async function saveWithNewAction(draft: AiSessionCreationPresetDraft) {
  if (saving.value) return;
  const title = newActionTitle.value.trim();
  const promptTemplate = draft.prompt.trim();
  if (!title || !promptTemplate) { editorError.value = t("stories.actionEditor.validationRequired"); return; }
  if (!draft.instanceId) { editorError.value = t("stories.actionEditor.validationTarget"); return; }
  const sessionPreset: StorySessionPreset = { ...draft.sessionPreset, ...(newActionMode.value ? { mode: newActionMode.value } : {}) };
  const action: StoryAction = { id: createBrowserUuid(), title, promptTemplate, targetInstanceId: draft.instanceId, sessionPreset };
  saving.value = true;
  editorError.value = "";
  try {
    await props.createWithAction({ action, config: automationConfig() });
    editorOpen.value = false;
    await load();
  } catch (cause) {
    editorError.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    saving.value = false;
  }
}
async function run(entry: StoryAutomationStatus) { await mutate(entry, () => sharedControlPlaneClient.stories.runAutomation(props.story.id, entry.automation.id, props.story.ownerNodeId, { clientRequestId: crypto.randomUUID() })); }
async function toggle(entry: StoryAutomationStatus) { await mutate(entry, () => sharedControlPlaneClient.stories.setAutomationEnabled(props.story.id, entry.automation.id, props.story.ownerNodeId, !entry.automation.enabled)); }
async function remove(entry: StoryAutomationStatus) {
  if (!window.confirm(t("stories.automation.confirmDelete"))) return;
  await mutate(entry, () => sharedControlPlaneClient.stories.removeAutomation(props.story.id, entry.automation.id, props.story.ownerNodeId));
}
async function mutate(entry: StoryAutomationStatus, operation: () => Promise<unknown>) {
  busyId.value = entry.automation.id;
  mutationError.value = "";
  try { await operation(); await load(); } catch (cause) { mutationError.value = cause instanceof Error ? cause.message : String(cause); } finally { busyId.value = ""; }
}
function scheduleLabel(schedule: StoryAutomationSchedule) {
  if (schedule.scheduleKind === "interval") return t("stories.automation.everyMinutes", { count: schedule.intervalMs / 60_000 });
  if (schedule.scheduleKind === "daily") return t("stories.automation.dailyAt", { time: schedule.timeOfDay, timezone: schedule.timezone });
  return t("stories.automation.weeklyAt", { days: schedule.weekdays.map((day) => weekdayOptions.find((entry) => entry.value === day)?.label).join(", "), time: schedule.timeOfDay, timezone: schedule.timezone });
}
function actionTitle(actionId: string) { return props.actions.find((action) => action.id === actionId)?.title || actionId; }
function automationSessionExists(run: StoryAutomationRun) {
  return Boolean(run.aiSessionId && props.instances.some((instance) => instance.id === run.targetInstanceId && instance.aiSessions.sessions.some((session) => session.id === run.aiSessionId)));
}
function formatTime(value: string) { return new Intl.DateTimeFormat(locale.value, { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }

</script>

<style scoped>
.story-automations { background:var(--surface-raised); }
.story-automations-heading,.story-automation-row { display:flex; align-items:center; gap:8px; min-height:34px; padding:4px 12px; }
.story-automations-heading { min-height:38px; justify-content:space-between; border-bottom:1px solid var(--line); color:var(--text-muted); font-size:12px; }
.story-automations-heading > div { display:flex; align-items:baseline; gap:7px; }
.story-automations-heading h3 { margin:0; color:var(--text-strong); font-size:13px; font-weight:500; }
.story-automation-row { min-height:54px; border-top:1px solid var(--line); color:var(--text-muted); padding-top:6px; padding-bottom:6px; }
.story-automation-row > svg { flex:0 0 auto; }
.story-automation-row:focus { background:var(--surface-active); outline:none; }
.story-automations-heading + .story-automation-row { border-top:0; }
.story-automation-copy { display:grid; min-width:0; flex:1; gap:3px; font-size:12px; }
.story-automation-primary,.story-automation-meta { display:flex; min-width:0; align-items:center; gap:7px; }
.story-automation-primary > span { overflow:hidden; color:var(--text-strong); font-size:12px; font-weight:500; text-overflow:ellipsis; white-space:nowrap; }
.story-automation-primary > small { overflow:hidden; color:var(--text-muted); font-size:12px; text-overflow:ellipsis; white-space:nowrap; }
.story-automation-meta { color:var(--text-muted); }
.story-automation-action { overflow:hidden; color:var(--text-strong); font-size:13px; font-weight:500; text-overflow:ellipsis; white-space:nowrap; }
.story-automation-actions { display:flex; flex:0 0 auto; gap:2px; }
.story-automation-state { min-height:38px; color:var(--text-muted); font-size:12px; padding:11px 12px; }
.story-automation-error { color:var(--status-danger) !important; font-size:12px; }
.story-automation-spin { animation:story-automation-spin .9s linear infinite; }
.story-automation-history-trigger { display:flex; width:max-content; align-items:center; gap:5px; border:0; background:transparent; color:var(--text-muted); cursor:pointer; font-size:12px; padding:0; }
.story-automation-history-trigger:hover,.story-automation-history-trigger:focus-visible,.story-automation-history-trigger[data-state="open"] { color:var(--text-strong); outline:none; }
.story-automation-history-trigger > svg:last-child { transition:transform 140ms ease; }
.story-automation-history-trigger[data-state="open"] > svg:last-child { transform:rotate(180deg); }
:global(.story-automation-history-popover) { display:grid; width:min(360px,var(--reka-popover-content-available-width)); max-height:min(320px,var(--reka-popover-content-available-height)); grid-template-rows:auto minmax(0,1fr); overflow:hidden; padding:0; }
:global(.story-automation-history-head) { display:flex; align-items:center; justify-content:space-between; gap:8px; border-bottom:1px solid var(--line); padding:7px 9px; }
:global(.story-automation-history-head strong) { color:var(--text-strong); font-size:12px; font-weight:500; }
:global(.story-automation-history-head span),:global(.story-automation-history-empty) { color:var(--text-muted); font-size:12px; }
:global(.story-automation-history-scroll) { min-height:0; }
:global(.story-automation-history-scroll [data-task-handoff-scroll-viewport]) { padding-right:7px; }
:global(.story-automation-history-list) { display:grid; gap:2px; padding:3px; }
:global(.story-automation-history-row) { display:grid; min-height:34px; grid-template-columns:minmax(0,1fr) auto 28px; align-items:center; gap:8px; border-radius:5px; padding:3px 4px 3px 7px; font-size:12px; }
:global(.story-automation-history-row:hover) { background:var(--surface-hover); }
:global(.story-automation-history-row > span) { overflow:hidden; color:var(--text-strong); text-overflow:ellipsis; white-space:nowrap; }
:global(.story-automation-history-row time) { color:var(--text-muted); white-space:nowrap; }
:global(.story-automation-history-row > button) { width:28px; height:28px; }
:global(.story-automation-history-empty) { margin:0; padding:11px 9px; }
.story-automation-fields { display:grid; gap:12px; }
.story-automation-fields > label { display:grid; gap:6px; color:var(--text-muted); font-size:12px; }
.story-automation-dialog-body { display:grid; gap:14px; padding-right:8px; }
.story-automation-dialog-header-create { display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); align-items:center; column-gap:20px; }
.story-automation-dialog-header.story-automation-dialog-header-create > :not([hidden]) ~ :not([hidden]) { margin-top:0; margin-bottom:0; }
.story-automation-dialog-heading { display:grid; min-width:0; gap:4px; text-align:left; }
.story-automation-dialog-header-create .story-automation-dialog-heading { grid-column:1; grid-row:1; align-self:center; }
.story-automation-action-mode { grid-column:2; grid-row:1; display:flex; align-self:center; justify-self:center; }
.story-automation-action-tabs { width:100%; }
.story-automation-enabled { display:flex !important; align-items:center; }
.story-automation-weekdays { display:flex; flex-wrap:wrap; gap:10px; }
.story-automation-weekdays label { display:flex; align-items:center; gap:4px; color:var(--text); font-size:12px; }
:global(.story-automation-dialog) { max-width:480px; }
:global(.story-automation-dialog.story-automation-dialog-with-action) { max-width:840px; grid-template-rows:auto minmax(0,1fr) auto; overflow:hidden; }
.story-automation-dialog-scroll { min-height:0; }
@keyframes story-automation-spin { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion:reduce) { .story-automation-spin { animation:none; } }
@media (max-width:720px) {
  .story-automation-dialog-header-create { grid-template-columns:minmax(0,1fr); grid-template-rows:auto auto; row-gap:12px; }
  .story-automation-dialog-header-create .story-automation-dialog-heading { grid-column:1; grid-row:1; }
  .story-automation-action-mode { grid-column:1; grid-row:2; width:100%; justify-content:center; justify-self:center; }
}
</style>
