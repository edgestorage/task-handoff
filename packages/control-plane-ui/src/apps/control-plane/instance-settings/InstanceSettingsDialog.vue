<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent class="instance-settings-dialog" aria-describedby="instance-settings-description">
      <DialogHeader class="instance-settings-header">
        <div class="instance-settings-heading">
          <span>Instance settings</span>
          <div class="instance-settings-title-row">
            <DialogTitle>{{ instance?.name || "Instance unavailable" }}</DialogTitle>
            <Badge v-if="instance" :variant="instance.connectionStatus === 'online' ? 'default' : 'secondary'">
              {{ instance.status }} · {{ instance.connectionStatus }}
            </Badge>
          </div>
          <DialogDescription id="instance-settings-description">
            Configure this instance. Model credentials remain in control-plane Settings.
          </DialogDescription>
        </div>
        <button type="button" class="instance-settings-close" aria-label="Close instance settings" @click="handleOpenChange(false)">
          <X :size="16" />
        </button>
      </DialogHeader>

      <div v-if="!instance" class="instance-settings-empty">This instance is no longer available.</div>
      <Tabs v-else v-model="section" class="instance-settings-tabs">
        <TabsList class="instance-settings-tabs-list" aria-label="Instance settings sections">
          <TabsTrigger value="general"><SlidersHorizontal :size="14" />General</TabsTrigger>
          <TabsTrigger value="models"><Cpu :size="14" />Models</TabsTrigger>
          <TabsTrigger value="apps"><Boxes :size="14" />Apps</TabsTrigger>
        </TabsList>

        <ScrollArea class="instance-settings-scroll">
          <TabsContent value="general" class="instance-settings-section">
            <section class="instance-settings-card">
              <div class="instance-settings-section-heading">
                <h3>Instance details</h3>
                <p>Runtime and workspace information reported by the node.</p>
              </div>
              <dl class="instance-settings-grid">
                <div><dt>ID</dt><dd><code>{{ instance.id }}</code></dd></div>
                <div><dt>State</dt><dd>{{ instance.status }} · {{ instance.connectionStatus }}</dd></div>
                <div><dt>Node</dt><dd>{{ instance.node?.name || instance.nodeId }}</dd></div>
                <div><dt>Runtime</dt><dd>{{ instance.runtime?.name || instance.runtimeId }}</dd></div>
                <div><dt>Image</dt><dd>{{ instance.image?.name || instance.imageId || "None" }}</dd></div>
                <div><dt>Workspace</dt><dd>{{ instance.workspace.path || instance.runtime?.workspacePath || "Not reported" }} · {{ instance.workspace.status }}</dd></div>
                <div><dt>Protocol</dt><dd>{{ instance.protocolVersion || instance.build?.protocolVersion || "Not reported" }}</dd></div>
                <div><dt>Build</dt><dd>{{ instance.build?.packageVersion || instance.instanceVersion || "Not reported" }}</dd></div>
              </dl>
            </section>

            <section class="instance-settings-card">
              <div class="instance-settings-section-heading">
                <h3>Configuration</h3>
                <p>Instance-level defaults for agent configuration and newly created sessions.</p>
              </div>
              <div class="instance-settings-control-row">
                <div class="instance-settings-general-controls">
                  <label class="instance-settings-name-control">
                    <span>
                      <strong>Instance name</strong>
                      <small>Used to identify this instance throughout the control plane.</small>
                    </span>
                    <ControlPlaneInput v-model="instanceName" :disabled="savingGeneral" maxlength="160" placeholder="Instance name" />
                  </label>
                  <label class="instance-settings-checkbox">
                    <Checkbox :model-value="autoImportAgentConfigs" :disabled="savingGeneral" @update:model-value="autoImportAgentConfigs = $event === true" />
                    <span>
                      <strong>Automatically import agent configuration</strong>
                      <small>Import supported agent configuration when this instance starts.</small>
                    </span>
                  </label>
                  <label class="instance-settings-select-control">
                    <span>
                      <strong>New Codex session permissions</strong>
                      <small>Used to initialize new session composers. Existing sessions keep their own selection.</small>
                    </span>
                    <ControlPlaneSelect v-model="defaultCodexPermissionMode" :disabled="savingGeneral">
                      <ControlPlaneSelectItem value="ask">Ask for approval</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="auto-review">Approve for me</ControlPlaneSelectItem>
                      <ControlPlaneSelectItem value="full-access">Full access</ControlPlaneSelectItem>
                    </ControlPlaneSelect>
                  </label>
                </div>
                <Button size="sm" :disabled="savingGeneral || !generalChanged || !validInstanceName" @click="saveGeneral">
                  {{ savingGeneral ? "Saving" : "Save changes" }}
                </Button>
              </div>
            </section>
          </TabsContent>

          <TabsContent value="models" class="instance-settings-section">
            <section class="instance-settings-card">
              <h3>Model selection</h3>
              <p class="instance-settings-help">Control-plane models are deployed to this instance's node before assignment. Node-local models are available only on their owner node. Changes apply on the next start or restart.</p>
              <div class="instance-model-grid">
                <label v-for="app in modelApps" :key="app">
                  <span>{{ app === "codex" ? "Codex" : "Claude" }}</span>
                  <ControlPlaneSelect :model-value="modelDraftValue(app)" :disabled="savingModels" @update:model-value="setModelDraft(app, $event)">
                    <ControlPlaneSelectItem :value="noModelValue">No model</ControlPlaneSelectItem>
                    <ControlPlaneSelectItem :value="defaultModelValue">Global default</ControlPlaneSelectItem>
                    <ControlPlaneSelectItem v-if="invalidSelection(app)" :value="draftModelId(app)!">Unavailable · {{ draftModelId(app) }}</ControlPlaneSelectItem>
                    <ControlPlaneSelectItem v-for="model in selectableModels(app)" :key="`${app}-${model.id}`" :value="model.id">{{ modelOptionLabel(model) }}</ControlPlaneSelectItem>
                  </ControlPlaneSelect>
                  <small v-if="invalidSelection(app)" class="instance-settings-error">The stored selection is deleted, disabled, or belongs to another app. Choose a model or Global default.</small>
                  <small v-else>Effective: {{ effectiveModelLabel(app) }}</small>
                </label>
              </div>
              <div class="instance-settings-actions">
                <Button size="sm" :disabled="savingModels || !modelsChanged" @click="saveModels">
                  {{ savingModels ? "Saving" : "Save model settings" }}
                </Button>
              </div>
            </section>
          </TabsContent>

          <TabsContent value="apps" class="instance-settings-section">
            <section class="instance-settings-card">
              <div class="instance-app-heading">
                <div>
                  <h3>Managed apps</h3>
                  <p class="instance-settings-help">Install and remove trusted built-in apps on this controlled computer.</p>
                </div>
                <div v-if="appManagement" class="instance-app-heading-actions">
                  <Badge variant="secondary">{{ appManagement.capabilities.platform }} · {{ appManagement.capabilities.arch }}</Badge>
                  <Button size="icon" variant="ghost" aria-label="Refresh managed apps" :disabled="appManagementLoading" @click="refreshApps">
                    <RefreshCw :class="{ 'animate-spin motion-reduce:animate-none': appManagementLoading }" :size="14" />
                  </Button>
                </div>
              </div>
              <p v-if="appManagement" class="instance-settings-observed">Observed {{ formatObservedAt(appManagement.observedAt) }} · Privilege {{ appManagement.capabilities.privilege }}</p>
              <div v-if="appManagementLoading && !appManagement" class="instance-settings-empty">Loading the controlled computer's app capabilities…</div>
              <div v-else-if="appManagementError" class="instance-app-issues" role="alert">
                <strong>App management unavailable</strong>
                <p>{{ appManagementError }}</p>
                <Button size="sm" variant="outline" @click="refreshApps">Retry</Button>
              </div>
              <p v-else-if="!appManagement" class="instance-settings-empty">No authoritative app management snapshot is available.</p>
              <p v-else-if="!appManagement.apps.length" class="instance-settings-empty">This controlled instance does not publish any managed apps.</p>
              <template v-else>
                <div class="instance-app-toolbar" aria-label="Managed app filters">
                  <div class="instance-app-filters">
                    <Button v-for="filter in appFilters" :key="filter.value" size="sm" :variant="appFilter === filter.value ? 'secondary' : 'ghost'" :aria-pressed="appFilter === filter.value" @click="appFilter = filter.value">
                      {{ filter.label }} <span>{{ filter.count }}</span>
                    </Button>
                  </div>
                  <small>{{ installableAppCount ? `${installableAppCount} ready to install` : "No installs available" }}</small>
                </div>
                <p v-if="!filteredManagedApps.length" class="instance-settings-empty">No apps match this filter.</p>
                <div v-else class="instance-app-list">
                  <article v-for="app in filteredManagedApps" :key="app.id" class="instance-app-row instance-managed-app-row">
                    <div class="instance-app-main">
                      <div class="instance-app-identity">
                        <span class="instance-app-icon" aria-hidden="true"><component :is="managedAppIcon(app)" :size="17" /></span>
                        <div class="instance-app-copy">
                          <strong>{{ app.name }}</strong>
                          <small v-if="app.description">{{ app.description }}</small>
                          <code>{{ app.id }} · {{ app.kind }}<template v-if="app.version"> · {{ app.version }}</template></code>
                          <small v-if="appActionHint(app)" class="instance-app-action-reason">{{ appActionHint(app) }}</small>
                        </div>
                      </div>
                      <div class="instance-app-controls">
                        <Badge :variant="managedAppBadgeVariant(app.state)">{{ managedAppStateLabel(app.state) }}</Badge>
                        <Button v-if="activeJob(app)" size="sm" disabled>
                          <LoaderCircle class="animate-spin motion-reduce:animate-none" :size="13" />
                          {{ activeJob(app)?.operation === "install" ? "Installing" : "Uninstalling" }}
                        </Button>
                        <Button v-else-if="app.canInstall" size="sm" :disabled="operationSubmitting === app.id" @click="openAppConfirmation(app, 'install')">Install</Button>
                        <Button v-else-if="app.canUninstall" size="sm" variant="destructive" :disabled="operationSubmitting === app.id" @click="openAppConfirmation(app, 'uninstall')">Uninstall</Button>
                      </div>
                    </div>
                    <div v-if="activeJob(app) || executionJob(app)?.command || executionJob(app)?.logTail || terminalJob(app)" class="instance-app-activity">
                      <small v-if="activeJob(app)" class="instance-app-job-line">{{ jobLabel(activeJob(app)!) }}</small>
                      <Progress v-if="progressPercent(activeJob(app)) !== undefined" :model-value="progressPercent(activeJob(app))" class="instance-app-progress" />
                      <details v-if="executionJob(app)?.command || executionJob(app)?.logTail" class="instance-app-terminal" :open="Boolean(activeJob(app))">
                        <summary>{{ activeJob(app) ? "Live installer output" : "Installer output" }}<template v-if="executionJob(app)?.logTruncated"> · latest 32 KB</template></summary>
                        <pre aria-live="polite">{{ executionOutput(executionJob(app)!) }}</pre>
                      </details>
                      <small v-if="terminalJob(app)" :class="terminalJob(app)?.state === 'succeeded' ? 'instance-settings-success' : 'instance-settings-error'" role="status">
                        {{ terminalJobLabel(terminalJob(app)!) }}<template v-if="terminalJob(app)?.error"> · {{ terminalJob(app)?.error?.message }}</template><template v-if="terminalJob(app)?.error?.retryable"> You can retry from the current detected state.</template>
                      </small>
                    </div>
                  </article>
                </div>
              </template>
            </section>

            <section class="instance-settings-card">
              <div class="instance-app-heading">
                <div>
                  <h3>Custom launchers</h3>
                  <p class="instance-settings-help">Launcher entries only. They register programs already present on the computer and cannot install software.</p>
                </div>
                <Badge :variant="inventoryBadgeVariant">{{ inventoryStateLabel }}</Badge>
              </div>
              <p v-if="instance.appInventory" class="instance-settings-observed">Inventory observed {{ formatObservedAt(instance.appInventory.observedAt) }}</p>
              <p v-if="!customInventoryApps.length" class="instance-settings-empty">No custom launchers are registered on this instance.</p>
              <div v-else class="instance-app-list">
                <article v-for="app in customInventoryApps" :key="app.id" class="instance-app-row">
                  <div><strong>{{ app.name }}</strong><code>{{ app.id }} · {{ app.kind }}</code><small v-if="app.diagnosticCode">Executable not found on the controlled computer.</small></div>
                  <Badge :variant="app.availability === 'available' ? 'default' : 'secondary'">{{ app.availability }}</Badge>
                </article>
              </div>
              <div v-if="instance.appInventory?.issues.length" class="instance-app-issues" role="status">
                <strong>Inventory diagnostics</strong>
                <p v-for="issue in instance.appInventory.issues" :key="issue.code">{{ issue.message }} <code>{{ issue.code }}</code></p>
              </div>
            </section>
          </TabsContent>
        </ScrollArea>
      </Tabs>

      <p v-if="error" class="instance-settings-error" role="alert">{{ error }}</p>
      <p v-if="success" class="instance-settings-success" role="status">{{ success }}</p>

      <AlertDialog :open="Boolean(appConfirmation)" @update:open="(value) => { if (!value && !operationSubmitting) appConfirmation = undefined; }">
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{{ appConfirmation?.operation === "uninstall" ? "Uninstall" : "Install" }} {{ appConfirmation?.app.name }}?</AlertDialogTitle>
            <AlertDialogDescription v-if="appConfirmation?.operation === 'uninstall'">
              The program files owned by the built-in recipe will be removed. User configuration, AI sessions, and workspaces are preserved. Running app sessions must be stopped first.
            </AlertDialogDescription>
            <AlertDialogDescription v-else>
              The controlled instance will execute its trusted built-in recipe on the final computer. The request cannot provide a custom package, URL, or command.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div v-if="appConfirmation" class="instance-app-confirmation-summary">
            <span><small>App</small><strong>{{ appConfirmation.app.name }}</strong></span>
            <span><small>Target</small><strong>{{ instance?.name }}</strong></span>
            <span><small>Privilege</small><strong>{{ appManagement?.capabilities.privilege || "Not reported" }}</strong></span>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel :disabled="Boolean(operationSubmitting)">Cancel</AlertDialogCancel>
            <Button type="button" :disabled="Boolean(operationSubmitting)" @click="confirmAppOperation">
              <LoaderCircle v-if="operationSubmitting" class="animate-spin motion-reduce:animate-none" :size="14" />
              {{ operationSubmitting ? "Queuing…" : appConfirmation?.operation === "uninstall" ? "Confirm uninstall" : "Confirm install" }}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Bot, Boxes, Code2, Cpu, Globe2, LoaderCircle, Monitor, RefreshCw, SlidersHorizontal, TerminalSquare, X } from "@lucide/vue";
import type { AiSessionPermissionMode } from "@task-handoff/protocol/ai-sessions";
import type { AppManagementJob, AppManagementOperation, AppManagementSnapshot, InstanceBoardItem, ManagedAppProjection, ModelApp, ModelConfig, ModelSelection, UpdateControlledInstanceInput } from "../../../api/types";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Progress } from "../../../components/ui/progress";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { effectiveInstanceModel, invalidInstanceModelSelection, selectableInstanceModels } from "./instanceSettingsState";

type InstanceSettingsSection = "general" | "models" | "apps";
type AppFilter = "all" | "available" | "installed";

const props = defineProps<{
  open: boolean;
  initialSection?: InstanceSettingsSection;
  instance?: InstanceBoardItem;
  models: ModelConfig[];
  appManagement?: AppManagementSnapshot;
  appManagementLoading: boolean;
  appManagementError: string;
  refreshAppManagement: (instanceId: string) => Promise<void>;
  manageApp: (instanceId: string, appId: string, operation: AppManagementOperation) => Promise<void>;
  updateInstance: (instance: InstanceBoardItem, input: UpdateControlledInstanceInput) => Promise<void>;
}>();

const emit = defineEmits<{ "update:open": [open: boolean] }>();
const section = ref<InstanceSettingsSection>("general");
const instanceName = ref("");
const autoImportAgentConfigs = ref(true);
const defaultCodexPermissionMode = ref<AiSessionPermissionMode>("ask");
const modelSelection = ref<ModelSelection>({});
const savingGeneral = ref(false);
const savingModels = ref(false);
const error = ref("");
const success = ref("");
const operationSubmitting = ref("");
const appConfirmation = ref<{ app: ManagedAppProjection; operation: AppManagementOperation }>();
const appFilter = ref<AppFilter>("all");
const defaultModelValue = "__default__";
const noModelValue = "__none__";
const modelApps: ModelApp[] = ["codex", "claude"];

const generalChanged = computed(() => Boolean(props.instance && (
  instanceName.value.trim() !== props.instance.name
  || autoImportAgentConfigs.value !== props.instance.config.autoImportAgentConfigs
  || defaultCodexPermissionMode.value !== props.instance.config.defaultCodexPermissionMode
)));
const validInstanceName = computed(() => instanceName.value.trim().length > 0);
const modelsChanged = computed(() => JSON.stringify(normalizedSelection(modelSelection.value)) !== JSON.stringify(normalizedSelection(props.instance?.modelSelection || {})));
const inventoryState = computed<"current" | "stale" | "not-reported" | "empty" | "degraded">(() => {
  const inventory = props.instance?.appInventory;
  if (!inventory) return "not-reported";
  if (inventory.issues.length) return "degraded";
  if (props.instance?.connectionStatus !== "online") return "stale";
  return inventory.items.length ? "current" : "empty";
});
const inventoryStateLabel = computed(() => ({ current: "Current", stale: "Stale", "not-reported": "Not reported", empty: "Empty", degraded: "Degraded" })[inventoryState.value]);
const inventoryBadgeVariant = computed<"default" | "secondary" | "destructive">(() => inventoryState.value === "current" ? "default" : inventoryState.value === "degraded" ? "destructive" : "secondary");
const customInventoryApps = computed(() => props.instance?.appInventory?.items.filter((app) => app.source === "custom") || []);
const installableAppCount = computed(() => props.appManagement?.apps.filter((app) => app.canInstall).length || 0);
const installedAppCount = computed(() => props.appManagement?.apps.filter((app) => app.state === "installed").length || 0);
const appFilters = computed(() => [
  { value: "all" as const, label: "All", count: props.appManagement?.apps.length || 0 },
  { value: "available" as const, label: "Available", count: installableAppCount.value },
  { value: "installed" as const, label: "Installed", count: installedAppCount.value },
]);
const filteredManagedApps = computed(() => {
  const apps = props.appManagement?.apps || [];
  if (appFilter.value === "available") return apps.filter((app) => app.canInstall);
  if (appFilter.value === "installed") return apps.filter((app) => app.state === "installed");
  return apps;
});

watch(
  [() => props.open, () => props.instance?.id, () => props.initialSection],
  ([open]) => {
    if (!open || !props.instance) return;
    section.value = props.initialSection || "general";
    instanceName.value = props.instance.name;
    autoImportAgentConfigs.value = props.instance.config.autoImportAgentConfigs;
    defaultCodexPermissionMode.value = props.instance.config.defaultCodexPermissionMode;
    modelSelection.value = { ...props.instance.modelSelection };
    error.value = "";
    success.value = "";
    appFilter.value = "all";
  },
  { immediate: true },
);

watch(() => props.instance, (instance) => {
  if (props.open && !instance) handleOpenChange(false);
});

watch(
  [() => props.open, () => props.instance?.id, () => section.value],
  ([open, instanceId, activeSection]) => {
    if (open && instanceId && activeSection === "apps") void props.refreshAppManagement(instanceId);
  },
  { immediate: true },
);

function handleOpenChange(open: boolean) {
  if (!open) {
    section.value = "general";
    error.value = "";
    success.value = "";
  }
  emit("update:open", open);
}

function selectableModels(app: ModelApp) {
  return selectableInstanceModels(props.models, app, props.instance?.nodeId || "");
}

function modelOptionLabel(model: ModelConfig) {
  const availableFromControlPlane = model.locations?.some((location) => location.type === "control-plane" && location.enabled);
  return `${model.name} · ${model.model} · ${availableFromControlPlane ? "copy to node" : "this node"}`;
}

function draftModelId(app: ModelApp) {
  return app === "codex" ? modelSelection.value.codexModelHash : modelSelection.value.claudeModelHash;
}

function modelDraftValue(app: ModelApp) {
  return draftModelId(app) === null ? noModelValue : draftModelId(app) || defaultModelValue;
}

function invalidSelection(app: ModelApp) {
  return invalidInstanceModelSelection(props.models, app, props.instance?.nodeId || "", draftModelId(app));
}

function effectiveModelLabel(app: ModelApp) {
  if (draftModelId(app) === null) return "No model";
  const match = effectiveInstanceModel(props.models, app, props.instance?.nodeId || "", draftModelId(app));
  return match ? `${match.name} · ${match.model}` : "No enabled global model";
}

function setModelDraft(app: ModelApp, value: string) {
  const id = value === defaultModelValue ? undefined : value === noModelValue ? null : value;
  modelSelection.value = normalizedSelection({
    ...modelSelection.value,
    ...(app === "codex" ? { codexModelHash: id } : { claudeModelHash: id }),
  });
  error.value = "";
  success.value = "";
}

function normalizedSelection(value: ModelSelection): ModelSelection {
  return {
    ...(value.codexModelHash !== undefined ? { codexModelHash: value.codexModelHash } : {}),
    ...(value.claudeModelHash !== undefined ? { claudeModelHash: value.claudeModelHash } : {}),
  };
}

async function saveGeneral() {
  if (!props.instance || savingGeneral.value || !validInstanceName.value) return;
  savingGeneral.value = true;
  error.value = "";
  success.value = "";
  try {
    await props.updateInstance(props.instance, {
      name: instanceName.value.trim(),
      config: {
        autoImportAgentConfigs: autoImportAgentConfigs.value,
        defaultCodexPermissionMode: defaultCodexPermissionMode.value,
      },
    });
    instanceName.value = instanceName.value.trim();
    success.value = "General settings saved.";
  } catch (cause) {
    instanceName.value = props.instance.name;
    autoImportAgentConfigs.value = props.instance.config.autoImportAgentConfigs;
    defaultCodexPermissionMode.value = props.instance.config.defaultCodexPermissionMode;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    savingGeneral.value = false;
  }
}

async function saveModels() {
  if (!props.instance || savingModels.value) return;
  savingModels.value = true;
  error.value = "";
  success.value = "";
  try {
    await props.updateInstance(props.instance, { modelSelection: normalizedSelection(modelSelection.value) });
    success.value = "Model settings saved. They will apply on the next start or restart.";
  } catch (cause) {
    modelSelection.value = { ...props.instance.modelSelection };
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    savingModels.value = false;
  }
}

function formatObservedAt(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function refreshApps() {
  if (props.instance) void props.refreshAppManagement(props.instance.id);
}

function activeJob(app: ManagedAppProjection) {
  return props.appManagement?.activeJobs.find((job) => job.id === app.activeJobId || job.appId === app.id);
}

function terminalJob(app: ManagedAppProjection) {
  return props.appManagement?.recentJobs.find((job) => job.appId === app.id);
}

function executionJob(app: ManagedAppProjection) {
  return activeJob(app) || terminalJob(app);
}

function executionOutput(job: AppManagementJob) {
  if (job.logTail) return job.logTail;
  if (!job.command) return "Waiting for the installer to start…";
  return `$ ${[job.command.executable, ...job.command.args].map(commandArgument).join(" ")}\n`;
}

function commandArgument(value: string) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

function progressPercent(job?: AppManagementJob) {
  if (!job?.progress?.total || job.progress.current === undefined) return undefined;
  return Math.max(0, Math.min(100, (job.progress.current / job.progress.total) * 100));
}

function jobLabel(job: AppManagementJob) {
  const operation = job.operation === "install" ? "Installing" : "Uninstalling";
  return `${job.state === "queued" ? "Queued" : operation}${job.phase ? ` · ${humanizeJobPhase(job.phase)}` : ""}`;
}

function humanizeJobPhase(phase: string) {
  return phase.replace(/[-_]+/g, " ").replace(/^./, (value) => value.toUpperCase());
}

function terminalJobLabel(job: AppManagementJob) {
  const operation = job.operation === "install" ? "Installation" : "Uninstallation";
  if (job.state === "succeeded") return `${operation} succeeded`;
  if (job.state === "cancelled") return `${operation} cancelled`;
  if (job.state === "interrupted") return `${operation} interrupted`;
  return `${operation} failed`;
}

function managedAppBadgeVariant(state: ManagedAppProjection["state"]): "default" | "secondary" | "destructive" {
  return state === "installed" ? "default" : state === "broken" ? "destructive" : "secondary";
}

function managedAppStateLabel(state: ManagedAppProjection["state"]) {
  return ({ installed: "Installed", "not-installed": "Not installed", broken: "Needs attention", unsupported: "Unsupported" })[state];
}

function managedAppIcon(app: ManagedAppProjection) {
  if (app.id === "codex" || app.id === "claude") return app.id === "codex" ? Code2 : Bot;
  if (app.kind === "gui") return app.id === "chromium" ? Globe2 : Monitor;
  if (app.kind === "web") return Globe2;
  return TerminalSquare;
}

function appActionHint(app: ManagedAppProjection) {
  if (activeJob(app) || app.canInstall || app.canUninstall) return "";
  const reason = app.state === "installed" ? app.uninstallReason : app.installReason;
  if (reason?.code === "BUNDLED" && app.state === "not-installed") return "Not included in this controlled computer build.";
  return reason?.message || "No app management action is available.";
}

function openAppConfirmation(app: ManagedAppProjection, operation: AppManagementOperation) {
  appConfirmation.value = { app, operation };
  error.value = "";
  success.value = "";
}

async function confirmAppOperation() {
  if (!props.instance || !appConfirmation.value || operationSubmitting.value) return;
  const { app, operation } = appConfirmation.value;
  operationSubmitting.value = app.id;
  error.value = "";
  success.value = "";
  try {
    await props.manageApp(props.instance.id, app.id, operation);
    success.value = `${operation === "install" ? "Installation" : "Uninstallation"} queued for ${app.name}.`;
    appConfirmation.value = undefined;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    operationSubmitting.value = "";
  }
}
</script>

<style scoped>
:global(.instance-settings-dialog[role="dialog"]) {
  width: min(800px, calc(100vw - 36px));
  max-width: 800px;
  height: 680px;
  max-height: calc(100vh - 36px);
  grid-template-rows: auto minmax(0, 1fr) auto;
  overflow: hidden;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-inset);
  box-shadow: var(--shadow-popover);
  padding: 14px;
}

.instance-settings-header {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  text-align: left;
}

.instance-settings-heading {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.instance-settings-heading > span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
  text-transform: uppercase;
}

.instance-settings-title-row {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
}

.instance-settings-title-row :deep(h2) {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 19px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.instance-settings-heading :deep(p) {
  color: var(--text-muted);
  font-size: 12px;
}

.instance-settings-close {
  display: grid;
  flex: 0 0 auto;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: var(--surface-hover);
  color: var(--brand-accent-muted);
  cursor: pointer;
}

.instance-settings-close:hover,
.instance-settings-close:focus-visible {
  background: var(--surface-active);
  color: var(--white);
  outline: none;
}

.instance-settings-tabs {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
  min-height: 0;
}

.instance-settings-tabs-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: 100%;
  height: auto;
  min-height: 36px;
  gap: 1px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  padding: 2px;
}

.instance-settings-tabs-list :deep(button) {
  height: 30px;
  border-radius: 5px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 750;
  padding: 0 8px;
}

.instance-settings-tabs-list :deep(.truncate) {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
}

.instance-settings-tabs-list :deep(.truncate svg) {
  flex: 0 0 auto;
}

.instance-settings-tabs-list :deep(button:not([data-state="active"]):hover) {
  background: var(--surface-hover);
  color: var(--text-strong);
}

.instance-settings-tabs-list :deep(button[data-state="active"]) {
  background: var(--surface-active);
  color: var(--white);
  box-shadow: none;
}

.instance-settings-scroll {
  height: 100%;
  min-height: 0;
}

.instance-settings-section {
  display: grid;
  gap: 16px;
  margin: 0;
  padding: 2px 10px 4px 2px;
}

.instance-settings-card {
  display: grid;
  gap: 12px;
  border-top: 1px solid var(--line);
  padding-top: 16px;
}

.instance-settings-card:first-child {
  border-top: 0;
  padding-top: 0;
}

.instance-settings-card h3,
.instance-app-heading h3 {
  margin: 0;
  color: var(--text-strong);
  font-size: 13px;
}

.instance-settings-section-heading {
  display: grid;
  gap: 3px;
}

.instance-settings-section-heading p {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
}

.instance-settings-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
}

.instance-settings-grid div {
  display: grid;
  min-width: 0;
  gap: 4px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  padding: 10px;
}

.instance-settings-grid dt {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
  text-transform: uppercase;
}

.instance-settings-grid dd {
  overflow-wrap: anywhere;
  margin: 0;
  color: var(--text-strong);
  font-size: 12px;
}

.instance-settings-grid code {
  color: inherit;
  font-size: 11px;
}

.instance-settings-control-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  padding: 12px;
}

.instance-settings-general-controls {
  display: grid;
  flex: 1;
  gap: 14px;
}

.instance-settings-checkbox {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 10px;
}

.instance-settings-checkbox span,
.instance-settings-name-control > span,
.instance-settings-select-control > span,
.instance-model-grid label {
  display: grid;
  gap: 5px;
}

.instance-settings-checkbox small,
.instance-settings-name-control small,
.instance-settings-select-control small,
.instance-model-grid small,
.instance-app-row small,
.instance-settings-help,
.instance-settings-observed {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
}

.instance-settings-checkbox strong {
  color: var(--text-strong);
  font-size: 12px;
}

.instance-settings-name-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 240px);
  align-items: center;
  gap: 16px;
}

.instance-settings-name-control strong {
  color: var(--text-strong);
  font-size: 12px;
}

.instance-settings-select-control {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 240px);
  align-items: center;
  gap: 16px;
}

.instance-settings-select-control strong {
  color: var(--text-strong);
  font-size: 12px;
}

.instance-settings-actions {
  display: flex;
  justify-content: flex-end;
}

.instance-model-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.instance-app-heading,
.instance-app-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.instance-app-heading-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}

.instance-app-heading-actions :deep(button) {
  width: 28px;
  height: 28px;
}

.instance-app-toolbar {
  display: flex;
  min-height: 36px;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-block: 1px solid var(--line);
  padding: 6px 0;
}

.instance-app-toolbar > small {
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.instance-app-filters {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 3px;
}

.instance-app-filters :deep(button) {
  height: 27px;
  gap: 6px;
  padding-inline: 9px;
}

.instance-app-filters :deep(button span) {
  color: var(--text-muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.instance-app-list {
  display: grid;
  gap: 8px;
}

.instance-app-row {
  border-top: 1px solid var(--line);
  padding-top: 10px;
}

.instance-app-row > div {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.instance-managed-app-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: stretch;
  justify-content: normal;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  padding: 12px;
}

.instance-managed-app-row:first-child {
  border-top: 1px solid var(--line);
}

.instance-app-copy {
  display: grid;
  flex: 1 1 auto;
  min-width: 0;
  gap: 3px;
}

.instance-app-copy > strong {
  color: var(--text-strong);
  font-size: 13px;
}

.instance-app-main,
.instance-app-identity {
  display: flex !important;
  min-width: 0;
  align-items: flex-start;
}

.instance-app-main {
  justify-content: space-between;
  gap: 16px;
}

.instance-app-identity {
  flex: 1 1 auto;
  gap: 10px;
}

.instance-app-icon {
  display: grid;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  place-items: center;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  color: var(--brand-accent-muted);
}

.instance-app-controls {
  display: flex !important;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px !important;
}

.instance-app-action-reason {
  color: var(--text-muted);
}

.instance-app-activity {
  display: grid !important;
  gap: 5px !important;
  border-top: 1px solid var(--line);
  margin-top: 10px;
  padding-top: 9px;
}

.instance-app-job-line {
  color: var(--brand-accent-muted) !important;
  font-weight: 700;
}

.instance-app-progress {
  width: min(300px, 100%);
  margin-top: 3px;
}

.instance-app-terminal {
  width: 100%;
  margin-top: 5px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: #071014;
}

.instance-app-confirmation-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  padding: 10px;
}

.instance-app-confirmation-summary span {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.instance-app-confirmation-summary small {
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}

.instance-app-confirmation-summary strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.instance-app-terminal summary {
  cursor: pointer;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  padding: 7px 9px;
  user-select: none;
}

.instance-app-terminal pre {
  max-height: 180px;
  overflow: auto;
  margin: 0;
  border-top: 1px solid var(--line);
  color: #d7e3e7;
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.5;
  padding: 9px;
  white-space: pre-wrap;
  word-break: break-word;
}

.instance-app-row code,
.instance-app-issues code {
  overflow-wrap: anywhere;
  color: var(--text-muted);
  font-size: 11px;
}

.instance-app-issues {
  border-left: 3px solid var(--status-danger);
  padding-left: 10px;
  color: var(--terminal-text);
  font-size: 12px;
}

.instance-app-issues p {
  margin: 5px 0 0;
}

.instance-settings-error {
  margin: 0;
  color: var(--status-danger);
  font-size: 12px;
}

.instance-settings-success {
  margin: 0;
  color: var(--status-success);
  font-size: 12px;
}

.instance-settings-empty {
  color: var(--text-muted);
  font-size: 13px;
  padding: 18px 0;
}

@media (max-width: 680px) {
  .instance-settings-grid,
  .instance-model-grid {
    grid-template-columns: 1fr;
  }

  .instance-settings-control-row {
    align-items: stretch;
    flex-direction: column;
  }

  .instance-settings-name-control,
  .instance-settings-select-control {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .instance-managed-app-row {
    padding: 10px;
  }

  .instance-app-toolbar,
  .instance-app-main {
    align-items: stretch;
    flex-direction: column;
  }

  .instance-app-controls {
    width: 100%;
    max-width: none;
    align-items: flex-start;
    justify-items: start;
  }

  .instance-app-confirmation-summary {
    grid-template-columns: 1fr;
  }
}
</style>
