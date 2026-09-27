<template>
  <Dialog :open="open" @update:open="setOpen">
    <DialogContent class="agent-editor-dialog">
      <DialogHeader class="agent-editor-header">
        <div>
          <DialogTitle class="agent-editor-title">{{ heading }}</DialogTitle>
          <DialogDescription class="agent-editor-description">{{ t("agents.editor.description") }}</DialogDescription>
        </div>
        <DialogClose as-child>
          <button type="button" class="agent-editor-close" :aria-label="t('common.actions.close')"><X :size="16" /></button>
        </DialogClose>
      </DialogHeader>

      <ScrollArea class="agent-editor-body" :horizontal="false">
        <div class="agent-editor-fields">
          <section class="agent-editor-section">
            <h3>{{ t("agents.editor.basics") }}</h3>
            <div class="agent-editor-grid">
              <label class="agent-editor-field">
                <span>{{ t("agents.editor.name") }}</span>
                <Input v-model="draft.name" :placeholder="t('agents.editor.namePlaceholder')" />
              </label>
            </div>
            <label class="agent-editor-field">
              <span>{{ t("agents.editor.summary") }}</span>
              <Textarea v-model="draft.description" class="agent-editor-textarea" :placeholder="t('agents.editor.summaryPlaceholder')" />
            </label>
          </section>

          <section class="agent-editor-section">
            <h3>{{ t("agents.editor.target") }}</h3>
            <label class="agent-editor-field">
              <span>{{ t("agents.editor.instance") }}</span>
              <ControlPlaneSelect :model-value="draft.targetInstanceId" :placeholder="t('agents.editor.instancePlaceholder')" @update:model-value="selectInstance">
                <ControlPlaneSelectItem v-if="missingInstanceLabel" :value="draft.targetInstanceId" disabled>{{ missingInstanceLabel }}</ControlPlaneSelectItem>
                <ControlPlaneSelectItem v-for="candidate in candidateInstances" :key="candidate.id" :value="candidate.id" :disabled="candidate.runtime?.type === 'local'">
                  {{ instanceLabel(candidate) }}
                </ControlPlaneSelectItem>
              </ControlPlaneSelect>
            </label>
            <label class="agent-editor-field">
              <span>{{ t("agents.editor.folder") }}</span>
              <ControlPlaneSelect
                :model-value="folderSelectionValue"
                :disabled="!selectedInstance"
                :placeholder="t('agents.editor.folderPlaceholder')"
                @update:model-value="selectFolder"
              >
                <ControlPlaneSelectItem v-if="storedFolderUnavailable" :value="storedFolderValue" disabled>{{ draft.cwdFolderPath }}</ControlPlaneSelectItem>
                <ControlPlaneSelectItem v-if="instanceWorkspacePath" :value="workspaceFolderValue">
                  {{ t("agents.editor.instanceWorkspace") }} · {{ instanceWorkspacePath }}
                </ControlPlaneSelectItem>
                <ControlPlaneSelectItem v-for="folder in folderCandidates" :key="folder.id" :value="folder.id">
                  {{ nodeLocalFolderDisplayName(folder) }} · {{ folder.path }}
                </ControlPlaneSelectItem>
                <ControlPlaneSelectItem v-if="canRegisterFolder" :value="chooseFolderValue">{{ t("agents.editor.chooseFolder") }}</ControlPlaneSelectItem>
              </ControlPlaneSelect>
              <small v-if="!selectedInstance" class="agent-editor-hint">{{ t("agents.editor.folderNeedsInstance") }}</small>
              <small v-else class="agent-editor-hint">{{ t("agents.editor.folderHint") }}</small>
              <code class="agent-editor-folder-path">{{ draft.cwdFolderPath || t("agents.editor.folderUnset") }}</code>
            </label>
            <div v-if="folderBrowserOpen" class="agent-editor-folder">
              <p class="agent-editor-hint">{{ t("agents.editor.folderBrowseHint", { node: nodeLabel }) }}</p>
              <NodeFolderTree
                :key="nodeId"
                :error="browser.error.value"
                :loading="browser.loading.value"
                :rows="browser.rows.value"
                :selected-path="browser.selectedPath.value"
                @refresh="browser.refresh"
                @select="browser.selectFolder"
              />
              <div class="agent-editor-actions">
                <Button type="button" variant="outline" size="sm" :disabled="!browser.selectedPath.value || registeringFolder" @click="useBrowsedFolder">
                  <FolderCheck :size="14" />
                  <span>{{ registeringFolder ? t("agents.editor.folderRegistering") : t("agents.editor.folderUse") }}</span>
                </Button>
              </div>
              <p v-if="folderError" class="agent-editor-blocked" role="alert">{{ folderError }}</p>
            </div>
          </section>

          <section class="agent-editor-section">
            <h3>{{ t("agents.editor.runtime") }}</h3>
            <div class="agent-editor-grid">
              <label class="agent-editor-field">
                <span>{{ t("agents.editor.provider") }}</span>
                <ControlPlaneSelect :model-value="draft.providerId" :disabled="!providers.length" :placeholder="t('agents.editor.providerPlaceholder')" @update:model-value="selectProvider">
                  <ControlPlaneSelectItem v-if="storedProviderUnavailable" :value="draft.providerId" disabled>{{ storedProviderLabel }}</ControlPlaneSelectItem>
                  <ControlPlaneSelectItem v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.label }}</ControlPlaneSelectItem>
                </ControlPlaneSelect>
                <small v-if="selectedInstance && !providers.length" class="agent-editor-hint">{{ t("agents.editor.providerUnavailable") }}</small>
              </label>
              <label class="agent-editor-field">
                <span>{{ t("agents.editor.model") }}</span>
                <ControlPlaneSelect :model-value="modelSelectionValue" :disabled="!modelOptions.length" :placeholder="t('agents.editor.model')" @update:model-value="selectModel">
                  <ControlPlaneSelectItem v-if="modelSelectionValue === storedModelValue" :value="storedModelValue" disabled>{{ draft.modelName }}</ControlPlaneSelectItem>
                  <ControlPlaneSelectItem v-for="(option, index) in modelOptions" :key="`${option.modelEntityId}:${option.modelName}`" :value="String(index)">
                    {{ option.modelName }}
                  </ControlPlaneSelectItem>
                </ControlPlaneSelect>
                <small v-if="storedModelUnavailable" class="agent-editor-hint">{{ t("agents.editor.modelUnavailable") }}</small>
              </label>
              <label class="agent-editor-field">
                <span>{{ t("agents.editor.reasoning") }}</span>
                <ControlPlaneSelect :model-value="draft.reasoningEffort" :disabled="!reasoningEffortEnabled" :placeholder="t('agents.editor.reasoning')" @update:model-value="selectReasoningEffort">
                  <ControlPlaneSelectItem v-for="effort in availableReasoningEfforts" :key="effort" :value="effort">{{ effort }}</ControlPlaneSelectItem>
                </ControlPlaneSelect>
                <small v-if="!reasoningEffortEnabled" class="agent-editor-hint">{{ t("agents.editor.reasoningDisabled") }}</small>
              </label>
              <label class="agent-editor-field">
                <span>{{ t("agents.editor.permission") }}</span>
                <ControlPlaneSelect :model-value="draft.permissionMode" :disabled="!permissionOptions.length" :placeholder="t('agents.editor.permission')" @update:model-value="selectPermissionMode">
                  <ControlPlaneSelectItem v-if="permissionSelectionUnavailable" :value="draft.permissionMode" disabled>{{ draft.permissionMode }}</ControlPlaneSelectItem>
                  <ControlPlaneSelectItem v-for="mode in permissionOptions" :key="mode" :value="mode">{{ t(`sessions.permission.${permissionLabelKey(mode)}`) }}</ControlPlaneSelectItem>
                </ControlPlaneSelect>
              </label>
            </div>
          </section>

          <section class="agent-editor-section">
            <h3>{{ t("agents.editor.appendedPrompt") }}</h3>
            <Textarea v-model="draft.appendedPrompt" class="agent-editor-textarea" :placeholder="t('agents.editor.appendedPromptPlaceholder')" />
            <small class="agent-editor-hint">{{ t("agents.value.appendedPromptNote") }}</small>
          </section>

          <section class="agent-editor-section">
            <h3>{{ t("agents.editor.callable") }}</h3>
            <p class="agent-editor-hint">{{ t("agents.editor.callableHint") }}</p>
            <div v-if="callableCandidates.length" class="agent-editor-callable">
              <label v-for="candidate in callableCandidates" :key="candidate.id" class="agent-editor-callable-item">
                <Checkbox :model-value="draft.callableAgentIds.includes(candidate.id)" @update:model-value="toggleCallable(candidate.id, $event === true)" />
                <span>
                  <strong>{{ candidate.name }}</strong>
                  <small>{{ candidate.instanceLabel }}</small>
                </span>
              </label>
            </div>
            <p v-else class="agent-editor-hint">{{ t("agents.editor.callableEmpty") }}</p>
          </section>

          <section class="agent-editor-section">
            <h3>{{ t("agents.editor.execution") }}</h3>
            <dl class="agent-editor-field-list">
              <div><dt>{{ t("agents.field.workspace") }}</dt><dd>{{ t("agents.value.workspaceOverlay") }}</dd></div>
              <div><dt>{{ t("agents.field.executionMode") }}</dt><dd>{{ t("agents.value.sandboxInstance") }}</dd></div>
              <div><dt>{{ t("agents.field.isolation") }}</dt><dd>{{ t("agents.value.isolationInstance") }}</dd></div>
            </dl>
            <p class="agent-editor-hint">{{ t("agents.value.overlayNote") }}</p>
            <p class="agent-editor-hint">{{ t("agents.value.isolationNote") }}</p>
          </section>
        </div>
      </ScrollArea>

      <DialogFooter class="agent-editor-footer">
        <p v-if="saveError || blockedReason" class="agent-editor-blocked" role="alert">{{ saveError || blockedReason }}</p>
        <div class="agent-editor-actions">
          <Button type="button" variant="outline" @click="setOpen(false)">{{ t("common.actions.cancel") }}</Button>
          <Button type="button" :disabled="!canSubmit || saving" @click="submit">{{ saving ? t("agents.editor.saving") : editing ? t("agents.editor.save") : t("agents.editor.create") }}</Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { FolderCheck, X } from "@lucide/vue";
import { defaultAiSessionModelSelection, deriveAiSessionModelGroups } from "@task-handoff/control-plane-client";
import { AI_SESSION_DEFAULT_REASONING_EFFORT } from "@task-handoff/protocol/ai-sessions";
import type { AiSessionModelSelection, AiSessionPermissionMode, AiSessionReasoningEffort } from "@task-handoff/protocol/ai-sessions";
import { normalizeAiSessionModelSelectionCapabilities, normalizeAiSessionReasoningEffortCapabilities } from "@task-handoff/protocol/ai-session-provider-capabilities";
import { directoryAiSessionProviderCapability } from "@task-handoff/protocol/control-plane-directory";
import { createNodeLocalFolder, listNodeFolderTree, useModelsQuery, useNodeLocalFoldersQuery } from "@/api/queries";
import type { InstanceBoardItem, NodeLocalFolder } from "@/api/types";
import { translateApiError } from "@/i18n/apiError";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import { nodeLocalFolderDisplayName, nodePathName } from "../nodePath";
import { findInstanceCwdFolderByPath, selectableInstanceCwdFolders } from "../shared/instanceCwdFolders";
import NodeFolderTree from "../new-instance/NodeFolderTree.vue";
import { useNodeFolderBrowser } from "../useNodeFolderBrowser";
import { aiSessionLaunchableAppsForInstance } from "../useInstanceSessions";
import { agentDraftFromDefinition, callableAgentCandidates, emptyAgentDraft } from "./agentCatalog";
import type { AgentCatalogAgent, AgentEditorDraft } from "./agentCatalogTypes";

const props = defineProps<{
  agent?: AgentCatalogAgent;
  agents: AgentCatalogAgent[];
  instances: InstanceBoardItem[];
  open: boolean;
  /** 提交实现由视图注入：编辑器只负责草稿、可提交性和结果呈现。 */
  save: (draft: AgentEditorDraft) => Promise<void>;
}>();

const emit = defineEmits<{
  "update:open": [open: boolean];
}>();

const { t } = useI18n();
const modelsQuery = useModelsQuery();
const storedModelValue = "__stored_model__";
const reasoningEfforts: AiSessionReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const draft = ref<AgentEditorDraft>(emptyAgentDraft());
const saving = ref(false);
const saveError = ref("");
const editing = computed(() => Boolean(props.agent));
const heading = computed(() => (props.agent ? t("agents.editor.editTitle", { name: props.agent.name }) : t("agents.editor.createTitle")));

const selectedInstance = computed(() => props.instances.find((instance) => instance.id === draft.value.targetInstanceId));
const nodeId = computed(() => selectedInstance.value?.nodeId || props.agent?.nodeId || "");
const nodeLabel = computed(() => selectedInstance.value?.node?.name || nodeId.value);

// The working folder follows the AI session creation model: pick an existing instance workspace or a
// node-local folder that the instance can actually see, and only register a new node-local folder when
// the instance mounts a local source. The container file system is never browsed directly.
const nodeLocalFolders = useNodeLocalFoldersQuery(nodeId);
const createdFolders = ref<NodeLocalFolder[]>([]);
const folderBrowserOpen = ref(false);
const registeringFolder = ref(false);
const folderError = ref("");
const workspaceFolderValue = "__instance_workspace__";
const chooseFolderValue = "__choose_folder__";
const storedFolderValue = "__stored_folder__";
const folderCandidates = computed(() => {
  const instance = selectedInstance.value;
  if (!instance) return [];
  return selectableInstanceCwdFolders(instance, [...(nodeLocalFolders.data.value || []), ...createdFolders.value]);
});
// 「实例工作区」在协议里就是该实例来源目录本身，只有它已被登记为节点文件夹时才有权威 `cwdFolderId`。
const instanceWorkspaceFolder = computed(() => {
  const instance = selectedInstance.value;
  if (!instance || instance.source.type !== "local-folder") return undefined;
  const sourcePath = instance.source.path;
  return folderCandidates.value.find((folder) => findInstanceCwdFolderByPath([folder], sourcePath));
});
const instanceWorkspacePath = computed(() => instanceWorkspaceFolder.value?.path || "");
const folderUnavailable = computed(() => Boolean(selectedInstance.value) && !folderCandidates.value.length);
const canRegisterFolder = computed(() => selectedInstance.value?.source.type === "local-folder");
const folderSelectionValue = computed(() => {
  if (draft.value.cwdFolderId) return draft.value.cwdFolderId;
  if (draft.value.cwdFolderPath && instanceWorkspacePath.value === draft.value.cwdFolderPath) return workspaceFolderValue;
  return draft.value.cwdFolderPath ? storedFolderValue : "";
});
const storedFolderUnavailable = computed(() => Boolean(draft.value.cwdFolderPath) && !draft.value.cwdFolderId && folderSelectionValue.value === storedFolderValue);

const browser = useNodeFolderBrowser({
  errorText: (cause) => translateApiError(cause, t),
  load: (id, input) => listNodeFolderTree(id, input),
  translate: t,
});
const candidateInstances = computed(() => {
  const scoped = props.agent ? props.instances.filter((instance) => instance.nodeId === props.agent?.nodeId) : props.instances;
  return [...scoped].sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.name.localeCompare(right.name));
});
const missingInstanceLabel = computed(() => (draft.value.targetInstanceId && !selectedInstance.value ? props.agent?.instanceLabel || draft.value.targetInstanceId : ""));
const providers = computed(() => (selectedInstance.value ? aiSessionLaunchableAppsForInstance(selectedInstance.value, t) : []));
const providerCapability = computed(() => (selectedInstance.value ? directoryAiSessionProviderCapability(selectedInstance.value.capabilities?.features, draft.value.providerId) : undefined));
const permissionOptions = computed(() => providerCapability.value?.permissionModes || []);
const reasoningEffortEnabled = computed(() => normalizeAiSessionReasoningEffortCapabilities(providerCapability.value).selectAtCreate);
const availableReasoningEfforts = computed(() => (draft.value.providerId === "codex" ? reasoningEfforts : reasoningEfforts.filter((effort) => effort !== "ultra")));
const modelGroups = computed(() => modelGroupsFor(draft.value.providerId));
const modelOptions = computed(() => modelGroups.value.flatMap((group) => group.models));
const modelSelectionValue = computed(() => {
  const index = modelOptions.value.findIndex(matchesDraftModel);
  return index >= 0 ? String(index) : draft.value.modelName ? storedModelValue : "";
});
const storedModelUnavailable = computed(() => Boolean(draft.value.modelName) && modelOptions.value.length > 0 && !modelOptions.value.some(matchesDraftModel));
const storedProviderUnavailable = computed(() => Boolean(draft.value.providerId) && !providers.value.some((provider) => provider.id === draft.value.providerId));
const storedProviderLabel = computed(() => props.agent?.provider || draft.value.providerId);
const permissionSelectionUnavailable = computed(() => Boolean(draft.value.permissionMode) && !permissionOptions.value.includes(draft.value.permissionMode as AiSessionPermissionMode));

const callableCandidates = computed(() => (nodeId.value ? callableAgentCandidates(props.agents, nodeId.value, draft.value.id) : []));

const blockedReason = computed(() => {
  if (!draft.value.targetInstanceId) return "";
  if (!selectedInstance.value) return t("agents.editor.blockedInstanceMissing");
  if (selectedInstance.value.runtime?.type === "local") return t("agents.editor.blockedLocalRuntime");
  if (selectedInstance.value.connectionStatus === "offline") return t("agents.editor.blockedInstanceOffline");
  if (!providers.value.length) return t("agents.editor.blockedNoProvider");
  if (storedProviderUnavailable.value) return t("agents.editor.blockedProviderUnavailable");
  if (permissionSelectionUnavailable.value) return t("agents.editor.blockedPermissionUnavailable");
  if (storedModelUnavailable.value) return t("agents.editor.blockedModelUnavailable");
  if (storedFolderUnavailable.value) return t("agents.editor.blockedFolderUnavailable");
  if (folderUnavailable.value) return t("agents.editor.folderUnavailable");
  return "";
});
const canSubmit = computed(() => Boolean(
  !blockedReason.value
  && draft.value.name.trim()
  && draft.value.targetInstanceId
  && draft.value.cwdFolderPath
  && draft.value.providerId,
));

watch(() => props.open, (open) => {
  if (open) initialize();
  else browser.reset();
}, { immediate: true });

watch(modelOptions, (options) => {
  if (!options.length) return;
  if (draft.value.modelName && options.some(matchesDraftModel)) return;
  // A saved definition keeps an unsupported model and surfaces the block instead of being replaced.
  if (props.agent) return;
  const fallback = defaultAiSessionModelSelection(modelGroups.value);
  draft.value.modelEntityId = fallback?.modelEntityId || "";
  draft.value.modelName = fallback?.modelName || "";
});

watch(folderCandidates, (folders) => {
  if (draft.value.cwdFolderId || !draft.value.cwdFolderPath) return;
  const match = findInstanceCwdFolderByPath(folders, draft.value.cwdFolderPath);
  if (match) draft.value.cwdFolderId = match.id;
});

function modelGroupsFor(agent: string) {
  const instance = selectedInstance.value;
  if (!instance || !agent) return [];
  return deriveAiSessionModelGroups({
    entities: modelsQuery.data.value || [],
    assignment: instance.modelSelection,
    agent,
    nodeId: instance.nodeId,
    mode: "create",
    capability: normalizeAiSessionModelSelectionCapabilities(directoryAiSessionProviderCapability(instance.capabilities?.features, agent)),
  });
}

function matchesDraftModel(option: { modelEntityId: string; modelName: string }) {
  if (!draft.value.modelName || option.modelName !== draft.value.modelName) return false;
  return !draft.value.modelEntityId || option.modelEntityId === draft.value.modelEntityId;
}

function instanceLabel(instance: InstanceBoardItem) {
  const node = instance.node?.name || instance.nodeId;
  return `${instance.name} · ${node}`;
}

function permissionLabelKey(mode: AiSessionPermissionMode) {
  return mode === "auto-review" ? "autoReview" : mode === "full-access" ? "fullAccess" : "ask";
}

function applyProvider(providerId: string, storedSelection?: AiSessionModelSelection) {
  draft.value.providerId = providerId;
  const options = modelOptionsFor(providerId);
  const groups = modelGroupsFor(providerId);
  const match = storedSelection ? options.find((option) => option.modelName === storedSelection.modelName && (!storedSelection.modelEntityId || option.modelEntityId === storedSelection.modelEntityId)) : undefined;
  const fallback = options.length ? defaultAiSessionModelSelection(groups) : undefined;
  const selection = match || fallback;
  if (selection) {
    draft.value.modelEntityId = selection.modelEntityId;
    draft.value.modelName = selection.modelName;
  } else if (storedSelection) {
    draft.value.modelEntityId = storedSelection.modelEntityId;
    draft.value.modelName = storedSelection.modelName;
  } else {
    draft.value.modelEntityId = "";
    draft.value.modelName = "";
  }
  if (normalizeAiSessionReasoningEffortCapabilities(providerCapabilityFor(providerId)).selectAtCreate) {
    draft.value.reasoningEffort = reasoningEfforts.includes(draft.value.reasoningEffort as AiSessionReasoningEffort) ? draft.value.reasoningEffort : AI_SESSION_DEFAULT_REASONING_EFFORT;
  } else if (!props.agent) {
    draft.value.reasoningEffort = "";
  }
}

function modelOptionsFor(providerId: string) {
  return modelGroupsFor(providerId).flatMap((group) => group.models);
}

function providerCapabilityFor(providerId: string) {
  const instance = selectedInstance.value;
  return instance ? directoryAiSessionProviderCapability(instance.capabilities?.features, providerId) : undefined;
}

function initialize() {
  const agent = props.agent;
  draft.value = agent ? agentDraftFromDefinition(agent) : emptyAgentDraft();
  folderBrowserOpen.value = false;
  folderError.value = "";
  saving.value = false;
  saveError.value = "";
  createdFolders.value = [];
  if (!draft.value.targetInstanceId) {
    const preferred = candidateInstances.value.find((instance) => instance.runtime?.type !== "local") || candidateInstances.value[0];
    draft.value.targetInstanceId = preferred?.id || "";
  }
  const instance = selectedInstance.value;
  if (!instance) return;
  const providerId = providers.value.some((provider) => provider.id === draft.value.providerId) ? draft.value.providerId : providers.value[0]?.id || draft.value.providerId;
  applyProvider(providerId, agent ? { modelEntityId: draft.value.modelEntityId, modelName: draft.value.modelName } : undefined);
  if (!draft.value.permissionMode) draft.value.permissionMode = permissionOptions.value[0] || instance.config.defaultCodexPermissionMode;
  if (!draft.value.cwdFolderPath) applyDefaultFolder();
}

function selectInstance(instanceId: string) {
  draft.value.targetInstanceId = instanceId;
  draft.value.cwdFolderId = "";
  draft.value.cwdFolderPath = "";
  folderBrowserOpen.value = false;
  folderError.value = "";
  createdFolders.value = [];
  const providerId = providers.value.some((provider) => provider.id === draft.value.providerId) ? draft.value.providerId : providers.value[0]?.id || "";
  applyProvider(providerId);
  applyDefaultFolder();
}

function selectProvider(providerId: string) {
  applyProvider(providerId);
}

function selectModel(value: string) {
  const option = modelOptions.value[Number(value)];
  if (!option) return;
  draft.value.modelEntityId = option.modelEntityId;
  draft.value.modelName = option.modelName;
}

function selectReasoningEffort(value: string) {
  draft.value.reasoningEffort = value;
}

function selectPermissionMode(value: string) {
  draft.value.permissionMode = value;
}

function applyDefaultFolder() {
  if (instanceWorkspaceFolder.value) {
    selectFolder(workspaceFolderValue);
    return;
  }
  const first = folderCandidates.value[0];
  if (first) selectFolder(first.id);
}

function selectFolder(value: string) {
  folderError.value = "";
  if (value === chooseFolderValue) {
    folderBrowserOpen.value = true;
    if (nodeId.value) void browser.loadRoots(nodeId.value);
    return;
  }
  folderBrowserOpen.value = false;
  if (value === workspaceFolderValue) {
    draft.value.cwdFolderId = instanceWorkspaceFolder.value?.id || "";
    draft.value.cwdFolderPath = instanceWorkspacePath.value;
    return;
  }
  const folder = folderCandidates.value.find((candidate) => candidate.id === value);
  draft.value.cwdFolderId = folder?.id || "";
  draft.value.cwdFolderPath = folder?.path || "";
}

async function useBrowsedFolder() {
  const path = browser.selectedPath.value.trim();
  if (!path || !nodeId.value || registeringFolder.value) return;
  registeringFolder.value = true;
  folderError.value = "";
  try {
    const folder = await createNodeLocalFolder(nodeId.value, { name: nodePathName(path), path });
    createdFolders.value = [...createdFolders.value, folder];
    selectFolder(folder.id);
  } catch (cause) {
    folderError.value = translateApiError(cause, t);
  } finally {
    registeringFolder.value = false;
  }
}

function toggleCallable(agentId: string, checked: boolean) {
  const next = new Set(draft.value.callableAgentIds);
  if (checked) next.add(agentId);
  else next.delete(agentId);
  draft.value.callableAgentIds = [...next];
}

function setOpen(open: boolean) {
  emit("update:open", open);
}

async function submit() {
  if (!canSubmit.value || saving.value) return;
  saving.value = true;
  saveError.value = "";
  try {
    await props.save({ ...draft.value });
    emit("update:open", false);
  } catch (cause) {
    saveError.value = translateApiError(cause, t);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
:global(.agent-editor-dialog) {
  width: min(760px, calc(100vw - 32px)) !important;
  max-width: calc(100vw - 32px) !important;
  max-height: min(760px, calc(100dvh - 100px)) !important;
  overflow: hidden;
}

.agent-editor-header { flex-direction: row; align-items: flex-start; justify-content: space-between; gap: 16px; text-align: left; }
.agent-editor-close { display: grid; flex: 0 0 auto; width: 30px; height: 30px; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--text-muted); cursor: pointer; padding: 0; }
.agent-editor-close:hover, .agent-editor-close:focus-visible { background: var(--surface-active); color: var(--text-strong); outline: none; }
:global(.agent-editor-dialog .agent-editor-title) { font-size: 16px; }
:global(.agent-editor-dialog .agent-editor-description) { font-size: 12px; line-height: 1.5; }
.agent-editor-body { min-height: 0; max-height: min(600px, calc(100dvh - 300px)); }
.agent-editor-fields { display: grid; gap: 14px; padding-right: 10px; }
.agent-editor-section { display: grid; gap: 8px; border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
.agent-editor-section h3 { margin: 0; color: var(--text-muted); font-size: 12px; font-weight: 500; }
.agent-editor-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px 12px; }
.agent-editor-field { display: grid; gap: 6px; min-width: 0; color: var(--text-muted); font-size: 12px; }
.agent-editor-textarea { min-height: 66px; font-size: 13px; }
.agent-editor-hint { margin: 0; color: var(--text-muted); font-size: 12px; }
.agent-editor-folder { display: grid; gap: 8px; }
.agent-editor-folder-path { min-width: 0; color: var(--text); font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; overflow-wrap: anywhere; }
.agent-editor-callable { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 6px; }
.agent-editor-callable-item { display: flex; align-items: flex-start; gap: 8px; min-width: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-inset); padding: 8px; }
.agent-editor-callable-item > span { display: grid; min-width: 0; gap: 2px; }
.agent-editor-callable-item strong { color: var(--text-strong); font-size: 13px; font-weight: 500; }
.agent-editor-callable-item small { color: var(--text-muted); font-size: 12px; }
.agent-editor-field-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 6px 12px; margin: 0; }
.agent-editor-field-list > div { display: flex; gap: 8px; min-width: 0; }
.agent-editor-field-list dt { flex: none; min-width: 56px; color: var(--text-muted); font-size: 12px; }
.agent-editor-field-list dd { margin: 0; min-width: 0; color: var(--text); font-size: 12px; overflow-wrap: anywhere; }
.agent-editor-footer { display: grid; gap: 8px; }
.agent-editor-blocked { margin: 0; border: 1px solid var(--line-strong); border-radius: 8px; padding: 7px 10px; color: var(--text-strong); font-size: 12px; }
.agent-editor-actions { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 640px) {
  .agent-editor-actions { flex-wrap: wrap; }
}
</style>
