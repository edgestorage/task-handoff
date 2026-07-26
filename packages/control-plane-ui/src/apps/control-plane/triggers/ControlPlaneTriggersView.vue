<template>
  <section class="trigger-board modal-section">
    <header class="section-head trigger-board-head">
      <span>{{ t("triggers.libraryTitle", { count: triggers.data.value?.triggers.length || 0 }) }}</span>
      <div class="settings-row-actions trigger-board-head-actions">
        <Input v-model="filter" class="trigger-board-filter" :placeholder="t('triggers.filter')" />
        <Dialog v-model:open="createDialogOpen">
          <DialogTrigger as-child>
            <Button size="sm">
              <Plus :size="14" />
              <span>{{ t("triggers.create.action") }}</span>
            </Button>
          </DialogTrigger>
          <DialogContent class="trigger-create-dialog">
            <DialogClose as-child>
              <Button variant="ghost" size="icon" class="trigger-create-close" :aria-label="t('triggers.create.close')">
                <X :size="16" />
              </Button>
            </DialogClose>
            <DialogHeader>
              <DialogTitle>{{ t("triggers.create.title") }}</DialogTitle>
              <DialogDescription>{{ t("triggers.create.description") }}</DialogDescription>
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
              <Button size="sm" :disabled="creating" @click="createTemplate">
                <Plus :size="14" />
                <span>{{ creating ? t("triggers.create.creating") : t("triggers.create.submit") }}</span>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </header>
    <p class="trigger-board-description">{{ t("triggers.description") }}</p>

    <p v-if="triggers.error.value" class="form-error">{{ errorText }}</p>
    <div v-else-if="filteredTriggers.length" class="trigger-board-list">
      <section v-for="trigger in filteredTriggers" :key="trigger.configHash" class="trigger-board-card">
        <header class="trigger-board-card-head">
          <div>
            <div class="trigger-board-title">
              {{ trigger.config.name }}
              <Badge variant="secondary">{{ sourceTypeLabel(trigger.config.source.type) }}</Badge>
              <Badge>{{ shortHash(trigger.configHash) }}</Badge>
              <Badge v-if="!trigger.ownedByControlPlane" variant="secondary">{{ t("triggers.ownership.instanceLocal") }}</Badge>
            </div>
            <p v-if="trigger.config.description">{{ trigger.config.description }}</p>
            <div class="trigger-board-meta">
              <span>{{ sourceText(trigger.config.source) }}</span>
              <span>{{ t(trigger.deploymentCount === 1 ? "triggers.counts.bindingOne" : "triggers.counts.bindings", { count: trigger.deploymentCount }) }}</span>
              <span>{{ t("triggers.counts.enabled", { count: trigger.enabledCount }) }}</span>
              <span>{{ t("triggers.counts.running", { count: trigger.runningCount }) }}</span>
              <span>{{ t(trigger.errorCount === 1 ? "triggers.counts.errorOne" : "triggers.counts.errors", { count: trigger.errorCount }) }}</span>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            :disabled="deletingHash === trigger.configHash || !trigger.ownedByControlPlane"
            :title="trigger.ownedByControlPlane ? t('triggers.actions.deleteTitle') : t('triggers.ownership.deleteOwnedElsewhere')"
            @click="deleteTemplate(trigger.configHash)"
          >
            <Trash2 :size="14" />
            <span>{{ t("triggers.actions.delete") }}</span>
          </Button>
        </header>

        <div v-if="trigger.deployments.length" class="trigger-board-deployments">
          <div v-for="entry in trigger.deployments" :key="`${entry.instanceId}:${entry.deployment.deploymentId || entry.deployment.configHash}`" class="trigger-board-deployment">
            <div>
              <strong>{{ entry.instanceName }}</strong>
              <span>{{ targetText(entry.deployment.target) }}</span>
              <span :title="entry.runtime?.lastError">{{ runtimeStatusLabel(entry.runtime?.status || (entry.deployment.enabled ? "idle" : "disabled")) }}</span>
              <span>{{ originLabel(entry.deployment.origin) }}</span>
            </div>
            <Button variant="outline" size="sm" @click="run(entry.instanceId, trigger.configHash, entry.deployment.deploymentId || entry.deployment.configHash)">{{ t("triggers.actions.run") }}</Button>
          </div>
        </div>

        <div v-if="trigger.recentRuns.length" class="trigger-board-runs">
          <div v-for="run in trigger.recentRuns.slice(0, 3)" :key="run.id" class="trigger-board-run">
            <Badge :variant="run.status === 'failed' ? 'destructive' : 'secondary'" :title="run.error">{{ runStatusLabel(run.status) }}</Badge>
            <span>{{ run.instanceName || run.instanceId }}</span>
            <span>{{ formatDate(run.startedAt) }}</span>
          </div>
        </div>
      </section>
    </div>
    <p v-else class="settings-empty">{{ t("triggers.empty") }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { useI18n } from "vue-i18n";
import { Plus, Trash2, X } from "@lucide/vue";
import { createControlPlaneTrigger, deleteControlPlaneTrigger, runControlledInstanceTrigger, useControlPlaneTriggersQuery } from "../../../api/queries";
import type { InstanceBoardItem, TriggerSource, TriggerTarget } from "../../../api/types";
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
defineProps<{ instances: InstanceBoardItem[] }>();
const triggers = useControlPlaneTriggersQuery();
const filter = ref("");
const creating = ref(false);
const deletingHash = ref("");
const createDialogOpen = ref(false);
const createForm = reactive({
  name: "",
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
  cooldownPreset: "none" as CooldownPreset,
  customCooldownValue: "5",
  customCooldownUnit: "minute" as CooldownUnit,
  whenBusy: "skip" as "skip" | "queue",
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

async function run(instanceId: string, configHash: string, deploymentId?: string) {
  try {
    await runControlledInstanceTrigger(instanceId, configHash, { deploymentId });
    await refresh();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
  }
}

async function createTemplate() {
  creating.value = true;
  try {
    await createControlPlaneTrigger({
      name: createForm.name.trim() || "Untitled trigger",
      source: sourceFromForm(),
      action: { promptTemplate: createForm.promptTemplate },
      policy: {
        cooldownMs: cooldownMsFromForm(),
        maxConcurrentRuns: 1,
        whenBusy: createForm.whenBusy,
      },
    });
    createForm.name = "";
    createDialogOpen.value = false;
    await refresh();
  } catch (error) {
    showControlPlaneToast(translateApiError(error, t));
  } finally {
    creating.value = false;
  }
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
  await queryClient.invalidateQueries({ queryKey: ["instance-board"] });
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
