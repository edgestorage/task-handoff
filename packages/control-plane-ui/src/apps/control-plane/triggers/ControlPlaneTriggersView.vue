<template>
  <section class="trigger-board modal-section settings-panel-surface">
    <header class="section-head trigger-board-head">
      <span>{{ t("triggers.libraryTitle", { count: triggers.data.value?.triggers.length || 0 }) }}</span>
      <div class="settings-row-actions trigger-board-head-actions">
        <Input v-model="filter" class="trigger-board-filter" :placeholder="t('triggers.filter')" />
        <Dialog v-model:open="createDialogOpen">
          <DialogTrigger as-child>
            <Button size="sm" @click="beginCreate">
              <Plus :size="14" />
              <span>{{ t("triggers.create.action") }}</span>
            </Button>
          </DialogTrigger>
          <DialogContent class="trigger-create-dialog">
            <DialogClose as-child>
              <Button variant="ghost" size="icon" class="trigger-create-close" :aria-label="t(editingHash ? 'triggers.edit.close' : 'triggers.create.close')">
                <X :size="16" />
              </Button>
            </DialogClose>
            <DialogHeader>
              <DialogTitle>{{ t(editingHash ? "triggers.edit.title" : "triggers.create.title") }}</DialogTitle>
              <DialogDescription>{{ t(editingHash ? "triggers.edit.description" : "triggers.create.description") }}</DialogDescription>
            </DialogHeader>
            <div class="trigger-create-dialog-body">
              <section class="trigger-create-group">
                <div class="trigger-board-create-main">
                  <label>
                    <span>{{ t("triggers.create.name") }}</span>
                    <Input v-model="createForm.name" :placeholder="t('triggers.create.namePlaceholder')" />
                  </label>
                  <label>
                    <span>{{ t("triggers.create.type") }}</span>
                    <ControlPlaneSelect v-model="createForm.sourceType" trigger-class="trigger-board-select" :placeholder="t('triggers.create.typePlaceholder')">
                      <ControlPlaneSelectItem value="schedule">{{ t("triggers.sourceType.schedule") }}</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="file-change">{{ t("triggers.sourceType.fileChange") }}</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="ai-session">{{ t("triggers.sourceType.aiSession") }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <label class="trigger-create-full-width">
                    <span>{{ t("triggers.create.templateDescription") }}</span>
                    <Textarea v-model="createForm.description" rows="2" :placeholder="t('triggers.create.descriptionPlaceholder')" />
                  </label>
                </div>

                <div class="trigger-create-group-head">
                  <strong>{{ t("triggers.create.source") }}</strong>
                  <span>{{ sourceSectionHint }}</span>
                </div>
                <div v-if="createForm.sourceType === 'schedule'" class="trigger-board-source-grid">
                  <label>
                    <span>{{ t("triggers.create.mode") }}</span>
                    <ControlPlaneSelect v-model="createForm.scheduleKind" trigger-class="trigger-board-select" :placeholder="t('triggers.create.modePlaceholder')">
                      <ControlPlaneSelectItem value="interval">{{ t("triggers.scheduleMode.interval") }}</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="daily">{{ t("triggers.scheduleMode.daily") }}</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="weekly">{{ t("triggers.scheduleMode.weekly") }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <label class="trigger-interval-field">
                    <span>{{ createForm.scheduleKind === "interval" ? t("triggers.create.every") : t("triggers.create.time") }}</span>
                    <div v-if="createForm.scheduleKind === 'interval'" class="trigger-interval-control">
                      <Input v-model="createForm.intervalValue" type="number" min="1" step="1" inputmode="numeric" placeholder="1" />
                      <ControlPlaneSelect v-model="createForm.intervalUnit" trigger-class="trigger-board-select trigger-interval-unit" :placeholder="t('triggers.create.unit')">
                        <ControlPlaneSelectItem value="minute">{{ t("triggers.intervalUnit.minute") }}</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="hour">{{ t("triggers.intervalUnit.hour") }}</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="day">{{ t("triggers.intervalUnit.day") }}</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="week">{{ t("triggers.intervalUnit.week") }}</ControlPlaneSelectItem>
                      </ControlPlaneSelect>
                    </div>
                    <Input v-else v-model="createForm.timeOfDay" type="time" />
                  </label>
                  <label v-if="createForm.scheduleKind !== 'interval'">
                    <span>{{ t("triggers.create.timezone") }}</span>
                    <ControlPlaneSelect v-model="createForm.timezone" trigger-class="trigger-board-select" :placeholder="t('triggers.create.timezone')">
                      <ControlPlaneSelectItem v-for="timezone in timezoneOptions" :key="timezone" :value="timezone">{{ timezone }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <div v-if="createForm.scheduleKind === 'weekly'" class="trigger-weekday-field">
                    <span>{{ t("triggers.create.days") }}</span>
                    <div class="trigger-weekday-grid">
                      <label v-for="day in weekdayOptions" :key="day.value" class="trigger-weekday-option">
                        <Checkbox :model-value="createForm.weekdays.includes(day.value)" @update:model-value="toggleWeekday(day.value, Boolean($event))" />
                        <span>{{ day.label }}</span>
                      </label>
                    </div>
                  </div>
                </div>
                <div v-else-if="createForm.sourceType === 'file-change'" class="trigger-board-source-grid">
                  <label>
                    <span>{{ t("triggers.create.roots") }}</span>
                    <!-- i18n-audit-allow-next-line code-token: example watched runtime paths -->
                    <Input v-model="createForm.roots" placeholder="/workspace, /workspace/docs" />
                  </label>
                  <label>
                    <span>{{ t("triggers.create.globs") }}</span>
                    <!-- i18n-audit-allow-next-line code-token: example file glob patterns -->
                    <Input v-model="createForm.globs" placeholder="**/*, docs/**/*.md" />
                  </label>
                  <label>
                    <span>{{ t("triggers.create.ignore") }}</span>
                    <!-- i18n-audit-allow-next-line code-token: example ignored glob patterns -->
                    <Input v-model="createForm.ignore" placeholder="node_modules/**, .git/**" />
                  </label>
                  <label>
                    <span>{{ t("triggers.create.debounceMs") }}</span>
                    <Input v-model="createForm.debounceMs" placeholder="1500" />
                  </label>
                </div>
                <div v-else class="trigger-board-source-grid">
                  <label>
                    <span>{{ t("triggers.create.agent") }}</span>
                    <Input v-model="createForm.agent" :placeholder="t('triggers.create.anyAgent')" />
                  </label>
                  <label>
                    <span>{{ t("triggers.create.statuses") }}</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="outline" class="trigger-multi-select" type="button">
                          <span>{{ selectedOptionText(createForm.statuses, aiStatusOptions, t("triggers.create.anyStatus")) }}</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent class="trigger-multi-select-menu" align="start" :side-offset="6" @click.stop>
                        <DropdownMenuCheckboxItem
                          v-for="option in aiStatusOptions"
                          :key="option.value"
                          class="trigger-multi-select-item"
                          :model-value="createForm.statuses.includes(option.value)"
                          @update:model-value="toggleStringOption(createForm.statuses, option.value, Boolean($event))"
                          @select.prevent
                        >
                          {{ option.label }}
                        </DropdownMenuCheckboxItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </label>
                  <label>
                    <span>{{ t("triggers.create.phases") }}</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="outline" class="trigger-multi-select" type="button">
                          <span>{{ selectedOptionText(createForm.phases, aiPhaseOptions, t("triggers.create.anyPhase")) }}</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent class="trigger-multi-select-menu" align="start" :side-offset="6" @click.stop>
                        <DropdownMenuCheckboxItem
                          v-for="option in aiPhaseOptions"
                          :key="option.value"
                          class="trigger-multi-select-item"
                          :model-value="createForm.phases.includes(option.value)"
                          @update:model-value="toggleStringOption(createForm.phases, option.value, Boolean($event))"
                          @select.prevent
                        >
                          {{ option.label }}
                        </DropdownMenuCheckboxItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </label>
                </div>
              </section>

              <section class="trigger-create-group">
                <div class="trigger-create-group-head">
                  <strong>{{ t("triggers.create.runPolicy") }}</strong>
                  <span>{{ t("triggers.create.runPolicyHint") }}</span>
                </div>
                <div class="trigger-board-create-main">
                  <label>
                    <span>{{ t("triggers.create.cooldown") }}</span>
                    <ControlPlaneSelect v-model="createForm.cooldownPreset" trigger-class="trigger-board-select" :placeholder="t('triggers.create.cooldown')">
                      <ControlPlaneSelectItem v-for="option in cooldownPresetOptions" :key="option.value" :value="option.value">{{ option.label }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <label>
                    <span>{{ t("triggers.create.busyPolicy") }}</span>
                    <ControlPlaneSelect v-model="createForm.whenBusy" trigger-class="trigger-board-select" :placeholder="t('triggers.create.busyPolicy')">
                      <ControlPlaneSelectItem value="skip">{{ t("triggers.busyPolicy.skip") }}</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="queue">{{ t("triggers.busyPolicy.queue") }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <label>
                    <span>{{ t("triggers.create.maxConcurrentRuns") }}</span>
                    <Input v-model="createForm.maxConcurrentRuns" type="number" min="1" max="20" step="1" inputmode="numeric" placeholder="1" />
                  </label>
                  <label v-if="createForm.cooldownPreset === 'custom'" class="trigger-interval-field">
                    <span>{{ t("triggers.create.customCooldown") }}</span>
                    <div class="trigger-interval-control">
                      <Input v-model="createForm.customCooldownValue" type="number" min="1" step="1" inputmode="numeric" placeholder="5" />
                      <ControlPlaneSelect v-model="createForm.customCooldownUnit" trigger-class="trigger-board-select trigger-interval-unit" :placeholder="t('triggers.create.unit')">
                        <ControlPlaneSelectItem value="second">{{ t("triggers.intervalUnit.second") }}</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="minute">{{ t("triggers.intervalUnit.minute") }}</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="hour">{{ t("triggers.intervalUnit.hour") }}</ControlPlaneSelectItem>
                      </ControlPlaneSelect>
                    </div>
                  </label>
                </div>

                <div class="trigger-create-group-head">
                  <strong>{{ t("triggers.create.prompt") }}</strong>
                  <span>{{ t("triggers.create.promptHint") }}</span>
                </div>
                <label class="trigger-board-prompt">
                  <span>{{ t("triggers.create.promptTemplate") }}</span>
                  <Textarea v-model="createForm.promptTemplate" rows="5" />
                </label>
              </section>
            </div>
            <DialogFooter class="trigger-create-footer">
              <DialogClose as-child>
                <Button variant="outline" size="sm">{{ t("triggers.create.cancel") }}</Button>
              </DialogClose>
              <Button size="sm" :disabled="saving" @click="saveTemplate">
                <Pencil v-if="editingHash" :size="14" />
                <Plus v-else :size="14" />
                <span>{{ saving ? t(editingHash ? "triggers.edit.saving" : "triggers.create.creating") : t(editingHash ? "triggers.edit.submit" : "triggers.create.submit") }}</span>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </header>
    <p class="trigger-board-description">{{ t("triggers.description") }}</p>

    <div class="trigger-board-overview" :aria-label="t('triggers.overview.label')">
      <div class="trigger-board-stat"><Zap :size="15" /><span>{{ t("triggers.overview.templates") }}</span><strong>{{ triggers.data.value?.triggers.length || 0 }}</strong></div>
      <div class="trigger-board-stat"><MapPin :size="15" /><span>{{ t("triggers.overview.deployments") }}</span><strong>{{ overview.deploymentCount }}</strong></div>
      <div class="trigger-board-stat"><Activity :size="15" /><span>{{ t("triggers.overview.running") }}</span><strong>{{ overview.runningCount }}</strong></div>
      <div class="trigger-board-stat" :class="{ 'is-danger': overview.errorCount > 0 }"><CircleAlert :size="15" /><span>{{ t("triggers.overview.errors") }}</span><strong>{{ overview.errorCount }}</strong></div>
    </div>

    <p v-if="triggers.error.value" class="form-error">{{ errorText }}</p>
    <div v-else-if="filteredTriggers.length" class="trigger-board-list">
      <section v-for="trigger in filteredTriggers" :key="trigger.configHash" class="trigger-board-card">
        <header class="trigger-board-card-head">
          <div class="trigger-board-heading">
            <div class="trigger-board-title">
              <strong>{{ trigger.config.name }}</strong>
              <code>{{ shortHash(trigger.configHash) }}</code>
            </div>
            <p v-if="trigger.config.description">{{ trigger.config.description }}</p>
          </div>
          <div class="trigger-board-badges">
            <Badge variant="secondary">{{ sourceTypeLabel(trigger.config.source.type) }}</Badge>
            <Badge :variant="trigger.errorCount ? 'destructive' : 'secondary'">{{ triggerStatusLabel(trigger) }}</Badge>
            <Badge v-if="!trigger.ownedByControlPlane" variant="secondary">{{ t("triggers.ownership.instanceLocal") }}</Badge>
          </div>
        </header>

        <div class="trigger-board-source">
          <Clock3 v-if="trigger.config.source.type === 'schedule'" :size="14" />
          <FolderSync v-else-if="trigger.config.source.type === 'file-change'" :size="14" />
          <Bot v-else :size="14" />
          <span>{{ sourceText(trigger.config.source) }}</span>
        </div>
        <div class="trigger-board-meta">
          <span>{{ t(trigger.deploymentCount === 1 ? "triggers.counts.bindingOne" : "triggers.counts.bindings", { count: trigger.deploymentCount }) }}</span>
          <span>{{ t("triggers.counts.enabled", { count: trigger.enabledCount }) }}</span>
          <span v-if="trigger.runningCount">{{ t("triggers.counts.running", { count: trigger.runningCount }) }}</span>
          <span v-if="trigger.errorCount" class="is-danger">{{ t(trigger.errorCount === 1 ? "triggers.counts.errorOne" : "triggers.counts.errors", { count: trigger.errorCount }) }}</span>
        </div>

        <div class="trigger-board-section-label"><span>{{ t("triggers.deployments.title") }}</span><small>{{ t("triggers.deployments.description") }}</small></div>
        <div v-if="trigger.deployments.length" class="trigger-board-deployments">
          <div v-for="entry in trigger.deployments" :key="`${entry.instanceId}:${entry.deployment.deploymentId || entry.deployment.configHash}`" class="trigger-board-deployment">
            <MapPin :size="14" aria-hidden="true" />
            <div class="trigger-board-deployment-main">
              <strong>{{ entry.instanceName }}</strong>
              <span :title="targetText(entry.deployment.target)">{{ sessionTitle(entry.instanceId, entry.deployment.target.aiSessionId) }}</span>
            </div>
            <div class="trigger-board-deployment-state">
              <span class="trigger-runtime-dot" :data-status="entry.runtime?.status || (entry.deployment.enabled ? 'idle' : 'disabled')" />
              <span :title="entry.runtime?.lastError">{{ runtimeStatusLabel(entry.runtime?.status || (entry.deployment.enabled ? "idle" : "disabled")) }}</span>
              <small>{{ originLabel(entry.deployment.origin) }}</small>
            </div>
            <div class="trigger-board-deployment-actions">
              <Button variant="ghost" size="icon" :aria-label="t('triggers.actions.run')" :title="t('triggers.actions.run')" @click="run(entry.instanceId, trigger.configHash, entry.deployment.deploymentId || entry.deployment.configHash)"><Play :size="14" /></Button>
              <Button v-if="trigger.ownedByControlPlane && entry.deployment.origin === 'control-plane'" variant="ghost" size="icon" :disabled="bindingBusyKey === deploymentKey(entry.instanceId, entry.deployment.target.aiSessionId, trigger.configHash)" :aria-label="t('triggers.actions.unbind')" :title="t('triggers.actions.unbind')" @click="unbind(trigger.configHash, entry.instanceId, entry.deployment.target.aiSessionId)"><Unlink :size="14" /></Button>
            </div>
          </div>
        </div>
        <p v-else class="trigger-board-no-deployments">{{ t("triggers.deployments.empty") }}</p>

        <details v-if="trigger.recentRuns.length" class="trigger-board-activity">
          <summary><span><History :size="14" />{{ t("triggers.activity.title") }}</span><small>{{ t("triggers.activity.latest", { time: formatDate(trigger.recentRuns[0].startedAt) }) }}</small></summary>
          <div class="trigger-board-runs">
            <div v-for="run in trigger.recentRuns.slice(0, 5)" :key="run.id" class="trigger-board-run">
              <Badge :variant="run.status === 'failed' ? 'destructive' : 'secondary'" :title="run.error">{{ runStatusLabel(run.status) }}</Badge>
              <span>{{ run.instanceName || run.instanceId }}</span><span>{{ eventTypeLabel(run.eventType) }}</span><time>{{ formatDate(run.startedAt) }}</time>
            </div>
          </div>
        </details>

        <footer class="trigger-board-card-actions">
          <Button variant="outline" size="sm" :disabled="!trigger.ownedByControlPlane || !availableSessions(trigger).length" @click="openDeployDialog(trigger.configHash)"><MapPinPlus :size="14" /><span>{{ t("triggers.actions.deploy") }}</span></Button>
          <Button variant="outline" size="sm" :disabled="!trigger.ownedByControlPlane" :title="trigger.ownedByControlPlane ? t('triggers.actions.editTitle') : t('triggers.ownership.editOwnedElsewhere')" @click="beginEdit(trigger)"><Pencil :size="14" /><span>{{ t("triggers.actions.edit") }}</span></Button>
          <Button variant="outline" size="sm" class="trigger-board-delete" :disabled="deletingHash === trigger.configHash || !trigger.ownedByControlPlane" :title="trigger.ownedByControlPlane ? t('triggers.actions.deleteTitle') : t('triggers.ownership.deleteOwnedElsewhere')" @click="deleteTemplate(trigger.configHash)"><Trash2 :size="14" /><span>{{ t("triggers.actions.delete") }}</span></Button>
        </footer>
      </section>
    </div>
    <p v-else class="settings-empty">{{ t("triggers.empty") }}</p>

    <Dialog v-model:open="deployDialogOpen">
      <DialogContent class="trigger-deploy-dialog">
        <DialogClose as-child><Button variant="ghost" size="icon" class="trigger-create-close" :aria-label="t('triggers.deployments.close')"><X :size="16" /></Button></DialogClose>
        <DialogHeader><DialogTitle>{{ t("triggers.deployments.dialogTitle") }}</DialogTitle><DialogDescription>{{ t("triggers.deployments.dialogDescription") }}</DialogDescription></DialogHeader>
        <div class="trigger-deploy-session-list">
          <button v-for="session in selectedTriggerSessions" :key="`${session.instanceId}:${session.id}`" type="button" :disabled="Boolean(bindingBusyKey)" @click="bindSelectedTrigger(session.instanceId, session.id)">
            <Bot :size="15" /><span><strong>{{ session.title || session.userPrompt || session.id }}</strong><small>{{ session.instanceName }} · {{ session.cwd || session.agent }}</small></span><Plus :size="14" />
          </button>
          <p v-if="!selectedTriggerSessions.length" class="settings-empty">{{ t("triggers.deployments.noSessions") }}</p>
        </div>
      </DialogContent>
    </Dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { useI18n } from "vue-i18n";
import { Activity, Bot, CircleAlert, Clock3, FolderSync, History, MapPin, MapPinPlus, Pencil, Play, Plus, Trash2, Unlink, X, Zap } from "@lucide/vue";
import { bindAiSessionTrigger, createControlPlaneTrigger, deleteControlPlaneTrigger, runControlledInstanceTrigger, unbindAiSessionTrigger, updateControlPlaneTrigger, useControlPlaneAiSessionsQuery, useControlPlaneTriggersQuery } from "../../../api/queries";
import { controlPlaneQueryKeys } from "../../../api/queryKeys.ts";
import type { ControlPlaneTrigger, InstanceBoardItem, TriggerRun, TriggerSource, TriggerTarget } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../../../components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { formatDateTime } from "../../../i18n/presentation";
import { translateApiError } from "../../../i18n/apiError";
import type { SupportedLocale } from "../../../i18n";

type AiSessionTriggerSource = Extract<TriggerSource, { type: "ai-session" }>;

const queryClient = useQueryClient();
const { locale, t } = useI18n();
const props = defineProps<{ instances: InstanceBoardItem[] }>();
const triggers = useControlPlaneTriggersQuery();
const aiSessions = useControlPlaneAiSessionsQuery();
const filter = ref("");
const saving = ref(false);
const editingHash = ref("");
const deletingHash = ref("");
const bindingBusyKey = ref("");
const createDialogOpen = ref(false);
const deployDialogOpen = ref(false);
const deployTriggerHash = ref("");
const createForm = reactive({
  name: "",
  description: "",
  sourceType: "schedule" as TriggerSource["type"],
  scheduleKind: "interval" as ScheduleKind,
  intervalValue: "1",
  intervalUnit: "hour" as IntervalUnit,
  timeOfDay: "09:00",
  timezone: defaultTimezone(),
  weekdays: [1, 2, 3, 4, 5],
  roots: "/workspace",
  globs: "**/*",
  ignore: "node_modules/**, .git/**",
  debounceMs: "1500",
  statuses: ["idle", "failed"] as AiSessionTriggerSource["statuses"],
  phases: [] as AiSessionTriggerSource["phases"],
  agent: "",
  cooldownPreset: "none" as CooldownPreset,
  customCooldownValue: "5",
  customCooldownUnit: "minute" as CooldownUnit,
  whenBusy: "skip" as "skip" | "queue",
  maxConcurrentRuns: "1",
  promptTemplate: "Please review the current context and continue with the next useful step.",
});

type ScheduleKind = "interval" | "daily" | "weekly";
type IntervalUnit = "minute" | "hour" | "day" | "week";
type CooldownPreset = "none" | "30s" | "1m" | "5m" | "15m" | "1h" | "custom";
type CooldownUnit = "second" | "minute" | "hour";

const intervalUnitMs: Record<IntervalUnit, number> = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

const timezoneOptions = Array.from(new Set([
  defaultTimezone(),
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
])).filter(Boolean);

const weekdayOptions = computed(() => [
  { value: 1, label: t("triggers.weekday.monday") },
  { value: 2, label: t("triggers.weekday.tuesday") },
  { value: 3, label: t("triggers.weekday.wednesday") },
  { value: 4, label: t("triggers.weekday.thursday") },
  { value: 5, label: t("triggers.weekday.friday") },
  { value: 6, label: t("triggers.weekday.saturday") },
  { value: 0, label: t("triggers.weekday.sunday") },
]);

const aiStatusOptions = computed<Array<{ value: NonNullable<AiSessionTriggerSource["statuses"]>[number]; label: string }>>(() => [
  { value: "running", label: t("triggers.sessionStatus.running") },
  { value: "waiting", label: t("triggers.sessionStatus.waiting") },
  { value: "idle", label: t("triggers.sessionStatus.idle") },
  { value: "failed", label: t("triggers.sessionStatus.failed") },
]);

const aiPhaseOptions = computed<Array<{ value: NonNullable<AiSessionTriggerSource["phases"]>[number]; label: string }>>(() => [
  { value: "thinking", label: t("triggers.sessionPhase.thinking") },
  { value: "tool", label: t("triggers.sessionPhase.tool") },
  { value: "editing", label: t("triggers.sessionPhase.editing") },
  { value: "approval", label: t("triggers.sessionPhase.approval") },
  { value: "responding", label: t("triggers.sessionPhase.responding") },
  { value: "unknown", label: t("triggers.sessionPhase.unknown") },
]);

const cooldownPresetOptions = computed<Array<{ value: CooldownPreset; label: string; ms: number | null }>>(() => [
  { value: "none", label: t("triggers.cooldownPreset.none"), ms: 0 },
  { value: "30s", label: t("triggers.cooldownPreset.seconds30"), ms: 30_000 },
  { value: "1m", label: t("triggers.cooldownPreset.minute1"), ms: 60_000 },
  { value: "5m", label: t("triggers.cooldownPreset.minutes5"), ms: 5 * 60_000 },
  { value: "15m", label: t("triggers.cooldownPreset.minutes15"), ms: 15 * 60_000 },
  { value: "1h", label: t("triggers.cooldownPreset.hour1"), ms: 60 * 60_000 },
  { value: "custom", label: t("triggers.cooldownPreset.custom"), ms: null },
]);

const cooldownUnitMs: Record<CooldownUnit, number> = {
  second: 1000,
  minute: 60_000,
  hour: 60 * 60_000,
};

const errorText = computed(() => (triggers.error.value instanceof Error ? triggers.error.value.message : String(triggers.error.value || "")));
const sourceSectionHint = computed(() => {
  if (createForm.sourceType === "file-change") {
    return t("triggers.sourceHint.fileChange");
  }
  if (createForm.sourceType === "ai-session") {
    return t("triggers.sourceHint.aiSession");
  }
  if (createForm.scheduleKind === "interval") {
    return t("triggers.sourceHint.interval");
  }
  return t("triggers.sourceHint.wallClock");
});
const filteredTriggers = computed(() => {
  const value = filter.value.trim().toLowerCase();
  const items = triggers.data.value?.triggers || [];
  if (!value) {
    return items;
  }
  return items.filter((trigger) => `${trigger.config.name} ${trigger.configHash} ${trigger.config.source.type} ${sourceText(trigger.config.source)}`.toLowerCase().includes(value));
});
const overview = computed(() => (triggers.data.value?.triggers || []).reduce((result, trigger) => ({
  deploymentCount: result.deploymentCount + trigger.deploymentCount,
  runningCount: result.runningCount + trigger.runningCount,
  errorCount: result.errorCount + trigger.errorCount,
}), { deploymentCount: 0, runningCount: 0, errorCount: 0 }));
const allSessions = computed(() => (aiSessions.data.value?.instances || []).flatMap((entry) => {
  const instance = props.instances.find((candidate) => candidate.id === entry.instanceId);
  return entry.aiSessions.sessions.map((session) => ({ ...session, instanceId: entry.instanceId, instanceName: instance?.name || entry.instanceId }));
}));
const selectedTrigger = computed(() => (triggers.data.value?.triggers || []).find((trigger) => trigger.configHash === deployTriggerHash.value));
const selectedTriggerSessions = computed(() => selectedTrigger.value ? availableSessions(selectedTrigger.value) : []);

function triggerStatusLabel(trigger: ControlPlaneTrigger) {
  if (trigger.errorCount) return t("triggers.status.error");
  if (trigger.runningCount) return t("triggers.status.running");
  if (!trigger.deploymentCount) return t("triggers.status.notDeployed");
  if (!trigger.enabledCount) return t("triggers.status.disabled");
  return t("triggers.status.active");
}

function availableSessions(trigger: ControlPlaneTrigger) {
  const deployed = new Set(trigger.deployments.map((entry) => `${entry.instanceId}:${entry.deployment.target.aiSessionId}`));
  return allSessions.value.filter((session) => !deployed.has(`${session.instanceId}:${session.id}`));
}

function sessionTitle(instanceId: string, sessionId: string) {
  const session = allSessions.value.find((candidate) => candidate.instanceId === instanceId && candidate.id === sessionId);
  return session?.title || session?.userPrompt || sessionId;
}

function deploymentKey(instanceId: string, sessionId: string, configHash: string) {
  return `${instanceId}:${sessionId}:${configHash}`;
}

function openDeployDialog(configHash: string) {
  deployTriggerHash.value = configHash;
  deployDialogOpen.value = true;
}

async function bindSelectedTrigger(instanceId: string, sessionId: string) {
  if (!deployTriggerHash.value || bindingBusyKey.value) return;
  bindingBusyKey.value = deploymentKey(instanceId, sessionId, deployTriggerHash.value);
  try {
    await bindAiSessionTrigger(instanceId, sessionId, deployTriggerHash.value);
    deployDialogOpen.value = false;
    await refresh();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
  } finally {
    bindingBusyKey.value = "";
  }
}

async function unbind(configHash: string, instanceId: string, sessionId: string) {
  if (bindingBusyKey.value) return;
  bindingBusyKey.value = deploymentKey(instanceId, sessionId, configHash);
  try {
    await unbindAiSessionTrigger(instanceId, sessionId, configHash);
    await refresh();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
  } finally {
    bindingBusyKey.value = "";
  }
}

async function run(instanceId: string, configHash: string, deploymentId?: string) {
  try {
    await runControlledInstanceTrigger(instanceId, configHash, { deploymentId });
    await refresh();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
  }
}

function beginCreate() {
  editingHash.value = "";
  resetCreateForm();
}

function resetCreateForm() {
  Object.assign(createForm, {
    name: "",
    description: "",
    sourceType: "schedule",
    scheduleKind: "interval",
    intervalValue: "1",
    intervalUnit: "hour",
    timeOfDay: "09:00",
    timezone: defaultTimezone(),
    weekdays: [1, 2, 3, 4, 5],
    roots: "/workspace",
    globs: "**/*",
    ignore: "node_modules/**, .git/**",
    debounceMs: "1500",
    statuses: ["idle", "failed"],
    phases: [],
    agent: "",
    cooldownPreset: "none",
    customCooldownValue: "5",
    customCooldownUnit: "minute",
    whenBusy: "skip",
    maxConcurrentRuns: "1",
    promptTemplate: "Please review the current context and continue with the next useful step.",
  });
}

function beginEdit(trigger: ControlPlaneTrigger) {
  if (!trigger.ownedByControlPlane) return;
  editingHash.value = trigger.configHash;
  resetCreateForm();
  populateForm(trigger.config);
  createDialogOpen.value = true;
}

async function saveTemplate() {
  saving.value = true;
  try {
    const input = {
      name: createForm.name.trim() || "Untitled trigger",
      description: createForm.description.trim() || undefined,
      source: sourceFromForm(),
      action: { promptTemplate: createForm.promptTemplate },
      policy: {
        cooldownMs: cooldownMsFromForm(),
        maxConcurrentRuns: boundedInteger(createForm.maxConcurrentRuns, 1, 1, 20),
        whenBusy: createForm.whenBusy,
      },
    };
    if (editingHash.value) {
      await updateControlPlaneTrigger(editingHash.value, input);
    } else {
      await createControlPlaneTrigger(input);
    }
    createForm.name = "";
    createDialogOpen.value = false;
    await refresh();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
  } finally {
    saving.value = false;
  }
}

function populateForm(config: ControlPlaneTrigger["config"]) {
  createForm.name = config.name;
  createForm.description = config.description || "";
  createForm.sourceType = config.source.type;
  createForm.promptTemplate = config.action.promptTemplate;
  createForm.whenBusy = config.policy.whenBusy;
  createForm.maxConcurrentRuns = String(config.policy.maxConcurrentRuns);
  setCooldown(config.policy.cooldownMs || 0);
  if (config.source.type === "file-change") {
    createForm.roots = config.source.roots.join(", ");
    createForm.globs = config.source.globs.join(", ");
    createForm.ignore = (config.source.ignore || []).join(", ");
    createForm.debounceMs = String(config.source.debounceMs);
  } else if (config.source.type === "ai-session") {
    createForm.agent = config.source.agent || "";
    createForm.statuses = [...(config.source.statuses || [])];
    createForm.phases = [...(config.source.phases || [])];
  } else if ("intervalMs" in config.source) {
    createForm.scheduleKind = "interval";
    const intervalMs = config.source.intervalMs;
    const unit = (["week", "day", "hour", "minute"] as IntervalUnit[]).find((candidate) => intervalMs % intervalUnitMs[candidate] === 0) || "minute";
    createForm.intervalUnit = unit;
    createForm.intervalValue = String(intervalMs / intervalUnitMs[unit]);
  } else {
    createForm.scheduleKind = config.source.scheduleKind;
    createForm.timeOfDay = config.source.timeOfDay;
    createForm.timezone = config.source.timezone;
    if (config.source.scheduleKind === "weekly") createForm.weekdays = [...config.source.weekdays];
  }
}

function setCooldown(cooldownMs: number) {
  const preset = cooldownPresetOptions.value.find((option) => option.ms === cooldownMs);
  if (preset) {
    createForm.cooldownPreset = preset.value;
    return;
  }
  createForm.cooldownPreset = "custom";
  const unit = (["hour", "minute", "second"] as CooldownUnit[]).find((candidate) => cooldownMs % cooldownUnitMs[candidate] === 0) || "second";
  createForm.customCooldownUnit = unit;
  createForm.customCooldownValue = String(cooldownMs / cooldownUnitMs[unit]);
}

async function deleteTemplate(configHash: string) {
  if (deletingHash.value) {
    return;
  }
  deletingHash.value = configHash;
  try {
    await deleteControlPlaneTrigger(configHash);
    await refresh();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
  } finally {
    deletingHash.value = "";
  }
}

async function refresh() {
  await queryClient.invalidateQueries({ queryKey: ["control-plane-triggers"] });
  await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.instanceBoard });
  await queryClient.invalidateQueries({ queryKey: ["control-plane-ai-sessions"] });
}

function sourceFromForm(): TriggerSource {
  if (createForm.sourceType === "file-change") {
    return {
      type: "file-change",
      roots: listFromCsv(createForm.roots, ["/workspace"]),
      globs: listFromCsv(createForm.globs, ["**/*"]),
      ignore: listFromCsv(createForm.ignore),
      debounceMs: positiveNumber(createForm.debounceMs, 1500),
    };
  }
  if (createForm.sourceType === "ai-session") {
    return {
      type: "ai-session",
      agent: createForm.agent.trim() || undefined,
      statuses: createForm.statuses.length ? createForm.statuses : undefined,
      phases: createForm.phases.length ? createForm.phases : undefined,
    };
  }
  return {
    ...scheduleSourceFromForm(),
    type: "schedule",
  } as TriggerSource;
}

function scheduleSourceFromForm() {
  if (createForm.scheduleKind === "daily") {
    return {
      scheduleKind: "daily" as const,
      timeOfDay: createForm.timeOfDay,
      timezone: createForm.timezone || defaultTimezone(),
    };
  }
  if (createForm.scheduleKind === "weekly") {
    return {
      scheduleKind: "weekly" as const,
      weekdays: createForm.weekdays.length ? [...createForm.weekdays].sort((a, b) => a - b) : [1],
      timeOfDay: createForm.timeOfDay,
      timezone: createForm.timezone || defaultTimezone(),
    };
  }
  return {
    scheduleKind: "interval" as const,
    intervalMs: intervalMsFromForm(),
  };
}

function intervalMsFromForm() {
  const value = positiveNumber(createForm.intervalValue, 1);
  return Math.round(value * intervalUnitMs[createForm.intervalUnit]);
}

function cooldownMsFromForm() {
  if (createForm.cooldownPreset === "custom") {
    const value = positiveNumber(createForm.customCooldownValue, 5);
    return Math.round(value * cooldownUnitMs[createForm.customCooldownUnit]);
  }
  return cooldownPresetOptions.value.find((option) => option.value === createForm.cooldownPreset)?.ms || 0;
}

function listFromCsv(value: string, fallback: string[] = []) {
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function positiveNumber(value: string, fallback: number) {
  return Math.max(1, Number(value) || fallback);
}

function boundedInteger(value: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  return Math.min(maximum, Math.max(minimum, normalized));
}

function shortHash(value: string) {
  return value.length > 14 ? `${value.slice(0, 10)}...` : value;
}

function sourceText(source: TriggerSource) {
  if (source.type === "schedule") {
    if ("intervalMs" in source) {
      return t("triggers.sourceSummary.interval", { interval: formatInterval(source.intervalMs) });
    }
    if (source.scheduleKind === "daily") {
      return t("triggers.sourceSummary.daily", { time: source.timeOfDay, timezone: source.timezone });
    }
    return t("triggers.sourceSummary.weekly", { weekdays: formatWeekdays(source.weekdays), time: source.timeOfDay, timezone: source.timezone });
  }
  if (source.type === "file-change") {
    return `${source.roots.join(", ")} · ${source.globs.join(", ")}`;
  }
  const filters = [
    source.agent ? t("triggers.sourceSummary.agent", { value: source.agent }) : undefined,
    source.statuses?.length ? t("triggers.sourceSummary.statuses", { value: source.statuses.map(sessionStatusLabel).join(", ") }) : undefined,
    source.phases?.length ? t("triggers.sourceSummary.phases", { value: source.phases.map(sessionPhaseLabel).join(", ") }) : undefined,
  ].filter(Boolean);
  return filters.join(" · ") || t("triggers.sourceSummary.anyAiSessionUpdate");
}

function sourceTypeLabel(value: TriggerSource["type"]) {
  if (value === "schedule") return t("triggers.sourceType.schedule");
  if (value === "file-change") return t("triggers.sourceType.fileChange");
  if (value === "ai-session") return t("triggers.sourceType.aiSession");
  return value;
}

function sessionStatusLabel(value: string) {
  if (value === "running") return t("triggers.sessionStatus.running");
  if (value === "waiting") return t("triggers.sessionStatus.waiting");
  if (value === "idle") return t("triggers.sessionStatus.idle");
  if (value === "failed") return t("triggers.sessionStatus.failed");
  return value;
}

function sessionPhaseLabel(value: string) {
  if (value === "thinking") return t("triggers.sessionPhase.thinking");
  if (value === "tool") return t("triggers.sessionPhase.tool");
  if (value === "editing") return t("triggers.sessionPhase.editing");
  if (value === "approval") return t("triggers.sessionPhase.approval");
  if (value === "responding") return t("triggers.sessionPhase.responding");
  if (value === "unknown") return t("triggers.sessionPhase.unknown");
  return value;
}

function runtimeStatusLabel(value: string) {
  if (value === "idle") return t("triggers.status.idle");
  if (value === "running") return t("triggers.status.running");
  if (value === "disabled") return t("triggers.status.disabled");
  if (value === "error") return t("triggers.status.error");
  return t("triggers.status.unknown", { value });
}

function runStatusLabel(value: string) {
  if (value === "started") return t("triggers.status.started");
  if (value === "completed") return t("triggers.status.completed");
  if (value === "failed") return t("triggers.status.failed");
  if (value === "skipped") return t("triggers.status.skipped");
  return t("triggers.status.unknown", { value });
}

function eventTypeLabel(value: TriggerRun["eventType"]) {
  if (value === "manual") return t("triggers.eventType.manual");
  if (value === "schedule") return t("triggers.eventType.schedule");
  if (value === "file-change") return t("triggers.eventType.fileChange");
  return t("triggers.eventType.aiSession");
}

function originLabel(value: string) {
  if (value === "control-plane") return t("triggers.origin.controlPlane");
  if (value === "controlled-instance") return t("triggers.origin.controlledInstance");
  return t("triggers.origin.unknown", { value });
}

function toggleWeekday(value: number, checked: boolean) {
  const next = new Set(createForm.weekdays);
  if (checked) {
    next.add(value);
  } else {
    next.delete(value);
  }
  createForm.weekdays = [...next].sort((a, b) => a - b);
}

function toggleStringOption<T extends string>(values: T[], value: T, checked: boolean) {
  const next = new Set(values);
  if (checked) {
    next.add(value);
  } else {
    next.delete(value);
  }
  values.splice(0, values.length, ...next);
}

function selectedOptionText<T extends string>(values: T[] | undefined, options: Array<{ value: T; label: string }>, emptyText: string) {
  if (!values?.length) {
    return emptyText;
  }
  const labels = new Map(options.map((option) => [option.value, option.label]));
  return values.map((value) => labels.get(value) || value).join(", ");
}

function formatWeekdays(values: number[]) {
  const labels = new Map(weekdayOptions.value.map((day) => [day.value, day.label]));
  return values.map((value) => labels.get(value) || String(value)).join(", ");
}

function defaultTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatInterval(value: number) {
  const units: IntervalUnit[] = ["week", "day", "hour", "minute"];
  for (const unit of units) {
    const unitMs = intervalUnitMs[unit];
    if (value >= unitMs && value % unitMs === 0) {
      const count = value / unitMs;
      const suffix = count === 1 ? "One" : "Many";
      return t(`triggers.interval.${unit}${suffix}`, { count });
    }
  }
  return t("triggers.interval.milliseconds", { count: value });
}

function targetText(target: TriggerTarget) {
  return t("triggers.target.aiSession", { id: target.aiSessionId });
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : formatDateTime(date, locale.value as SupportedLocale);
}
</script>

<style src="./ControlPlaneTriggersView.css"></style>
