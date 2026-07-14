<template>
  <section class="trigger-board modal-section">
    <header class="section-head trigger-board-head">
      <span>Trigger Library · {{ triggers.data.value?.triggers.length || 0 }}</span>
      <div class="settings-row-actions trigger-board-head-actions">
        <Input v-model="filter" class="trigger-board-filter" placeholder="Filter templates" />
        <Dialog v-model:open="createDialogOpen">
          <DialogTrigger as-child>
            <Button size="sm">
              <Plus :size="14" />
              <span>New trigger</span>
            </Button>
          </DialogTrigger>
          <DialogContent class="trigger-create-dialog">
            <DialogClose as-child>
              <Button variant="ghost" size="icon" class="trigger-create-close" aria-label="Close create trigger dialog">
                <X :size="16" />
              </Button>
            </DialogClose>
            <DialogHeader>
              <DialogTitle>Create trigger template</DialogTitle>
              <DialogDescription>Configure the event source and prompt that should run when it fires.</DialogDescription>
            </DialogHeader>
            <div class="trigger-create-dialog-body">
              <section class="trigger-create-group">
                <div class="trigger-board-create-main">
                  <label>
                    <span>Name</span>
                    <Input v-model="createForm.name" placeholder="Trigger name" />
                  </label>
                  <label>
                    <span>Type</span>
                    <ControlPlaneSelect v-model="createForm.sourceType" trigger-class="trigger-board-select" placeholder="Trigger type">
                      <ControlPlaneSelectItem value="schedule">Schedule</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="file-change">File change</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="ai-session">AI session</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                </div>

                <div class="trigger-create-group-head">
                  <strong>Source</strong>
                  <span>{{ sourceSectionHint }}</span>
                </div>
                <div v-if="createForm.sourceType === 'schedule'" class="trigger-board-source-grid">
                  <label>
                    <span>Mode</span>
                    <ControlPlaneSelect v-model="createForm.scheduleKind" trigger-class="trigger-board-select" placeholder="Schedule mode">
                      <ControlPlaneSelectItem value="interval">Every interval</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="daily">Daily at time</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="weekly">Weekly at time</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <label class="trigger-interval-field">
                    <span>{{ createForm.scheduleKind === "interval" ? "Every" : "Time" }}</span>
                    <div v-if="createForm.scheduleKind === 'interval'" class="trigger-interval-control">
                      <Input v-model="createForm.intervalValue" type="number" min="1" step="1" inputmode="numeric" placeholder="1" />
                      <ControlPlaneSelect v-model="createForm.intervalUnit" trigger-class="trigger-board-select trigger-interval-unit" placeholder="Unit">
                        <ControlPlaneSelectItem value="minute">Minute</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="hour">Hour</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="day">Day</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="week">Week</ControlPlaneSelectItem>
                      </ControlPlaneSelect>
                    </div>
                    <Input v-else v-model="createForm.timeOfDay" type="time" />
                  </label>
                  <label v-if="createForm.scheduleKind !== 'interval'">
                    <span>Timezone</span>
                    <ControlPlaneSelect v-model="createForm.timezone" trigger-class="trigger-board-select" placeholder="Timezone">
                      <ControlPlaneSelectItem v-for="timezone in timezoneOptions" :key="timezone" :value="timezone">{{ timezone }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <div v-if="createForm.scheduleKind === 'weekly'" class="trigger-weekday-field">
                    <span>Days</span>
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
                    <span>Roots</span>
                    <Input v-model="createForm.roots" placeholder="/workspace, /workspace/docs" />
                  </label>
                  <label>
                    <span>Globs</span>
                    <Input v-model="createForm.globs" placeholder="**/*, docs/**/*.md" />
                  </label>
                  <label>
                    <span>Ignore</span>
                    <Input v-model="createForm.ignore" placeholder="node_modules/**, .git/**" />
                  </label>
                  <label>
                    <span>Debounce ms</span>
                    <Input v-model="createForm.debounceMs" placeholder="1500" />
                  </label>
                </div>
                <div v-else class="trigger-board-source-grid">
                  <label>
                    <span>Statuses</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="outline" class="trigger-multi-select" type="button">
                          <span>{{ selectedOptionText(createForm.statuses, aiStatusOptions, "Any status") }}</span>
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
                    <span>Phases</span>
                    <DropdownMenu>
                      <DropdownMenuTrigger as-child>
                        <Button variant="outline" class="trigger-multi-select" type="button">
                          <span>{{ selectedOptionText(createForm.phases, aiPhaseOptions, "Any phase") }}</span>
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
                  <strong>Run policy</strong>
                  <span>Control repeated events and overlapping runs.</span>
                </div>
                <div class="trigger-board-create-main">
                  <label>
                    <span>Cooldown</span>
                    <ControlPlaneSelect v-model="createForm.cooldownPreset" trigger-class="trigger-board-select" placeholder="Cooldown">
                      <ControlPlaneSelectItem v-for="option in cooldownPresetOptions" :key="option.value" :value="option.value">{{ option.label }}</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <label>
                    <span>Busy policy</span>
                    <ControlPlaneSelect v-model="createForm.whenBusy" trigger-class="trigger-board-select" placeholder="Busy policy">
                      <ControlPlaneSelectItem value="skip">Skip</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="queue">Queue</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                  <label v-if="createForm.cooldownPreset === 'custom'" class="trigger-interval-field">
                    <span>Custom cooldown</span>
                    <div class="trigger-interval-control">
                      <Input v-model="createForm.customCooldownValue" type="number" min="1" step="1" inputmode="numeric" placeholder="5" />
                      <ControlPlaneSelect v-model="createForm.customCooldownUnit" trigger-class="trigger-board-select trigger-interval-unit" placeholder="Unit">
                        <ControlPlaneSelectItem value="second">Second</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="minute">Minute</ControlPlaneSelectItem>
                        <ControlPlaneSelectItem value="hour">Hour</ControlPlaneSelectItem>
                      </ControlPlaneSelect>
                    </div>
                  </label>
                </div>

                <div class="trigger-create-group-head">
                  <strong>Prompt</strong>
                  <span>This prompt is sent to the target session when the trigger runs.</span>
                </div>
                <label class="trigger-board-prompt">
                  <span>Prompt template</span>
                  <Textarea v-model="createForm.promptTemplate" rows="5" />
                </label>
              </section>
            </div>
            <DialogFooter class="trigger-create-footer">
              <DialogClose as-child>
                <Button variant="outline" size="sm">Cancel</Button>
              </DialogClose>
              <Button size="sm" :disabled="creating" @click="createTemplate">
                <Plus :size="14" />
                <span>{{ creating ? "Creating" : "Create template" }}</span>
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </header>
    <p class="trigger-board-description">Templates aggregated from control plane and controlled instances.</p>

    <p v-if="triggers.error.value" class="form-error">{{ errorText }}</p>
    <div v-else-if="filteredTriggers.length" class="trigger-board-list">
      <section v-for="trigger in filteredTriggers" :key="trigger.configHash" class="trigger-board-card">
        <header class="trigger-board-card-head">
          <div>
            <div class="trigger-board-title">
              {{ trigger.config.name }}
              <Badge variant="secondary">{{ trigger.config.source.type }}</Badge>
              <Badge>{{ shortHash(trigger.configHash) }}</Badge>
              <Badge v-if="!trigger.ownedByControlPlane" variant="secondary">instance local</Badge>
            </div>
            <p v-if="trigger.config.description">{{ trigger.config.description }}</p>
            <div class="trigger-board-meta">
              <span>{{ sourceText(trigger.config.source) }}</span>
              <span>{{ trigger.deploymentCount }} session bindings</span>
              <span>{{ trigger.enabledCount }} enabled</span>
              <span>{{ trigger.runningCount }} running</span>
              <span>{{ trigger.errorCount }} errors</span>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            :disabled="deletingHash === trigger.configHash || !trigger.ownedByControlPlane"
            :title="trigger.ownedByControlPlane ? 'Delete trigger template' : 'This trigger is owned by a controlled instance'"
            @click="deleteTemplate(trigger.configHash)"
          >
            <Trash2 :size="14" />
            <span>Delete</span>
          </Button>
        </header>

        <div v-if="trigger.deployments.length" class="trigger-board-deployments">
          <div v-for="entry in trigger.deployments" :key="`${entry.instanceId}:${entry.deployment.deploymentId || entry.deployment.configHash}`" class="trigger-board-deployment">
            <div>
              <strong>{{ entry.instanceName }}</strong>
              <span>{{ targetText(entry.deployment.target) }}</span>
              <span>{{ entry.runtime?.status || (entry.deployment.enabled ? "idle" : "disabled") }}</span>
              <span>{{ entry.deployment.origin }}</span>
            </div>
            <Button variant="outline" size="sm" @click="run(entry.instanceId, trigger.configHash, entry.deployment.deploymentId || entry.deployment.configHash)">Run</Button>
          </div>
        </div>

        <div v-if="trigger.recentRuns.length" class="trigger-board-runs">
          <div v-for="run in trigger.recentRuns.slice(0, 3)" :key="run.id" class="trigger-board-run">
            <Badge :variant="run.status === 'failed' ? 'destructive' : 'secondary'">{{ run.status }}</Badge>
            <span>{{ run.instanceName || run.instanceId }}</span>
            <span>{{ formatDate(run.startedAt) }}</span>
          </div>
        </div>
      </section>
    </div>
    <p v-else class="settings-empty">No trigger templates yet.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
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

type AiSessionTriggerSource = Extract<TriggerSource, { type: "ai-session" }>;

const queryClient = useQueryClient();
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

const weekdayOptions = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

const aiStatusOptions: Array<{ value: NonNullable<AiSessionTriggerSource["statuses"]>[number]; label: string }> = [
  { value: "running", label: "Running" },
  { value: "waiting", label: "Waiting" },
  { value: "idle", label: "Idle" },
  { value: "failed", label: "Failed" },
];

const aiPhaseOptions: Array<{ value: NonNullable<AiSessionTriggerSource["phases"]>[number]; label: string }> = [
  { value: "thinking", label: "Thinking" },
  { value: "tool", label: "Tool" },
  { value: "editing", label: "Editing" },
  { value: "approval", label: "Approval" },
  { value: "responding", label: "Responding" },
  { value: "unknown", label: "Unknown" },
];

const cooldownPresetOptions: Array<{ value: CooldownPreset; label: string; ms: number | null }> = [
  { value: "none", label: "None", ms: 0 },
  { value: "30s", label: "30 seconds", ms: 30_000 },
  { value: "1m", label: "1 minute", ms: 60_000 },
  { value: "5m", label: "5 minutes", ms: 5 * 60_000 },
  { value: "15m", label: "15 minutes", ms: 15 * 60_000 },
  { value: "1h", label: "1 hour", ms: 60 * 60_000 },
  { value: "custom", label: "Custom", ms: null },
];

const cooldownUnitMs: Record<CooldownUnit, number> = {
  second: 1000,
  minute: 60_000,
  hour: 60 * 60_000,
};

const errorText = computed(() => (triggers.error.value instanceof Error ? triggers.error.value.message : String(triggers.error.value || "")));
const sourceSectionHint = computed(() => {
  if (createForm.sourceType === "file-change") {
    return "Watch workspace paths and debounce matching file changes.";
  }
  if (createForm.sourceType === "ai-session") {
    return "React to AI session lifecycle and phase changes.";
  }
  if (createForm.scheduleKind === "interval") {
    return "Run this trigger repeatedly on a fixed interval.";
  }
  return "Run this trigger at a wall-clock time in the selected timezone.";
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
    showControlPlaneToast(error instanceof Error ? error.message : String(error));
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
    showControlPlaneToast(error instanceof Error ? error.message : String(error));
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
    showControlPlaneToast(error instanceof Error ? error.message : String(error));
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
  return cooldownPresetOptions.find((option) => option.value === createForm.cooldownPreset)?.ms || 0;
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
      return `every ${formatInterval(source.intervalMs)}`;
    }
    if (source.scheduleKind === "daily") {
      return `daily at ${source.timeOfDay} · ${source.timezone}`;
    }
    return `weekly ${formatWeekdays(source.weekdays)} at ${source.timeOfDay} · ${source.timezone}`;
  }
  if (source.type === "file-change") {
    return `${source.roots.join(", ")} · ${source.globs.join(", ")}`;
  }
  const filters = [
    source.agent ? `agent ${source.agent}` : undefined,
    source.statuses?.length ? `status ${source.statuses.join(", ")}` : undefined,
    source.phases?.length ? `phase ${source.phases.join(", ")}` : undefined,
  ].filter(Boolean);
  return filters.join(" · ") || "any AI session update";
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
  const labels = new Map(weekdayOptions.map((day) => [day.value, day.label]));
  return values.map((value) => labels.get(value) || String(value)).join(", ");
}

function defaultTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function formatInterval(value: number) {
  const units: Array<[IntervalUnit, string]> = [
    ["week", "week"],
    ["day", "day"],
    ["hour", "hour"],
    ["minute", "minute"],
  ];
  for (const [unit, label] of units) {
    const unitMs = intervalUnitMs[unit];
    if (value >= unitMs && value % unitMs === 0) {
      const count = value / unitMs;
      return `${count} ${label}${count === 1 ? "" : "s"}`;
    }
  }
  return `${value} ms`;
}

function targetText(target: TriggerTarget) {
  return target.type === "conversation" ? `conversation ${target.conversationId}` : `AI session ${target.aiSessionId}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
</script>

<style src="./ControlPlaneTriggersView.css"></style>
