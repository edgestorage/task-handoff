<template>
  <ScrollArea class="model-settings-scroll" :horizontal="false">
    <div class="model-settings-page">
      <header class="model-page-head">
        <p>{{ t("settings.modelRegistry.pageDescription") }}</p>
        <Button size="sm" @click="openCreateDialog">
          <Plus :size="15" />
          <span>{{ t("settings.modelRegistry.add") }}</span>
        </Button>
      </header>

      <div class="model-toolbar">
        <div class="model-search">
          <Search :size="15" aria-hidden="true" />
          <ControlPlaneInput v-model="searchQuery" :aria-label="t('settings.modelRegistry.search')" :placeholder="t('settings.modelRegistry.searchPlaceholder')" />
        </div>
        <ControlPlaneSelect v-model="appFilter" :aria-label="t('settings.fields.app')">
          <ControlPlaneSelectItem value="all">{{ t("settings.modelRegistry.allApps") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="codex">Codex</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="claude">Claude</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="opencode">OpenCode</ControlPlaneSelectItem>
        </ControlPlaneSelect>
        <ControlPlaneSelect v-model="locationFilter" :aria-label="t('settings.fields.location')">
          <ControlPlaneSelectItem value="all">{{ t("settings.modelRegistry.allLocationsFilter") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="control-plane">{{ t("settings.modelRegistry.controlPlane") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem v-for="node in nodes.data.value || []" :key="node.id" :value="node.id">{{ node.name }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
        <ControlPlaneSelect v-model="statusFilter" :aria-label="t('settings.modelRegistry.statusFilter')">
          <ControlPlaneSelectItem value="all">{{ t("settings.modelRegistry.allStatuses") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="enabled">{{ t("settings.modelRegistry.enabled") }}</ControlPlaneSelectItem>
          <ControlPlaneSelectItem value="disabled">{{ t("settings.modelRegistry.disabled") }}</ControlPlaneSelectItem>
        </ControlPlaneSelect>
      </div>

      <section v-if="modelRegistry.data.value?.nodeDiagnostics.length" class="model-diagnostics" role="status" aria-live="polite">
        <div class="model-diagnostics-head">
          <AlertTriangle :size="16" aria-hidden="true" />
          <div><strong>{{ t("settings.modelRegistry.diagnostics") }}</strong><span>{{ t("settings.modelRegistry.diagnosticsDescription", { count: modelRegistry.data.value.nodeDiagnostics.length }) }}</span></div>
          <Button variant="ghost" size="sm" :disabled="modelRegistry.isFetching.value" @click="modelRegistry.refetch()"><RefreshCw :size="14" :class="{ spin: modelRegistry.isFetching.value }" /><span>{{ modelRegistry.isFetching.value ? t("settings.modelRegistry.retrying") : t("common.actions.retry") }}</span></Button>
        </div>
        <div class="model-diagnostic-list">
          <div v-for="diagnostic in modelRegistry.data.value.nodeDiagnostics" :key="`${diagnostic.nodeId}:${diagnostic.code}`" class="model-diagnostic-row">
            <strong>{{ nodeName(diagnostic.nodeId) }}</strong><span>{{ diagnostic.message }}</span><code>{{ diagnostic.code }}</code>
          </div>
        </div>
      </section>

      <section class="model-directory" :aria-label="t('settings.modelRegistry.count', { count: filteredModels.length })">
        <header class="model-directory-head">
          <strong>{{ t("settings.modelRegistry.count", { count: filteredModels.length }) }}</strong>
          <span v-if="hasActiveFilters">{{ t("settings.modelRegistry.filteredFrom", { count: models.data.value?.length || 0 }) }}</span>
        </header>

        <div v-if="models.isLoading.value" class="model-state" role="status">{{ t("settings.modelRegistry.loading") }}</div>
        <div v-else-if="models.error.value" class="model-state model-state-error">
          <span>{{ translateError(models.error.value) }}</span>
          <Button variant="outline" size="sm" @click="models.refetch()">{{ t("common.actions.retry") }}</Button>
        </div>
        <div v-else-if="!filteredModels.length" class="model-state model-empty-state">
          <Boxes :size="28" aria-hidden="true" />
          <strong>{{ hasActiveFilters ? t("settings.modelRegistry.noMatches") : t("settings.modelRegistry.empty") }}</strong>
          <p>{{ hasActiveFilters ? t("settings.modelRegistry.noMatchesDescription") : t("settings.modelRegistry.emptyDescription") }}</p>
          <Button v-if="hasActiveFilters" variant="outline" size="sm" @click="clearFilters">{{ t("settings.modelRegistry.clearFilters") }}</Button>
          <Button v-else size="sm" @click="openCreateDialog"><Plus :size="14" />{{ t("settings.modelRegistry.add") }}</Button>
        </div>
        <div v-else class="model-list">
          <article v-for="model in filteredModels" :key="model.id" class="model-row" data-model-row>
            <div class="model-row-main">
              <div class="model-identity">
                <div class="model-title-line">
                  <strong>{{ model.name }}</strong>
                  <Badge variant="secondary">{{ compatibleAppLabel(model) }}</Badge>
                  <Badge :variant="model.enabled ? 'default' : 'secondary'">{{ model.enabled ? t("settings.modelRegistry.enabled") : t("settings.modelRegistry.disabled") }}</Badge>
                </div>
                <code>{{ model.model }}</code>
                <span class="model-endpoint" :title="model.endpoint">{{ model.endpoint }}</span>
              </div>
              <div class="model-summary">
                <Popover>
                  <PopoverTrigger as-child>
                    <button type="button" class="model-summary-item model-summary-trigger">
                      <MapPin :size="14" aria-hidden="true" />
                      <span>{{ t("settings.modelRegistry.locationCount", { count: model.locations?.length || 0 }) }}</span>
                      <ChevronDown :size="14" aria-hidden="true" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent class="model-summary-popover w-[min(272px,var(--reka-popover-content-available-width))] overflow-hidden p-0" align="start" :collision-padding="10" :side-offset="4">
                    <header class="model-summary-popover-head"><strong>{{ t("settings.modelRegistry.locations") }}</strong><span>{{ t("settings.modelRegistry.locationCount", { count: model.locations?.length || 0 }) }}</span></header>
                    <ScrollArea class="model-summary-popover-scroll" :horizontal="false">
                      <div class="model-summary-popover-list">
                        <div v-for="location in model.locations || []" :key="modelLocationKey(location)" class="model-summary-popover-row">
                          <MapPin :size="14" aria-hidden="true" />
                          <span><strong>{{ modelLocationLabel(location) }}</strong><small>{{ location.type === "node" ? t("settings.modelRegistry.references", { count: location.referenceCount }) : t("settings.modelRegistry.controlPlaneManaged") }}</small></span>
                        </div>
                      </div>
                    </ScrollArea>
                  </PopoverContent>
                </Popover>
                <Popover>
                  <PopoverTrigger as-child>
                    <button type="button" class="model-summary-item model-summary-trigger">
                      <Link2 :size="14" aria-hidden="true" />
                      <span>{{ t("settings.modelRegistry.references", { count: model.referenceCount || 0 }) }}</span>
                      <ChevronDown :size="14" aria-hidden="true" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent class="model-summary-popover w-[min(272px,var(--reka-popover-content-available-width))] overflow-hidden p-0" align="start" :collision-padding="10" :side-offset="4">
                    <header class="model-summary-popover-head"><strong>{{ t("settings.modelRegistry.referenceDistribution") }}</strong><span>{{ t("settings.modelRegistry.references", { count: model.referenceCount || 0 }) }}</span></header>
                    <ScrollArea v-if="referenceLocations(model).length" class="model-summary-popover-scroll" :horizontal="false">
                      <div class="model-summary-popover-list">
                        <div v-for="location in referenceLocations(model)" :key="modelLocationKey(location)" class="model-summary-popover-row">
                          <Link2 :size="14" aria-hidden="true" />
                          <span><strong>{{ modelLocationLabel(location) }}</strong><small>{{ t("settings.modelRegistry.inUseBy", { count: location.referenceCount }) }}</small></span>
                        </div>
                      </div>
                    </ScrollArea>
                    <p v-else class="model-summary-popover-empty">{{ t("settings.modelRegistry.noReferences") }}</p>
                  </PopoverContent>
                </Popover>
                <span class="model-summary-item"><KeyRound :size="14" aria-hidden="true" />{{ t("settings.modelRegistry.credential", { value: model.keyPreview || (model.keySet ? t("settings.modelRegistry.set") : t("settings.modelRegistry.missing")) }) }}</span>
              </div>
              <div class="model-row-actions">
                <Button variant="outline" size="sm" :disabled="savingModelId === model.id" @click="openEditDialog(model)"><Settings :size="14" /><span>{{ t("settings.modelRegistry.configure") }}</span></Button>
                <DropdownMenu>
                  <DropdownMenuTrigger as-child><Button variant="ghost" size="icon" :aria-label="t('settings.modelRegistry.moreActions')" :disabled="savingModelId === model.id || deletingModelId === model.id"><MoreHorizontal :size="16" /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" :side-offset="6">
                    <DropdownMenuItem v-if="model.locations?.some((location) => location.type === 'control-plane')" @select="openCopyDialog(model)"><Copy :size="14" /><span>{{ t("settings.modelRegistry.copy") }}</span></DropdownMenuItem>
                    <DropdownMenuSeparator v-if="model.locations?.some((location) => location.type === 'control-plane')" />
                    <DropdownMenuItem v-if="model.locations?.some((location) => location.type === 'control-plane')" :disabled="!canMoveModel(model.id, -1)" @select="moveModel(model.id, -1)"><ChevronUp :size="14" /><span>{{ t("settings.modelRegistry.moveUp") }}</span></DropdownMenuItem>
                    <DropdownMenuItem v-if="model.locations?.some((location) => location.type === 'control-plane')" :disabled="!canMoveModel(model.id, 1)" @select="moveModel(model.id, 1)"><ChevronDown :size="14" /><span>{{ t("settings.modelRegistry.moveDown") }}</span></DropdownMenuItem>
                    <DropdownMenuSeparator v-if="model.locations?.some((location) => location.type === 'control-plane')" />
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger><Trash2 :size="14" /><span>{{ t("settings.modelRegistry.deleteFrom") }}</span></DropdownMenuSubTrigger>
                      <DropdownMenuSubContent class="model-delete-location-menu">
                        <DropdownMenuItem v-for="location in model.locations || []" :key="modelLocationKey(location)" :disabled="location.type === 'node' && location.referenceCount > 0" @select="requestDelete(model, location)">
                          <MapPin :size="14" /><span class="model-menu-copy"><strong>{{ modelLocationLabel(location) }}</strong><small v-if="location.type === 'node' && location.referenceCount > 0">{{ t("settings.modelRegistry.inUseBy", { count: location.referenceCount }) }}</small><small v-else>{{ t("settings.modelRegistry.deleteLocation") }}</small></span>
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </article>
        </div>
      </section>
    </div>
  </ScrollArea>

  <Dialog :open="editorOpen" @update:open="handleEditorOpenChange">
    <DialogContent class="model-editor-dialog w-[min(680px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden p-0">
      <DialogHeader class="model-editor-head space-y-0">
        <div>
          <DialogTitle>{{ copyingModelId ? t("settings.modelRegistry.copyTitle") : editingModelId ? t("settings.modelRegistry.edit") : t("settings.modelRegistry.add") }}</DialogTitle>
          <DialogDescription>{{ copyingModelId ? t("settings.modelRegistry.copyDescription") : editingModelId ? t("settings.modelRegistry.editDescription", { count: editingModelLocationCount }) : t("settings.modelRegistry.addDescription") }}</DialogDescription>
        </div>
        <Button variant="ghost" size="icon" :aria-label="t('common.actions.close')" @click="requestCloseEditor"><X :size="16" /></Button>
      </DialogHeader>
      <ScrollArea class="model-editor-scroll" :horizontal="false">
        <form class="model-editor-form" @submit.prevent="submitModel">
          <div v-if="editingModelId" class="model-scope-notice"><Layers :size="16" aria-hidden="true" /><div><strong>{{ t("settings.modelRegistry.allLocations", { count: editingModelLocationCount }) }}</strong><span>{{ t("settings.modelRegistry.editScopeWarning") }}</span></div></div>
          <div v-else-if="copyingModelId" class="model-scope-notice"><Copy :size="16" aria-hidden="true" /><div><strong>{{ t("settings.modelRegistry.controlPlane") }}</strong><span>{{ t("settings.modelRegistry.copyIdentityHint") }}</span></div></div>

          <section class="model-form-section">
            <header><h3>{{ t("settings.modelRegistry.basicInformation") }}</h3><p>{{ t("settings.modelRegistry.basicInformationDescription") }}</p></header>
            <label v-if="!editingModelId && !copyingModelId"><span>{{ t("settings.fields.location") }}</span><ControlPlaneSelect v-model="settingsModel.locationScope" :placeholder="t('settings.modelRegistry.selectLocation')"><ControlPlaneSelectItem value="control-plane">{{ t("settings.modelRegistry.controlPlane") }}</ControlPlaneSelectItem><ControlPlaneSelectItem v-for="node in nodes.data.value || []" :key="node.id" :value="node.id">{{ t("settings.modelRegistry.nodeLocation", { name: node.name }) }}</ControlPlaneSelectItem></ControlPlaneSelect></label>
            <label><span>{{ t("settings.fields.name") }}</span><ControlPlaneInput v-model="settingsModel.name" :placeholder="t('settings.modelRegistry.namePlaceholder')" /></label>
            <label class="model-enabled-toggle"><Checkbox :model-value="settingsModel.enabled" @update:model-value="(value) => settingsModel.enabled = value === true" /><span><strong>{{ t("common.status.enabled") }}</strong><small>{{ t("settings.modelRegistry.enabledDescription") }}</small></span></label>
          </section>

          <section class="model-form-section">
            <header><h3>{{ t("settings.modelRegistry.connection") }}</h3><p>{{ t("settings.modelRegistry.connectionDescription") }}</p></header>
            <label>
              <span>{{ t("settings.fields.endpoint") }}</span>
              <!-- i18n-audit-allow-next-line code-token: example model API endpoint -->
              <ControlPlaneInput v-model="settingsModel.endpoint" placeholder="https://api.openai.com/v1" />
            </label>
            <div class="model-protocol-field" role="group" aria-labelledby="model-protocol-label">
              <span id="model-protocol-label" class="model-protocol-label">{{ t("settings.modelRegistry.protocols") }}</span>
              <ToggleGroup class="model-protocol-options" type="multiple" :model-value="settingsModel.protocols" :aria-label="t('settings.modelRegistry.protocols')" @update:model-value="setProtocols">
                <ToggleGroupItem v-for="protocol in modelProtocols" :key="protocol" class="model-protocol-option" :value="protocol" variant="outline" :title="t(`settings.modelRegistry.protocol.${protocol}`)">
                  <span class="model-protocol-copy">
                    <Check v-if="settingsModel.protocols.includes(protocol)" :size="12" class="model-protocol-check" aria-hidden="true" />
                    <strong>{{ t(`settings.modelRegistry.protocol.${protocol}`) }}</strong>
                    <small>{{ t(`settings.modelRegistry.protocolDescription.${protocol}`) }}</small>
                  </span>
                </ToggleGroupItem>
              </ToggleGroup>
              <small>{{ t("settings.modelRegistry.protocolsDescription") }}</small>
            </div>
            <label><span>{{ t("settings.fields.apiKey") }}</span><ControlPlaneInput v-model="settingsModel.key" type="password" :placeholder="editingModelId || copyingModelId ? t('settings.modelRegistry.keepKey') : t('settings.fields.apiKey')" /><small v-if="editingModelId">{{ t("settings.modelRegistry.keepCredential") }}</small><small v-else-if="copyingModelId">{{ t("settings.modelRegistry.copyCredential") }}</small></label>
          </section>

          <section class="model-form-section">
            <header><h3>{{ t("settings.modelRegistry.model") }}</h3><p>{{ t("settings.modelRegistry.manualModelHint") }}</p></header>
            <div class="model-name-list"><div class="model-name-list-head"><span>{{ t("settings.modelRegistry.modelNames") }}</span><div><Popover v-model:open="modelPickerOpen" @update:open="handleModelPickerOpen"><PopoverTrigger as-child><Button type="button" variant="ghost" size="sm" :disabled="!canDiscoverModels" :aria-label="t('settings.modelRegistry.chooseDiscovered')"><RefreshCw :size="13" :class="{ spin: discoveringModels }" />{{ discoveringModels ? t("settings.modelRegistry.discovering") : t("settings.modelRegistry.chooseDiscovered") }}</Button></PopoverTrigger><PopoverContent class="model-picker-popover w-[min(360px,var(--reka-popover-content-available-width))] overflow-hidden p-1" align="end" :collision-padding="12" :side-offset="6"><Command class="model-picker-command" @update:model-value="selectDiscoveredModel"><CommandInput class="model-picker-search-input h-8 py-0 text-[13px]" :placeholder="t('settings.modelRegistry.searchModels')" /><ScrollArea class="model-picker-scroll" :horizontal="false"><CommandList class="model-picker-list max-h-none overflow-visible"><CommandEmpty>{{ discoveringModels ? t("settings.modelRegistry.discovering") : t("settings.modelRegistry.noModelMatches") }}</CommandEmpty><CommandGroup><CommandItem v-for="option in discoveredModels" :key="option.id" :value="option.id"><span>{{ option.id }}</span><small v-if="option.ownedBy">{{ option.ownedBy }}</small><Check :size="14" :class="{ 'model-option-unselected': !settingsModel.modelNames.some((entry) => entry.name === option.id) }" /></CommandItem></CommandGroup></CommandList></ScrollArea></Command></PopoverContent></Popover><Button type="button" size="sm" variant="ghost" @click="addModelName">{{ t("settings.modelRegistry.addModelName") }}</Button></div></div><div v-for="(entry, index) in settingsModel.modelNames" :key="index" class="model-name-row"><ControlPlaneInput v-model="entry.name" :placeholder="t('settings.modelRegistry.modelNamePlaceholder')" @update:model-value="(value) => index === 0 && (settingsModel.model = value)" /><Button type="button" variant="ghost" size="icon" :disabled="index === 0" @click="moveModelName(index, -1)"><ChevronUp :size="14" /></Button><Button type="button" variant="ghost" size="icon" :disabled="index === settingsModel.modelNames.length - 1" @click="moveModelName(index, 1)"><ChevronDown :size="14" /></Button><Button type="button" variant="ghost" size="icon" :disabled="settingsModel.modelNames.length === 1" @click="removeModelName(index)"><Trash2 :size="14" /></Button></div></div>
            <small v-if="!selectedNodeSupportsModelEndpointProbe" class="model-form-note">{{ t("settings.modelRegistry.probeUnsupported") }}</small>
          </section>
        </form>
      </ScrollArea>
      <DialogFooter class="model-editor-footer">
        <Button variant="outline" @click="requestCloseEditor">{{ t("common.actions.cancel") }}</Button>
        <Button variant="outline" :disabled="!canTestModel || testingModel" @click="checkModel"><Activity :size="14" /><span>{{ testingModel ? t("settings.modelRegistry.testing") : t("settings.modelRegistry.test") }}</span></Button>
        <Button :disabled="!canSaveModel || savingModelId === formModelBusyId" @click="submitModel"><span>{{ savingModelId === formModelBusyId ? t("settings.modelRegistry.saving") : copyingModelId ? t("settings.modelRegistry.createCopy") : editingModelId ? t("settings.modelRegistry.save") : t("settings.modelRegistry.create") }}</span></Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <AlertDialog :open="Boolean(pendingDelete)" @update:open="(open) => !open && (pendingDelete = undefined)">
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{{ t("settings.modelRegistry.deleteTitle") }}</AlertDialogTitle><AlertDialogDescription>{{ t("settings.modelRegistry.deleteConfirm", { name: pendingDelete?.model.name || '', location: pendingDelete ? modelLocationLabel(pendingDelete.location) : '' }) }}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel :disabled="Boolean(deletingModelId)">{{ t("common.actions.cancel") }}</AlertDialogCancel><Button variant="destructive" size="sm" :disabled="Boolean(deletingModelId)" @click="confirmDelete">{{ deletingModelId ? t("settings.modelRegistry.deleting") : t("common.actions.delete") }}</Button></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>

  <AlertDialog :open="closeConfirmationOpen" @update:open="closeConfirmationOpen = $event">
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>{{ t("settings.modelRegistry.discardTitle") }}</AlertDialogTitle><AlertDialogDescription>{{ t("settings.modelRegistry.discardDescription") }}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel>{{ t("common.actions.cancel") }}</AlertDialogCancel><AlertDialogAction @click="discardAndClose">{{ t("settings.modelRegistry.discard") }}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, AlertTriangle, Boxes, Check, ChevronDown, ChevronUp, ChevronsUpDown, Copy, KeyRound, Layers, Link2, MapPin, MoreHorizontal, Plus, RefreshCw, Search, Settings, Trash2, X } from "@lucide/vue";
import type { ModelApp, ModelConfig, ModelLocation } from "../../../api/types";
import { useModelRegistryQuery, useModelsQuery, useNodesQuery } from "../../../api/queries";
import { invalidateControlPlaneDomains } from "../../../api/queryInvalidation";
import { useQueryClient } from "@tanstack/vue-query";
import { translateApiError } from "../../../i18n/apiError";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../../../components/ui/command";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { useModelSettings } from "./useModelSettings";
import { modelSupportsApp } from "../instance-settings/instanceSettingsState";

type FilterValue = "all" | string;
const { t } = useI18n();
const queryClient = useQueryClient();
const models = useModelsQuery();
const modelRegistry = useModelRegistryQuery();
const nodes = useNodesQuery();
const searchQuery = ref("");
const appFilter = ref<FilterValue>("all");
const locationFilter = ref<FilterValue>("all");
const statusFilter = ref<"all" | "enabled" | "disabled">("all");
const editorOpen = ref(false);
const closeConfirmationOpen = ref(false);
const modelPickerOpen = ref(false);
const pendingDelete = ref<{ model: ModelConfig; location: ModelLocation }>();
const refreshModels = () => invalidateControlPlaneDomains(queryClient, ["models"]);
const translateError = (error: unknown) => translateApiError(error, t, error instanceof Error ? error.message : String(error));
const { addModelName, canDiscoverModels, canMoveModel, canSaveModel, canTestModel, checkModel, copyingModelId, copyModelDraft, deletingModelId, discoveredModels, discoveringModels, editModel, editingModelId, formModelBusyId, modelDraftDirty, moveModel, moveModelName, removeModel, removeModelName, resetModelForm, saveModel, savingModelId, selectedNodeSupportsModelEndpointProbe, setProtocols, settingsModel, testingModel, fetchModelOptions } = useModelSettings({ errorText: translateError, models: () => models.data.value || [], nodes: () => nodes.data.value || [], onModelDeleted() {}, refreshModels, translate: t });
const modelProtocols = ["openai-responses", "openai-chat-completions", "anthropic-messages"] as const;
const editingModelLocationCount = computed(() => (models.data.value || []).find((model) => model.id === editingModelId.value)?.locations?.length || 1);
const hasActiveFilters = computed(() => Boolean(searchQuery.value.trim() || appFilter.value !== "all" || locationFilter.value !== "all" || statusFilter.value !== "all"));
const filteredModels = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase();
  return (models.data.value || []).filter((model) => {
    if (query && ![model.name, model.model, model.endpoint].some((value) => value.toLocaleLowerCase().includes(query))) return false;
    if (appFilter.value !== "all" && !modelSupportsApp(model, appFilter.value as ModelApp)) return false;
    if (statusFilter.value !== "all" && model.enabled !== (statusFilter.value === "enabled")) return false;
    if (locationFilter.value !== "all" && !model.locations?.some((location) => locationFilter.value === "control-plane" ? location.type === "control-plane" : location.type === "node" && location.nodeId === locationFilter.value)) return false;
    return true;
  });
});
function clearFilters() { searchQuery.value = ""; appFilter.value = "all"; locationFilter.value = "all"; statusFilter.value = "all"; }
function nodeName(nodeId: string) { return (nodes.data.value || []).find((node) => node.id === nodeId)?.name || nodeId; }
function modelLocationKey(location: ModelLocation) { return location.type === "control-plane" ? "control-plane" : `node:${location.nodeId}`; }
function modelLocationLabel(location: ModelLocation) { return location.type === "control-plane" ? t("settings.modelRegistry.controlPlane") : nodeName(location.nodeId); }
function appLabel(app: string) { return app === "opencode" ? "OpenCode" : app === "claude" ? "Claude" : "Codex"; }
function compatibleAppLabel(model: ModelConfig) { return (["codex", "claude", "opencode"] as ModelApp[]).filter((app) => modelSupportsApp(model, app)).map(appLabel).join(" · "); }
function referenceLocations(model: ModelConfig) { return (model.locations || []).filter((location): location is Extract<ModelLocation, { type: "node" }> => location.type === "node" && location.referenceCount > 0); }
function openCreateDialog() { resetModelForm(); editorOpen.value = true; }
function openEditDialog(model: ModelConfig) { editModel(model); editorOpen.value = true; }
function openCopyDialog(model: ModelConfig) { copyModelDraft(model); editorOpen.value = true; }
function requestCloseEditor() { if (modelDraftDirty.value) closeConfirmationOpen.value = true; else closeEditor(); }
function handleEditorOpenChange(open: boolean) { if (open) editorOpen.value = true; else requestCloseEditor(); }
function closeEditor() { editorOpen.value = false; closeConfirmationOpen.value = false; modelPickerOpen.value = false; resetModelForm(); }
function discardAndClose() { closeEditor(); }
async function submitModel() { if (await saveModel()) closeEditor(); }
function handleModelPickerOpen(open: boolean) { if (open && !discoveredModels.value.length && !discoveringModels.value) void fetchModelOptions(); }
function selectDiscoveredModel(value: unknown) {
  if (typeof value !== "string") return;
  const selectedIndex = settingsModel.modelNames.findIndex((entry) => entry.name === value);
  if (selectedIndex >= 0) {
    if (settingsModel.modelNames.length > 1) removeModelName(selectedIndex);
    else settingsModel.modelNames[0].name = "";
  } else {
    const empty = settingsModel.modelNames.find((entry) => !entry.name.trim());
    if (empty) empty.name = value;
    else settingsModel.modelNames.push({ name: value, order: (settingsModel.modelNames.length + 1) * 100 });
  }
  settingsModel.model = settingsModel.modelNames[0]?.name || "";
}
function requestDelete(model: ModelConfig, location: ModelLocation) { pendingDelete.value = { model, location }; }
async function confirmDelete() { const target = pendingDelete.value; if (!target) return; if (await removeModel(target.model, target.location)) pendingDelete.value = undefined; }
</script>

<style scoped>
.model-settings-scroll { height: 100%; min-height: 0; width: 100%; }
.model-settings-page { display: grid; gap: 12px; margin: 0 auto; padding: 0 10px 20px 0; width: min(100%, var(--settings-content-max-width, 1080px)); }
.model-page-head { align-items: flex-start; display: flex; gap: 16px; justify-content: space-between; }
.model-page-head p, .model-form-section h3, .model-form-section p { margin: 0; }
.model-page-head p { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.model-toolbar { display: grid; gap: 8px; grid-template-columns: minmax(240px,1fr) 150px 180px 150px; }
.model-search { align-items: center; display: flex; min-width: 0; position: relative; }
.model-search > svg { color: var(--text-muted); left: 10px; pointer-events: none; position: absolute; z-index: 1; }
.model-search :deep(input) { padding-left: 32px; }
.model-diagnostics { background: var(--status-danger-bg); border: 1px solid color-mix(in srgb,var(--status-danger) 32%,var(--line)); border-radius: 8px; display: grid; overflow: hidden; }
.model-diagnostics-head { align-items: center; display: grid; gap: 9px; grid-template-columns: auto minmax(0,1fr) auto; padding: 9px 11px; }
.model-diagnostics-head > svg { color: var(--status-danger); }
.model-diagnostics-head > div { display: grid; gap: 2px; }
.model-diagnostics-head strong { color: var(--text-strong); font-size: 12px; }
.model-diagnostics-head span { color: var(--text-muted); font-size: 12px; }
.model-diagnostic-list { border-top: 1px solid color-mix(in srgb,var(--status-danger) 24%,transparent); display: grid; padding: 0 11px 8px; }
.model-diagnostic-row { display: grid; font-size: 12px; gap: 8px; grid-template-columns: minmax(120px,.3fr) minmax(0,1fr) auto; padding-top: 8px; }
.model-diagnostic-row span, .model-diagnostic-row code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-diagnostic-row code { color: var(--status-danger); }
.model-directory { background: var(--surface-raised); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.model-directory-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; gap: 8px; min-height: 38px; padding: 0 12px; }
.model-directory-head strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.model-directory-head span { color: var(--text-muted); font-size: 12px; }
.model-list { display: grid; }
.model-row + .model-row { border-top: 1px solid var(--line); }
.model-row-main { align-items: center; display: grid; gap: 16px; grid-template-columns: minmax(220px,1.35fr) minmax(300px,1fr) auto; min-height: 92px; padding: 12px; }
.model-identity { display: grid; gap: 3px; min-width: 0; }
.model-title-line { align-items: center; display: flex; gap: 6px; min-width: 0; }
.model-title-line > strong { color: var(--text-strong); font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-identity code, .model-endpoint { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-summary { align-content: center; display: grid; gap: 5px; min-width: 0; }
.model-summary-item { align-items: center; color: var(--text-muted); display: flex; font-size: 12px; gap: 6px; min-width: 0; }
.model-summary-item svg { flex: 0 0 auto; }
.model-summary-trigger { background: transparent; border: 0; cursor: pointer; padding: 0; text-align: left; width: fit-content; }
.model-summary-trigger:hover, .model-summary-trigger[data-state="open"] { color: var(--text-strong); }
.model-summary-trigger > svg:last-child { transition: transform 140ms ease; }
.model-summary-trigger[data-state="open"] > svg:last-child { transform: rotate(180deg); }
.model-row-actions { align-items: center; display: flex; gap: 4px; justify-content: flex-end; }
:global(.model-summary-popover) { display: grid; gap: 0; max-height: var(--reka-popover-content-available-height); overflow: hidden; padding: 0; width: min(272px,var(--reka-popover-content-available-width)); }
.model-summary-popover-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; gap: 8px; justify-content: space-between; padding: 7px 9px; }
.model-summary-popover-head strong { color: var(--text-strong); font-size: 12px; font-weight: 500; }
.model-summary-popover-head span { color: var(--text-muted); font-size: 12px; }
.model-summary-popover-scroll { max-height: min(240px,calc(var(--reka-popover-content-available-height) - 34px)); min-height: 0; }
.model-summary-popover-list { display: grid; padding: 2px; }
.model-summary-popover-row { align-items: flex-start; border-radius: 5px; display: grid; gap: 7px; grid-template-columns: auto minmax(0,1fr); padding: 5px 7px; }
.model-summary-popover-row:hover { background: var(--surface-hover); }
.model-summary-popover-row > svg { color: var(--text-muted); margin-top: 2px; }
.model-summary-popover-row > span { display: grid; gap: 2px; min-width: 0; }
.model-summary-popover-row strong, .model-summary-popover-row small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-summary-popover-row strong { color: var(--text-strong); font-size: 12px; font-weight: 500; }
.model-summary-popover-row small { color: var(--text-muted); font-size: 12px; }
.model-summary-popover-empty { color: var(--text-muted); font-size: 12px; margin: 0; padding: 10px 9px; }
.model-state { align-items: center; color: var(--text-muted); display: flex; font-size: 12px; justify-content: center; min-height: 160px; padding: 20px; }
.model-state-error { gap: 10px; }
.model-empty-state { align-content: center; display: grid; gap: 7px; justify-items: center; text-align: center; }
.model-empty-state strong { color: var(--text-strong); font-size: 13px; }
.model-empty-state p { margin: 0; }
:global(.model-delete-location-menu) { min-width: 260px; }
.model-menu-copy { display: grid; gap: 2px; min-width: 0; }
.model-menu-copy strong { font-size: 12px; font-weight: 500; }
.model-menu-copy small { color: var(--text-muted); font-size: 12px; }
:global(.model-editor-dialog) { display: grid; grid-template-rows: auto minmax(0,1fr) auto; height: min(700px,calc(100vh - 40px)); }
.model-editor-head { align-items: center; border-bottom: 1px solid var(--line); display: flex; flex-direction: row; justify-content: space-between; padding: 13px 16px; }
.model-editor-head > div { display: grid; gap: 4px; }
.model-editor-scroll { min-height: 0; }
.model-editor-form { display: grid; gap: 16px; padding: 14px 16px 18px; }
.model-scope-notice { align-items: flex-start; background: var(--surface-active); border: 1px solid var(--line); border-radius: 8px; display: flex; gap: 9px; padding: 10px; }
.model-scope-notice > div { display: grid; gap: 2px; }
.model-scope-notice strong { color: var(--text-strong); font-size: 12px; }
.model-scope-notice span { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.model-form-section { display: grid; gap: 10px; }
.model-form-section + .model-form-section { border-top: 1px solid var(--line); padding-top: 16px; }
.model-form-section > header { display: grid; gap: 2px; }
.model-form-section h3 { color: var(--text-strong); font-size: 13px; font-weight: 600; }
.model-form-section header p { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.model-form-section label { display: grid; gap: 5px; }
.model-form-section label > span, .model-field-head > span { color: var(--text-muted); font-size: 12px; }
.model-form-section label > small, .model-form-note { color: var(--text-muted); font-size: 12px; line-height: 1.45; }
.model-protocol-field { display: grid; gap: 7px; }
.model-protocol-label { color: var(--text-muted); font-size: 12px; }
.model-protocol-options { display: grid; gap: 8px; grid-template-columns: repeat(3,minmax(0,1fr)); justify-content: stretch; }
.model-protocol-options :deep(.model-protocol-option) { background: transparent; border-color: var(--line-strong); border-radius: 6px; color: var(--text-muted); justify-content: center; min-height: 58px; min-width: 0; padding: 5px 8px; }
.model-protocol-options :deep(.model-protocol-option:hover), .model-protocol-options :deep(.model-protocol-option:focus-visible) { background: var(--surface-hover); border-color: var(--brand-accent); color: var(--text-strong); }
.model-protocol-options :deep(.model-protocol-option[data-state="on"]) { background: var(--surface-active); border-color: var(--brand-accent); color: var(--text-strong); }
.model-protocol-copy { align-content: center; display: grid; gap: 3px; height: 100%; min-width: 0; position: relative; text-align: center; width: 100%; }
.model-protocol-copy strong { font-size: 13px; font-weight: 500; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-protocol-copy small { color: var(--text-muted); font-family: var(--font-mono); font-size: 12px; font-weight: 400; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-protocol-check { position: absolute; right: 0; top: 0; }
.model-protocol-field > small { color: var(--text-muted); font-size: 12px; line-height: 1.45; margin-top: 1px; }
.model-enabled-toggle { align-items: flex-start; display: flex !important; gap: 9px !important; }
.model-enabled-toggle > span { display: grid; gap: 2px; }
.model-enabled-toggle strong { color: var(--text-strong); font-size: 12px; font-weight: 500; }
.model-field-head, .model-input-row { align-items: center; display: flex; gap: 7px; justify-content: space-between; }
.model-input-row > :first-child { flex: 1 1 auto; min-width: 0; }
.model-name-list { display: grid; gap: 7px; }
.model-name-list-head { align-items: center; display: flex; justify-content: space-between; }
.model-name-list-head > div { align-items: center; display: flex; gap: 4px; }
.model-name-list-head > span { color: var(--text-muted); font-size: 12px; }
.model-name-row { align-items: center; display: grid; gap: 4px; grid-template-columns: minmax(0,1fr) repeat(3, auto); }
.model-editor-footer { border-top: 1px solid var(--line); display: flex; gap: 8px; justify-content: flex-end; padding: 8px 16px; }
:global(.model-picker-popover) { height: min(360px,var(--reka-popover-content-available-height)); overflow: hidden; padding: 4px; width: min(360px,var(--reka-popover-content-available-width)); }
.model-picker-command { display: grid; grid-template-rows: auto minmax(0,1fr); height: 100%; }
.model-picker-scroll { min-height: 0; }
.model-picker-scroll :deep([data-task-handoff-scroll-viewport]) { padding-right: 8px; }
.model-picker-command :deep([cmdk-input-wrapper]) { background: var(--surface-inset); border: 1px solid var(--line-subtle); border-radius: 6px; gap: 7px; height: 34px; margin: 0 0 4px; padding: 0 9px; }
.model-picker-command :deep([cmdk-input-wrapper]:focus-within) { border-color: var(--focus-ring); }
.model-picker-command :deep([cmdk-input-wrapper] > svg) { height: 14px; margin-right: 0; width: 14px; }
.model-picker-command :deep([role="group"]) { display: grid; gap: 2px; padding: 0; }
.model-picker-command :deep([role="option"]) { border-radius: 5px; cursor: pointer; font-size: 13px; gap: 7px; min-height: 32px; padding: 5px 8px; }
.model-picker-command :deep([role="option"]:hover), .model-picker-command :deep([role="option"][data-highlighted]) { background: var(--surface-active); color: var(--text-strong); }
.model-picker-command :deep([role="option"][data-state="checked"]) { background: var(--surface-active); color: var(--status-success); }
.model-picker-command :deep([role="option"] > span:first-child) { font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-picker-command :deep([role="option"] small) { color: var(--text-muted); font-size: 12px; font-weight: 400; margin-left: auto; }
.model-picker-command :deep([role="option"] svg) { margin-left: 8px; }
.model-option-unselected { opacity: 0; }
.spin { animation: model-spin .8s linear infinite; }
@keyframes model-spin { to { transform: rotate(360deg); } }
@media(max-width:900px) { .model-toolbar { grid-template-columns: minmax(220px,1fr) repeat(3,minmax(130px,.35fr)); } .model-row-main { grid-template-columns: minmax(210px,1fr) minmax(220px,.8fr) auto; } }
@media(max-width:720px) { .model-settings-page { padding-right: 7px; } .model-toolbar { grid-template-columns: 1fr 1fr; } .model-search { grid-column: 1/-1; } .model-row-main { align-items: start; grid-template-columns: 1fr auto; gap: 10px; } .model-summary { grid-column: 1/-1; } .model-diagnostic-row { grid-template-columns: 1fr; } .model-protocol-options { grid-template-columns: 1fr; } }
</style>
