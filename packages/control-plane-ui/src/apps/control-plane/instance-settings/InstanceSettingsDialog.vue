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
                <p>Applied the next time this instance starts.</p>
              </div>
              <div class="instance-settings-control-row">
                <label class="instance-settings-checkbox">
                  <Checkbox :model-value="autoImportAgentConfigs" :disabled="savingGeneral" @update:model-value="autoImportAgentConfigs = $event === true" />
                  <span>
                    <strong>Automatically import agent configuration</strong>
                    <small>Import supported agent configuration when this instance starts.</small>
                  </span>
                </label>
                <Button size="sm" :disabled="savingGeneral || !generalChanged" @click="saveGeneral">
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
                    <ControlPlaneSelectItem :value="defaultModelValue">Global default</ControlPlaneSelectItem>
                    <ControlPlaneSelectItem :value="noModelValue">No model</ControlPlaneSelectItem>
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
                  <h3>Installed apps</h3>
                  <p class="instance-settings-help">Reported by this instance's App runtime. This inventory is read-only.</p>
                </div>
                <Badge :variant="inventoryBadgeVariant">{{ inventoryStateLabel }}</Badge>
              </div>
              <p v-if="instance.appInventory" class="instance-settings-observed">Observed {{ formatObservedAt(instance.appInventory.observedAt) }}</p>
              <p v-if="inventoryState === 'not-reported'" class="instance-settings-empty">This instance has not reported an App inventory yet.</p>
              <p v-else-if="inventoryState === 'empty'" class="instance-settings-empty">The instance reported an empty App catalog.</p>
              <div v-else class="instance-app-list">
                <article v-for="app in instance.appInventory?.items || []" :key="app.id" class="instance-app-row">
                  <div>
                    <strong>{{ app.name }}</strong>
                    <code>{{ app.id }} · {{ app.kind }} · {{ app.source }}</code>
                    <small v-if="app.diagnosticCode">Executable not found in the instance runtime.</small>
                    <small v-else>{{ app.capabilities.supportsCwdSelection ? "Working directory selectable" : "Uses instance workspace" }}<template v-if="app.capabilities.automation"> · {{ app.capabilities.automation }} automation</template></small>
                  </div>
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
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Boxes, Cpu, SlidersHorizontal, X } from "@lucide/vue";
import type { InstanceBoardItem, ModelApp, ModelConfig, ModelSelection, UpdateControlledInstanceInput } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { effectiveInstanceModel, invalidInstanceModelSelection, selectableInstanceModels } from "./instanceSettingsState";

type InstanceSettingsSection = "general" | "models" | "apps";

const props = defineProps<{
  open: boolean;
  instance?: InstanceBoardItem;
  models: ModelConfig[];
  updateInstance: (instance: InstanceBoardItem, input: UpdateControlledInstanceInput) => Promise<void>;
}>();

const emit = defineEmits<{ "update:open": [open: boolean] }>();
const section = ref<InstanceSettingsSection>("general");
const autoImportAgentConfigs = ref(true);
const modelSelection = ref<ModelSelection>({});
const savingGeneral = ref(false);
const savingModels = ref(false);
const error = ref("");
const success = ref("");
const defaultModelValue = "__default__";
const noModelValue = "__none__";
const modelApps: ModelApp[] = ["codex", "claude"];

const generalChanged = computed(() => Boolean(props.instance && autoImportAgentConfigs.value !== props.instance.config.autoImportAgentConfigs));
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

watch(
  () => [props.open, props.instance?.id] as const,
  ([open]) => {
    if (!open || !props.instance) return;
    autoImportAgentConfigs.value = props.instance.config.autoImportAgentConfigs;
    modelSelection.value = { ...props.instance.modelSelection };
    error.value = "";
    success.value = "";
  },
  { immediate: true },
);

watch(() => props.instance, (instance) => {
  if (props.open && !instance) handleOpenChange(false);
});

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
  if (!props.instance || savingGeneral.value) return;
  savingGeneral.value = true;
  error.value = "";
  success.value = "";
  try {
    await props.updateInstance(props.instance, { config: { autoImportAgentConfigs: autoImportAgentConfigs.value } });
    success.value = "General settings saved.";
  } catch (cause) {
    autoImportAgentConfigs.value = props.instance.config.autoImportAgentConfigs;
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

.instance-settings-checkbox {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  gap: 10px;
}

.instance-settings-checkbox span,
.instance-model-grid label {
  display: grid;
  gap: 5px;
}

.instance-settings-checkbox small,
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
}
</style>
