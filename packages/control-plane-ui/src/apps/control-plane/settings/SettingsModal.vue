<template>
  <section class="control-settings-page" aria-label="Settings">
      <div class="control-settings-page-actions">
        <Button variant="outline" size="sm" @click="emit('back')">
          <ArrowLeft :size="14" />
          <span>Back</span>
        </Button>
        <Tabs :model-value="settingsSection" @update:model-value="(value) => setSettingsSection(value as SettingsSection)">
          <TabsList class="control-settings-tabs" aria-label="Settings sections">
            <TabsTrigger v-for="item in settingsSections" :key="item.id" :value="item.id">{{ item.label }}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <ControlPlaneTriggersView v-if="settingsSection === 'triggers'" :instances="instances" />

      <BasicSettingsSection
        v-else-if="settingsSection === 'basic'"
        :applying-server-update="applyingServerUpdate"
        :checking-server-update="checkingServerUpdate"
        v-model:public-base-url="publicBaseUrl"
        :public-base-url-message="publicBaseUrlMessage"
        :saving-public-base-url="savingPublicBaseUrl"
        :server-current-version="serverCurrentVersion"
        :server-unavailable-reason="serverUnavailableReason"
        :server-update-channel="updateChannel"
        :server-update-check="serverUpdateCheck"
        :server-update-job="serverUpdateJob"
        :server-updates-available="serverUpdatesAvailable"
        :theme-preference="themePreference"
        @apply-server-update="applyServerUpdate"
        @check-server-update="checkServerUpdate"
        @detect-public-base-url="detectPublicBaseUrl"
        @save-public-base-url="savePublicBaseUrl"
        @update:server-update-channel="setUpdateChannel"
        @update:theme-preference="setThemePreference"
      />

      <ChatBridgeSettingsSection
        v-else-if="settingsSection === 'chat'"
        :chat="chatSettings"
        :error-text="errorText"
        :gateway-error="chatGatewayStatus.error.value"
        :is-refreshing="chatBridges.isFetching.value || chatGatewayStatus.isFetching.value"
        :refresh-chat="refreshChat"
      />

      <div v-else-if="settingsSection === 'models'" class="project-management-grid">
        <section class="modal-section">
          <div class="section-head">
            <span>Models · {{ models.data.value?.length || 0 }}</span>
          </div>
          <ScrollArea class="registered-project-list">
            <div class="settings-scroll-content">
            <div v-for="(model, index) in models.data.value || []" :key="model.id" class="registered-project-row">
              <div>
                <strong>{{ model.name }}</strong>
                <code>{{ model.model }} · {{ model.endpoint }}</code>
                <span class="image-meta-line">{{ model.app }} · {{ model.enabled ? "enabled" : "disabled" }} · {{ model.keyPreview || "key set" }}</span>
              </div>
              <div class="settings-row-actions">
                <Button variant="outline" size="sm" class="icon-button" :disabled="savingModelId === model.id || index === 0" aria-label="Move model up" title="Move up" @click="moveModel(model.id, -1)">
                  <ChevronUp :size="14" />
                </Button>
                <Button variant="outline" size="sm" class="icon-button" :disabled="savingModelId === model.id || index === (models.data.value || []).length - 1" aria-label="Move model down" title="Move down" @click="moveModel(model.id, 1)">
                  <ChevronDown :size="14" />
                </Button>
                <Badge :variant="model.enabled ? 'default' : 'secondary'">{{ model.enabled ? "On" : "Off" }}</Badge>
                <Button variant="outline" size="sm" :disabled="savingModelId === model.id" @click="editModel(model)">
                  <Settings :size="14" />
                  <span>Edit</span>
                </Button>
                <Button variant="outline" size="sm" :disabled="deletingModelId === model.id" @click="removeModel(model)">
                  <Trash2 :size="14" />
                  <span>{{ deletingModelId === model.id ? "Deleting" : "Delete" }}</span>
                </Button>
              </div>
            </div>
            <p v-if="!(models.data.value || []).length" class="settings-empty">No models configured.</p>
            </div>
          </ScrollArea>
          <p v-if="modelSaveSuccess" class="settings-success">{{ modelSaveSuccess }}</p>
        </section>

        <section class="modal-section">
          <div class="section-head">
            <span>{{ editingModelId ? "Edit model" : "Add model" }}</span>
            <button v-if="editingModelId" type="button" @click="resetModelForm">New model</button>
          </div>
          <div class="inline-create">
            <label>
              <span>Name</span>
              <ControlPlaneInput v-model="settingsModel.name" placeholder="OpenAI primary" />
            </label>
            <label>
              <span>Endpoint</span>
              <ControlPlaneInput v-model="settingsModel.endpoint" placeholder="https://api.openai.com/v1" />
            </label>
            <label>
              <span>Model</span>
              <ControlPlaneInput v-model="settingsModel.model" placeholder="gpt-5-codex" />
            </label>
            <label>
              <span>Key</span>
              <ControlPlaneInput v-model="settingsModel.key" type="password" :placeholder="editingModelId ? 'Leave blank to keep current key' : 'API key'" />
            </label>
            <label>
              <span>App</span>
              <ControlPlaneSelect v-model="settingsModel.app" placeholder="Select app">
                <ControlPlaneSelectItem value="codex">Codex</ControlPlaneSelectItem>
                <ControlPlaneSelectItem value="claude">Claude</ControlPlaneSelectItem>
              </ControlPlaneSelect>
            </label>
            <div class="checkbox-row">
              <label>
                <Checkbox :model-value="settingsModel.enabled" @update:model-value="(value) => settingsModel.enabled = value === true" />
                <span>Enabled</span>
              </label>
            </div>
            <Button variant="outline" size="sm" :disabled="!canSaveModel || savingModelId === formModelBusyId" @click="saveModel">
              <Plus :size="15" />
              <span>{{ savingModelId === formModelBusyId ? "Saving" : editingModelId ? "Save model" : "Create model" }}</span>
            </Button>
          </div>
        </section>
      </div>

      <div v-else-if="settingsSection === 'images'" class="image-management-grid">
        <section class="modal-section">
          <div class="section-head">
            <span>Registered images · {{ images.data.value?.length || 0 }}</span>
          </div>
          <ScrollArea class="registered-image-list">
            <div class="settings-scroll-content">
            <div v-for="image in images.data.value || []" :key="image.id" class="registered-image-row">
              <div>
                <strong>{{ image.name }}</strong>
                <code>{{ image.image }}</code>
                <span class="image-meta-line">
                  {{ imageLocalStatus(image) }} · {{ image.capabilities.length ? image.capabilities.join(", ") : "no expected capabilities" }}
                </span>
              </div>
              <div class="settings-row-actions">
                <Badge variant="secondary">{{ imageInUse(image.id) ? "In use" : image.registry }}</Badge>
                <Button variant="outline" size="sm" :disabled="imageInUse(image.id) || deletingImageId === image.id" @click="removeImageProfile(image)">
                  <Trash2 :size="14" />
                  <span>{{ deletingImageId === image.id ? "Deleting" : "Delete" }}</span>
                </Button>
              </div>
            </div>
            <p v-if="!(images.data.value || []).length" class="settings-empty">No image profiles yet.</p>
            </div>
          </ScrollArea>
        </section>

        <section class="modal-section">
          <div class="section-head">
            <span>Local Docker images · {{ filteredLocalDockerImages.length }}</span>
            <Button variant="outline" size="sm" :disabled="localDockerImages.isFetching.value" @click="localDockerImages.refetch()">
              <RefreshCw :size="14" />
              <span>{{ localDockerImages.isFetching.value ? "Loading" : "Refresh" }}</span>
            </Button>
          </div>
          <label class="list-filter local-image-filter">
            <Search :size="14" />
            <input v-model="localImageFilter" placeholder="Search local images" />
          </label>
          <p v-if="localDockerImages.error.value" class="control-plane-error">{{ errorText(localDockerImages.error.value) }}</p>
          <p v-if="localImageCreateSuccess" class="settings-success">{{ localImageCreateSuccess }}</p>
          <ScrollArea class="local-image-list">
            <div class="settings-scroll-content">
            <div v-for="image in filteredLocalDockerImages" :key="`${image.reference}-${image.id}`" class="local-image-row">
              <div>
                <strong>{{ image.reference }}</strong>
                <span>{{ image.id }} · {{ image.size || "unknown size" }} · {{ image.createdSince || "unknown age" }}</span>
              </div>
              <Button variant="outline" size="sm" :disabled="isLocalImageRegistered(image) || addingLocalImageRef === image.reference" @click="addLocalImage(image)">
                <Plus :size="14" />
                <span>{{ isLocalImageRegistered(image) ? "Added" : addingLocalImageRef === image.reference ? "Adding" : "Add" }}</span>
              </Button>
            </div>
            <p v-if="!localDockerImages.isFetching.value && !filteredLocalDockerImages.length" class="settings-empty">No local Docker images found.</p>
            </div>
          </ScrollArea>
        </section>
      </div>

      <div v-else-if="settingsSection === 'projects'" class="project-management-grid">
        <section class="modal-section">
          <div class="section-head">
            <span>Git repositories · {{ projects.data.value?.length || 0 }}</span>
          </div>
          <ScrollArea class="registered-project-list">
            <div class="settings-scroll-content">
            <div v-for="project in projects.data.value || []" :key="project.id" class="registered-project-row">
              <div>
                <strong>{{ project.name }}</strong>
                <code>{{ projectSourceLabel(project) }}</code>
              </div>
              <div class="settings-row-actions">
                <Badge variant="secondary">{{ projectInUse(project.id) ? "In use" : project.workspacePolicy.mode }}</Badge>
                <Button variant="outline" size="sm" :disabled="projectInUse(project.id) || deletingProjectId === project.id" @click="removeProject(project)">
                  <Trash2 :size="14" />
                  <span>{{ deletingProjectId === project.id ? "Deleting" : "Delete" }}</span>
                </Button>
              </div>
            </div>
            <p v-if="!(projects.data.value || []).length" class="settings-empty">No Git repositories yet.</p>
            </div>
          </ScrollArea>
        </section>

        <section class="modal-section">
          <div class="section-head">
            <span>Add Git repository</span>
          </div>
          <div class="inline-create">
            <label>
              <span>Name</span>
              <ControlPlaneInput v-model="settingsProject.name" placeholder="Repository name" />
            </label>
            <label>
              <span>Git URL</span>
              <ControlPlaneInput v-model="settingsProject.url" placeholder="https://github.com/org/repo" />
            </label>
            <div class="settings-form-grid">
              <label>
                <span>Default image</span>
                <ControlPlaneSelect v-model="settingsDefaultImageSelectValue" placeholder="Use default">
                  <ControlPlaneSelectItem :value="DEFAULT_SELECT_VALUE">Use default</ControlPlaneSelectItem>
                  <ControlPlaneSelectItem v-for="image in images.data.value || []" :key="image.id" :value="image.id">{{ image.name }}</ControlPlaneSelectItem>
                </ControlPlaneSelect>
              </label>
              <label>
                <span>Default runtime</span>
                <ControlPlaneSelect v-model="settingsDefaultRuntimeSelectValue" placeholder="Use default">
                  <ControlPlaneSelectItem :value="DEFAULT_SELECT_VALUE">Use default</ControlPlaneSelectItem>
                  <ControlPlaneSelectItem v-for="runtime in nodeRuntimeItems" :key="runtime.id" :value="runtime.id">{{ runtimeName(runtime) }}</ControlPlaneSelectItem>
                </ControlPlaneSelect>
              </label>
            </div>
            <Button variant="outline" size="sm" :disabled="!canCreateSettingsProject || creatingSettingsProject" @click="createSettingsProject">
              <Plus :size="15" />
              <span>{{ creatingSettingsProject ? "Creating" : "Create repository" }}</span>
            </Button>
          </div>
          <p v-if="settingsProjectSuccess" class="settings-success">{{ settingsProjectSuccess }}</p>
        </section>
      </div>

      <div v-else class="node-management-grid">
        <TooltipProvider :delay-duration="120">
          <section class="modal-section node-list-panel">
            <div class="section-head">
              <span>Execution nodes · {{ nodes.data.value?.length || 0 }}</span>
              <div class="section-head-actions">
                <Button v-if="hasLocalNode" variant="outline" size="sm" @click="openRemoteNodeDialog">
                  <Plus :size="14" />
                  <span>Add node</span>
                </Button>
                <DropdownMenu v-else>
                  <DropdownMenuTrigger as-child>
                    <Button variant="outline" size="sm">
                      <Plus :size="14" />
                      <span>Add node</span>
                      <ChevronDown :size="13" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent class="node-add-menu" align="end" :side-offset="6">
                    <DropdownMenuItem :disabled="syncingLocalNode" @select="addLocalNode">
                      <span>{{ syncingLocalNode ? "Adding local node" : "Add local node" }}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem @select="openRemoteNodeDialog">
                      <span>Add remote node</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="outline" size="sm" :disabled="nodes.isFetching.value" @click="refresh">
                  <RefreshCw :size="14" />
                  <span>{{ nodes.isFetching.value ? "Refreshing" : "Refresh" }}</span>
                </Button>
              </div>
            </div>
            <ScrollArea class="node-list">
              <div class="settings-scroll-content">
              <button v-for="target in orderedNodes" :key="target.id" type="button" class="node-list-item" :class="{ active: selectedNodeId === target.id }" @click="selectNode(target.id)">
                <span class="node-status-dot" :class="nodeStatusClass(target.id)" />
                <span>
                  <strong>{{ target.name }}</strong>
                  <small>{{ nodeLocationLabel(target) }} · {{ nodeEndpointDisplay(target.endpoint) || target.connectionMode }}</small>
                </span>
                <span class="node-list-meta">
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <span class="node-diagnostic-badge" :aria-label="nodeBuildTitle(target.id)">
                        <Badge :variant="nodeStatusVariant(target.id)">{{ nodeStatusLabel(target.id) }}</Badge>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent class="node-diagnostic-tooltip" align="end" side="bottom">
                      <div class="node-diagnostic-tooltip-grid">
                        <span><b>Protocol</b><em>{{ nodeProtocolLabel(target.id) }}</em></span>
                        <span><b>Build</b><em>{{ nodeBuildLabel(target.id) }}</em></span>
                        <span><b>Package</b><em>{{ nodePackageLabel(target.id) }}</em></span>
                        <span v-if="nodeBuild(target.id)?.imageRef"><b>Image</b><em>{{ nodeBuild(target.id)?.imageRef }}</em></span>
                        <span v-if="nodeBuild(target.id)?.builtAt"><b>Built</b><em>{{ nodeBuild(target.id)?.builtAt }}</em></span>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                  <small>{{ nodeRuntimeSummary(target.id) }} · {{ nodeInstanceSummary(target.id) }}</small>
                </span>
              </button>
              <p v-if="!orderedNodes.length" class="settings-empty">No nodes yet.</p>
              </div>
            </ScrollArea>
          </section>

          <NodeDetailPanel
            :actions="nodeDetailActions"
            :busy="nodeDetailBusy"
            :resources="nodeDetailResources"
            :selected-node="selectedNode"
            :status="nodeDetailStatus"
          />
        </TooltipProvider>
      </div>
      <NodeStorageFolderPickerDialog
        :can-confirm="nodeStorageFolderCanConfirm"
        :error="nodeStorageFolderError"
        :loading="nodeStorageFolderLoading"
        :node-name="nodeStorageFolderTarget?.name || ''"
        :open="nodeStorageFolderDialogOpen"
        :rows="nodeStorageFolderRows"
        :selected-path="nodeStorageFolderSelectedPath"
        :submit-error="nodeStorageFolderSubmitError"
        :submitting="nodeStorageFolderSubmitting"
        @confirm="confirmNodeStorageFolder"
        @refresh="refreshNodeStorageFolderRoots"
        @select="selectNodeStorageFolder"
        @update:open="setNodeStorageFolderDialogOpen"
      />
      <Dialog :open="nodeRenameOpen" @update:open="setNodeRenameOpen">
        <DialogContent class="node-rename-dialog">
          <DialogHeader>
            <DialogTitle>Rename node</DialogTitle>
            <DialogDescription>Change the display name used across the control plane. The node ID and connection settings will not change.</DialogDescription>
          </DialogHeader>

          <form class="node-rename-form" @submit.prevent="submitNodeRename">
            <label for="node-rename-name">Name</label>
            <ControlPlaneInput
              id="node-rename-name"
              :model-value="nodeRenameDraft"
              :maxlength="160"
              :aria-invalid="Boolean(nodeRenameError)"
              :aria-describedby="nodeRenameError ? 'node-rename-error' : undefined"
              :disabled="Boolean(renamingNodeId)"
              autofocus
              @update:model-value="updateNodeRenameDraft"
            />
            <p v-if="nodeRenameError" id="node-rename-error" class="control-plane-error" role="alert">{{ nodeRenameError }}</p>

            <DialogFooter>
              <Button type="button" variant="outline" :disabled="Boolean(renamingNodeId)" @click="setNodeRenameOpen(false)">Cancel</Button>
              <Button type="submit" :disabled="!canSubmitNodeRename">
                <span>{{ renamingNodeId ? "Saving" : "Save" }}</span>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog :open="remoteNodeDialogOpen" @update:open="setRemoteNodeDialogOpen">
        <DialogContent class="remote-node-dialog">
          <DialogHeader>
            <DialogTitle>Add remote node</DialogTitle>
            <DialogDescription>Connect a node-agent that is running on another machine.</DialogDescription>
          </DialogHeader>

          <form class="remote-node-form" @submit.prevent="submitRemoteNode">
            <label>
              <span>Name</span>
              <ControlPlaneInput v-model="settingsNode.name" placeholder="Remote build host" />
            </label>
            <label>
              <span>Endpoint</span>
              <ControlPlaneInput v-model="settingsNode.endpoint" placeholder="http://10.0.0.12:8091" />
            </label>
            <label>
              <span>Join token</span>
              <ControlPlaneInput v-model="settingsNode.joinToken" placeholder="node-agent pairing token" />
            </label>
            <p v-if="settingsNodeSuccess" class="settings-success">{{ settingsNodeSuccess }}</p>

            <div class="remote-node-invite">
              <div>
                <strong>Allow a node to join this control-plane</strong>
                <span>Generate a one-time token for node-agent pairing.</span>
              </div>
              <Button type="button" variant="outline" size="sm" :disabled="creatingJoinInvite" @click="createJoinInvite">
                <Plus :size="14" />
                <span>{{ creatingJoinInvite ? "Generating" : "Generate token" }}</span>
              </Button>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" @click="setRemoteNodeDialogOpen(false)">Cancel</Button>
              <Button type="submit" :disabled="!canCreateNode || creatingNode">
                <Plus :size="15" />
                <span>{{ creatingNode ? "Creating" : "Create node" }}</span>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <GeneratedTokenDialog
        v-if="generatedToken"
        :expires-at="generatedToken.expiresAt"
        :title="generatedToken.title"
        :token="generatedToken.token"
        @close="generatedToken = undefined"
      />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { ArrowLeft, ChevronDown, ChevronUp, Plus, RefreshCw, Search, Settings, Trash2 } from "@lucide/vue";
import { getNodeExternalListener, updateControlPlaneSettings, updateNodeExternalListener, useChatBridgesQuery, useChatGatewayStatusQuery, useControlPlaneSettingsQuery, useImagesQuery, useInstanceBoardPayloadQuery, useLocalDockerImagesQuery, useModelsQuery, useNodeRuntimesPayloadQuery, useNodesQuery, useProjectsQuery, useServerUpdateCheckQuery } from "../../../api/queries";
import type { BuildInfo, ControlPlaneSettings, InstanceBoardItem, Node, NodeAgentExternalListener, UpdateChannel } from "../../../api/types";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ScrollArea } from "../../../components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "../../../components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../components/ui/tooltip";
import ControlPlaneInput from "../shared/ControlPlaneInput.vue";
import ControlPlaneSelect from "../shared/ControlPlaneSelect.vue";
import ControlPlaneSelectItem from "../shared/ControlPlaneSelectItem.vue";
import ControlPlaneTriggersView from "../triggers/ControlPlaneTriggersView.vue";
import BasicSettingsSection from "./AppearanceSettingsSection.vue";
import ChatBridgeSettingsSection from "./ChatBridgeSettingsSection.vue";
import { useChatBridgeSettings } from "./useChatBridgeSettings";
import { useImageSettings } from "./useImageSettings";
import { useModelSettings } from "./useModelSettings";
import { useProjectSettings } from "./useProjectSettings";
import { useNodeResourceSettings } from "./useNodeResourceSettings";
import { useNodeSettings } from "./useNodeSettings";
import NodeDetailPanel from "./NodeDetailPanel.vue";
import NodeStorageFolderPickerDialog from "./NodeStorageFolderPickerDialog.vue";
import GeneratedTokenDialog from "./GeneratedTokenDialog.vue";
import { nodeEndpointDisplay } from "./nodeEndpointDisplay";
import { getThemePreference, saveThemePreference, type ThemePreference } from "../../../utils/theme";
import { showControlPlaneToast } from "../useControlPlaneToasts";

type SettingsSection = "basic" | "chat" | "images" | "projects" | "nodes" | "models" | "triggers";
type NodeDiagnosticLog = {
  route: string;
  method: string;
  code: string;
  message: string;
  statusCode?: number;
  issues?: Array<{ path: string; message: string }>;
};

const props = defineProps<{
  chooseProjectFolder?: () => Promise<string | { path: string; ownerNodeId?: string } | undefined>;
  initialSection?: SettingsSection;
  instances: InstanceBoardItem[];
}>();

const emit = defineEmits<{
  back: [];
  "section-change": [section: SettingsSection];
}>();

const DEFAULT_SELECT_VALUE = "__default__";
const settingsSections: Array<{ id: SettingsSection; label: string }> = [
  { id: "nodes", label: "Nodes" },
  { id: "images", label: "Images" },
  { id: "projects", label: "Projects" },
  { id: "models", label: "Models" },
  { id: "triggers", label: "Triggers" },
  { id: "chat", label: "Chat" },
  { id: "basic", label: "Basic" },
];

const queryClient = useQueryClient();
const projects = useProjectsQuery();
const models = useModelsQuery();
const images = useImagesQuery();
const nodes = useNodesQuery();
const nodeRuntimes = useNodeRuntimesPayloadQuery();
const board = useInstanceBoardPayloadQuery();
const chatBridges = useChatBridgesQuery();
const chatGatewayStatus = useChatGatewayStatusQuery();
const controlPlaneSettings = useControlPlaneSettingsQuery();
const updateChannel = computed<UpdateChannel>(() => controlPlaneSettings.data.value?.updateChannel || "stable");

const settingsSection = ref<SettingsSection>(props.initialSection || "nodes");
const themePreference = ref<ThemePreference>(getThemePreference());
const publicBaseUrl = ref("");
const publicBaseUrlMessage = ref("");
const savingPublicBaseUrl = ref(false);
const remoteNodeDialogOpen = ref(false);
const codexModels = computed(() => (models.data.value || []).filter((model) => model.app === "codex"));
const claudeModels = computed(() => (models.data.value || []).filter((model) => model.app === "claude"));
const nodeRuntimeItems = computed(() => nodeRuntimes.data.value?.data || []);
const boardItems = computed(() => board.data.value?.data || []);
const imageIdsInUse = computed(() => new Set(boardItems.value.map((instance) => instance.imageId)));
const projectIdsInUse = computed(() => new Set(boardItems.value.map((instance) => instance.projectId)));
const nodeDiagnosticsByNodeId = computed(() => {
  const diagnostics: Record<string, NodeDiagnosticLog[]> = {};
  const seen = new Set<string>();
  for (const error of [...(nodeRuntimes.data.value?.meta?.nodeErrors || []), ...(board.data.value?.meta?.nodeErrors || [])]) {
    const issuesKey = JSON.stringify(error.issues || []);
    const key = `${error.nodeId}:${error.method}:${error.route}:${error.code}:${error.message}:${error.statusCode || ""}:${issuesKey}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    (diagnostics[error.nodeId] ||= []).push({
      route: error.route,
      method: error.method,
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
      issues: error.issues?.map((issue) => ({
        path: issue.path?.join(".") || "",
        message: issue.message,
      })),
    });
  }
  return diagnostics;
});

watch(
  () => props.initialSection,
  (section) => {
    if (section) {
      if (section !== "nodes") closeNodeStorageFolderPicker();
      settingsSection.value = section;
    }
  },
);

watch(
  () => controlPlaneSettings.data.value?.publicBaseUrl,
  (value) => {
    publicBaseUrl.value = value || "";
  },
  { immediate: true },
);

async function refresh() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["control-plane-status"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-settings"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-projects"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-models"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-images"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-nodes"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-node-local-folders"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-node-runtimes"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-node-runtimes-payload"] }),
    queryClient.invalidateQueries({ queryKey: ["instance-board"] }),
    queryClient.invalidateQueries({ queryKey: ["instance-board-payload"] }),
    queryClient.invalidateQueries({ queryKey: ["chat-gateway-bridges"] }),
    queryClient.invalidateQueries({ queryKey: ["chat-gateway-status"] }),
  ]);
}

async function syncRenamedNode(renamed: Node) {
  queryClient.setQueryData<Node[]>(["control-plane-nodes"], (current) => {
    if (!current) return [renamed];
    return current.map((node) => node.id === renamed.id ? renamed : node);
  });
  await Promise.allSettled([
    queryClient.invalidateQueries({ queryKey: ["control-plane-nodes"] }),
    queryClient.refetchQueries({ queryKey: ["instance-board"] }),
    queryClient.refetchQueries({ queryKey: ["instance-board-payload"] }),
  ]);
}

const chatSettings = useChatBridgeSettings({
  bridges: chatBridges.data,
  errorText,
  gatewayStatus: chatGatewayStatus.data,
  refresh: refreshChat,
});
const { clearChatFeedback } = chatSettings;
const {
  canCreateSettingsProject,
  clearDefaultImage,
  clearDefaultRuntime,
  clearProjectFeedback,
  createSettingsProject,
  creatingSettingsProject,
  deletingProjectId,
  projectSourceLabel,
  removeProject,
  settingsDefaultImageSelectValue,
  settingsDefaultRuntimeSelectValue,
  settingsProject,
  settingsProjectSuccess,
} = useProjectSettings({
  errorText,
  onProjectDeleted() {},
  projectInUse,
  refresh,
});
const {
  addLocalhostRuntime,
  checkingRuntimeId,
  closeNodeStorageFolderPicker,
  confirmNodeStorageFolder,
  creatingLocalhostRuntime,
  creatingNodeLocalFolder,
  deletingNodeLocalFolderId,
  deletingRuntimeId,
  isControlPlaneBuiltinNode,
  isControlPlaneLocalNode,
  localNodeId,
  nodeLocalFolders,
  nodeStorageFolderCanConfirm,
  nodeStorageFolderDialogOpen,
  nodeStorageFolderError,
  nodeStorageFolderLoading,
  nodeStorageFolderRows,
  nodeStorageFolderSelectedPath,
  nodeStorageFolderSubmitError,
  nodeStorageFolderSubmitting,
  nodeStorageFolderTarget,
  nodeLocationLabel,
  orderedNodes,
  removeNodeLocalFolder,
  removeRuntime,
  runtimeName,
  checkRuntime,
  selectedNode,
  selectedNodeHasLocalRuntime,
  selectedNodeId,
  selectedNodeInstances,
  selectedNodeIsLocal,
  selectedNodeRuntimes,
  selectNode,
  selectNodeStorageFolder,
  setNodeStorageFolderDialogOpen,
  submitNodeLocalFolder,
  refreshNodeStorageFolderRoots,
} = useNodeResourceSettings({
  chooseProjectFolder: props.chooseProjectFolder,
  clearDefaultRuntime,
  errorText,
  instances: boardItems,
  nodes: nodes.data,
  refresh,
  runtimes: nodeRuntimeItems,
});
const externalListener = ref<NodeAgentExternalListener>();
const externalListenerBindScope = ref<NodeAgentExternalListener["bindScope"]>("loopback");
const externalListenerPort = ref("8091");
const externalListenerError = ref("");
const loadingExternalListener = ref(false);
const savingExternalListener = ref(false);

async function loadExternalListener() {
  const node = selectedNode.value;
  if (!node || !isControlPlaneBuiltinNode(node)) {
    externalListener.value = undefined;
    externalListenerError.value = "";
    return;
  }
  loadingExternalListener.value = true;
  externalListenerError.value = "";
  try {
    const listener = await getNodeExternalListener(node.id);
    externalListener.value = listener;
    externalListenerBindScope.value = listener.bindScope;
    externalListenerPort.value = String(listener.port);
  } catch (error) {
    externalListenerError.value = errorText(error);
  } finally {
    loadingExternalListener.value = false;
  }
}

function updateExternalListenerDraft(field: "bindScope" | "port", value: string) {
  if (field === "bindScope") {
    if (value === "loopback" || value === "all-ipv4") externalListenerBindScope.value = value;
    return;
  }
  externalListenerPort.value = value;
}

async function saveExternalListener() {
  const node = selectedNode.value;
  if (!node || !isControlPlaneBuiltinNode(node) || savingExternalListener.value) return;
  const port = Number(externalListenerPort.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    externalListenerError.value = "Port must be an integer from 1 to 65535.";
    return;
  }
  const scopeChangedToAll = externalListener.value?.bindScope !== "all-ipv4" && externalListenerBindScope.value === "all-ipv4";
  const portChanged = externalListener.value?.port !== port;
  const warnings = [
    scopeChangedToAll ? "This exposes the node-agent TCP API on every IPv4 interface. Firewall, NAT, DNS, and TLS termination remain your responsibility." : "",
    portChanged ? "Paired remote control-planes keep their old endpoint and must be updated manually." : "",
  ].filter(Boolean);
  if (warnings.length && !window.confirm(`${warnings.join("\n\n")}\n\nApply this listener change?`)) return;

  savingExternalListener.value = true;
  externalListenerError.value = "";
  try {
    externalListener.value = await updateNodeExternalListener(node.id, { bindScope: externalListenerBindScope.value, port });
    showControlPlaneToast("Node-agent TCP listener updated.", "success");
  } catch (error) {
    externalListenerError.value = errorText(error);
    showControlPlaneToast(externalListenerError.value);
  } finally {
    savingExternalListener.value = false;
    await loadExternalListener();
  }
}

watch(
  () => selectedNode.value?.id,
  () => { void loadExternalListener(); },
  { immediate: true },
);
const localDockerImages = useLocalDockerImagesQuery(() => localNodeId.value);
const hasLocalNode = computed(() => (nodes.data.value || []).some(isControlPlaneLocalNode));
onMounted(() => {
  if (localNodeId.value) {
    void localDockerImages.refetch();
  }
});

watch(
  localNodeId,
  (nodeId) => {
    if (nodeId) {
      void localDockerImages.refetch();
    }
  },
);
const {
  addLocalImage,
  addingLocalImageRef,
  clearImageFeedback,
  deletingImageId,
  filteredLocalDockerImages,
  imageLocalStatus,
  isLocalImageRegistered,
  localImageCreateSuccess,
  localImageFilter,
  removeImageProfile,
} = useImageSettings({
  errorText,
  imageInUse,
  images: images.data,
  localDockerImages: localDockerImages.data,
  onImageDeleted: clearDefaultImage,
  refresh,
});
const {
  canSaveModel,
  clearModelFeedback,
  deletingModelId,
  editModel,
  editingModelId,
  formModelBusyId,
  modelSaveSuccess,
  moveModel,
  removeModel,
  resetModelForm,
  saveModel,
  savingModelId,
  settingsModel,
} = useModelSettings({
  errorText,
  models: () => models.data.value || [],
  onModelDeleted() {},
  refresh,
});
const {
  addLocalNode,
  applyManagedUpdate,
  applyingUpdateTarget,
  canConnectRemote,
  canCreateNode,
  canSubmitNodeRename,
  checkSettingsNode,
  checkManagedUpdate,
  checkingUpdateTarget,
  checkingNodeId,
  clearNodeFeedback,
  connectSelectedNodeToRemote,
  connectingRemoteNodeId,
  createJoinInvite,
  createPairingInviteForNode,
  createSettingsNode,
  generatedToken,
  creatingJoinInvite,
  creatingPairingInviteNodeId,
  creatingNode,
  deletingNodeId,
  deletingRemoteKeyId,
  loadRemoteKeys,
  loadManagedUpdateJobs,
  loadNodeImages,
  loadingRemoteKeysNodeId,
  loadingNodeImagesId,
  managedUpdateKey,
  nodeRenameDraft,
  nodeRenameError,
  nodeRenameOpen,
  openNodeRename,
  removeNode,
  removeRemoteKey,
  renamingNodeId,
  resetNodeRename,
  nodeImageError,
  nodeImages,
  nodeStatusById,
  nodeNameById,
  selectedImageNodeId,
  remoteConnectResultByNodeId,
  remoteKeysByNodeId,
  remoteKeysErrorByNodeId,
  remoteConnect,
  settingsNode,
  settingsNodeSuccess,
  setNodeRenameOpen,
  submitNodeRename,
  syncingLocalNode,
  updateChecks,
  updateJobs,
  updateNodeRenameDraft,
} = useNodeSettings({
  errorText,
  onNodeDeleted: clearDefaultRuntime,
  onNodeRenamed: syncRenamedNode,
  refresh,
  nodes: () => nodes.data.value || [],
  runtimes: () => nodeRuntimeItems.value,
  updateChannel: () => updateChannel.value,
});

function openRemoteNodeDialog() {
  clearNodeFeedback();
  remoteNodeDialogOpen.value = true;
}

function setRemoteNodeDialogOpen(open: boolean) {
  remoteNodeDialogOpen.value = open;
  if (!open) {
    clearNodeFeedback();
  }
}

async function submitRemoteNode() {
  await createSettingsNode();
  if (settingsNodeSuccess.value) {
    remoteNodeDialogOpen.value = false;
  }
}

async function setUpdateChannel(value: string) {
  if (value !== "stable" && value !== "beta" && value !== "alpha") return;
  try {
    const saved = await updateControlPlaneSettings({ updateChannel: value });
    queryClient.setQueryData<ControlPlaneSettings>(["control-plane-settings"], saved);
    for (const key of Object.keys(updateChecks)) delete updateChecks[key];
  } catch (error) {
    showControlPlaneToast(errorText(error));
  }
}

const serverUpdateTarget = { component: "node-agent" as const };
const serverUpdateNode = computed(() => (nodes.data.value || []).find((node) => isControlPlaneBuiltinNode(node)));
const serverUpdateNodeId = computed(() => serverUpdateNode.value?.id || "");
const isDesktopApp = Boolean((window as Window & { taskHandoffDesktop?: unknown }).taskHandoffDesktop);
const serverUpdatesAvailable = computed(() => Boolean(serverUpdateNodeId.value && !isDesktopApp));
const serverUnavailableReason = computed(() => isDesktopApp ? "Desktop updates use the desktop release channel." : "The built-in server node is unavailable.");
const serverUpdateStateKey = computed(() => serverUpdateNodeId.value ? managedUpdateKey(serverUpdateNodeId.value, serverUpdateTarget) : "");
const serverUpdateQueryNodeId = computed(() => serverUpdatesAvailable.value ? serverUpdateNodeId.value : "");
const serverUpdateQuery = useServerUpdateCheckQuery(serverUpdateQueryNodeId, updateChannel);
const serverUpdateCheck = computed(() => serverUpdateQuery.data.value);
const serverCurrentVersion = computed(() => serverUpdateNodeId.value ? nodeBuild(serverUpdateNodeId.value)?.packageVersion : undefined);
const serverUpdateJob = computed(() => updateJobs.value.find((job) => job.nodeId === serverUpdateNodeId.value && job.target.component === "node-agent"));
const checkingServerUpdate = computed(() => serverUpdateQuery.isFetching.value);
const applyingServerUpdate = computed(() => applyingUpdateTarget.value === serverUpdateStateKey.value);

async function checkServerUpdate() {
  if (serverUpdatesAvailable.value) await serverUpdateQuery.refetch();
}

async function applyServerUpdate() {
  if (serverUpdatesAvailable.value) await applyManagedUpdate(serverUpdateNodeId.value, serverUpdateTarget, serverUpdateCheck.value);
}

const nodeDetailActions = computed(() => ({
  addLocalhostRuntime,
  checkRuntime,
  checkSettingsNode,
  checkManagedUpdate,
  applyManagedUpdate,
  connectSelectedNodeToRemote,
  createPairingInviteForNode,
  loadNodeImages,
  loadRemoteKeys,
  loadManagedUpdateJobs,
  openNodeRename,
  removeNode,
  removeNodeLocalFolder,
  removeRemoteKey,
  removeRuntime,
  saveExternalListener,
  submitNodeLocalFolder,
  setUpdateChannel,
  updateExternalListenerDraft,
  updateRemoteConnect,
}));

const nodeDetailBusy = computed(() => ({
  checkingNodeId: checkingNodeId.value,
  checkingUpdateTarget: checkingUpdateTarget.value,
  applyingUpdateTarget: applyingUpdateTarget.value,
  checkingRuntimeId: checkingRuntimeId.value,
  connectingRemoteNodeId: connectingRemoteNodeId.value,
  creatingLocalhostRuntime: creatingLocalhostRuntime.value,
  creatingNodeLocalFolder: creatingNodeLocalFolder.value,
  creatingPairingInviteNodeId: creatingPairingInviteNodeId.value,
  deletingNodeId: deletingNodeId.value,
  deletingNodeLocalFolderId: deletingNodeLocalFolderId.value,
  deletingRemoteKeyId: deletingRemoteKeyId.value,
  deletingRuntimeId: deletingRuntimeId.value,
  loadingNodeImagesId: loadingNodeImagesId.value,
  loadingRemoteKeysNodeId: loadingRemoteKeysNodeId.value,
  loadingExternalListener: loadingExternalListener.value,
  renamingNodeId: renamingNodeId.value,
  savingExternalListener: savingExternalListener.value,
}));

const nodeDetailResources = computed(() => ({
  canConnectRemote: canConnectRemote.value,
  images: nodeImages.value,
  imagesError: nodeImageError.value,
  instances: selectedNodeInstances.value,
  localFoldersError: nodeLocalFolders.error.value ? errorText(nodeLocalFolders.error.value) : "",
  localFolders: nodeLocalFolders.data.value || [],
  remoteConnect,
  remoteConnectResultByNodeId,
  remoteKeys: selectedNode.value ? remoteKeysByNodeId[selectedNode.value.id] || [] : [],
  remoteKeysError: selectedNode.value ? remoteKeysErrorByNodeId[selectedNode.value.id] || "" : "",
  diagnostics: selectedNode.value ? nodeDiagnosticsByNodeId.value[selectedNode.value.id] || [] : [],
  externalListener: externalListener.value,
  externalListenerBindScope: externalListenerBindScope.value,
  externalListenerError: externalListenerError.value,
  externalListenerPort: externalListenerPort.value,
  runtimes: selectedNodeRuntimes.value,
  selectedImageNodeId: selectedImageNodeId.value,
  selectedNodeHasLocalRuntime: selectedNodeHasLocalRuntime.value,
  selectedNodeIsLocal: selectedNodeIsLocal.value,
  updateChannel: updateChannel.value,
  updateChecks,
  updateJobs: updateJobs.value,
}));

const nodeDetailStatus = {
  build: nodeBuild,
  buildLabel: nodeBuildLabel,
  buildTitle: nodeBuildTitle,
  isBuiltinNode: isControlPlaneBuiltinNode,
  locationLabel: nodeLocationLabel,
  nameById: nodeNameById,
  packageLabel: nodePackageLabel,
  protocolLabel: nodeProtocolLabel,
  statusLabel: nodeStatusLabel,
  statusVariant: nodeStatusVariant,
};

watch(
  () => selectedNode.value?.id,
  (nodeId, previousNodeId) => {
    if (previousNodeId && nodeId !== previousNodeId) resetNodeRename();
    if (nodeId) {
      void loadRemoteKeys(nodeId);
      void loadManagedUpdateJobs(nodeId);
    }
  },
  { immediate: true },
);

async function setSettingsSection(section: SettingsSection) {
  if (section !== "nodes") closeNodeStorageFolderPicker();
  settingsSection.value = section;
  emit("section-change", section);
  clearImageFeedback();
  clearProjectFeedback();
  clearNodeFeedback();
  clearModelFeedback();
  clearChatFeedback();
  publicBaseUrlMessage.value = "";
  if (section === "images" && !localDockerImages.data.value) {
    await localDockerImages.refetch();
  }
  if (section === "chat") {
    await refreshChat();
  }
  if (section === "basic" && serverUpdateNodeId.value) {
    await loadManagedUpdateJobs(serverUpdateNodeId.value);
  }
}

function setThemePreference(theme: ThemePreference) {
  themePreference.value = theme;
  saveThemePreference(theme);
}

function detectPublicBaseUrl() {
  publicBaseUrl.value = window.location.origin;
  publicBaseUrlMessage.value = "Current URL filled in.";
}

async function savePublicBaseUrl() {
  if (savingPublicBaseUrl.value) {
    return;
  }
  savingPublicBaseUrl.value = true;
  publicBaseUrlMessage.value = "";
  try {
    const saved = await updateControlPlaneSettings({ publicBaseUrl: publicBaseUrl.value.trim() || undefined });
    publicBaseUrl.value = saved.publicBaseUrl || "";
    publicBaseUrlMessage.value = "Public URL saved.";
    await queryClient.invalidateQueries({ queryKey: ["control-plane-settings"] });
  } catch (error) {
    showControlPlaneToast(errorText(error));
  } finally {
    savingPublicBaseUrl.value = false;
  }
}

async function refreshChat() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["chat-gateway-bridges"] }),
    queryClient.invalidateQueries({ queryKey: ["chat-gateway-status"] }),
  ]);
}

function imageInUse(imageId: string) {
  return imageIdsInUse.value.has(imageId);
}

function projectInUse(projectId: string) {
  return projectIdsInUse.value.has(projectId);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function nodeAgent(nodeId: string) {
  const checkedAgent = asRecord(nodeStatusById[nodeId]?.agent);
  if (checkedAgent) {
    return checkedAgent;
  }
  const node = (nodes.data.value || []).find((item) => item.id === nodeId);
  return asRecord(node?.capabilities["agent"]);
}

function nodeBuild(nodeId: string): Partial<BuildInfo> | undefined {
  return asRecord(nodeAgent(nodeId)?.build) as Partial<BuildInfo> | undefined;
}

function nodeProtocolLabel(nodeId: string) {
  const protocolVersion = nodeAgent(nodeId)?.protocolVersion;
  return typeof protocolVersion === "string" && protocolVersion ? protocolVersion : nodeBuild(nodeId)?.protocolVersion || "unknown";
}

function nodeBuildLabel(nodeId: string) {
  const build = nodeBuild(nodeId);
  return build?.buildId || build?.gitCommit?.slice(0, 12) || "unknown";
}

function nodePackageLabel(nodeId: string) {
  return nodeBuild(nodeId)?.packageVersion || "unknown";
}

function nodeBuildTitle(nodeId: string) {
  const build = nodeBuild(nodeId);
  return [
    `Protocol: ${nodeProtocolLabel(nodeId)}`,
    `Build: ${nodeBuildLabel(nodeId)}`,
    `Package: ${nodePackageLabel(nodeId)}`,
    build?.imageRef ? `Image: ${build.imageRef}` : undefined,
    build?.builtAt ? `Built: ${build.builtAt}` : undefined,
  ].filter(Boolean).join("\n");
}

function nodeRuntimeSummary(nodeId: string) {
  const count = nodeRuntimeItems.value.filter((runtime) => runtime.nodeId === nodeId).length;
  return `${count} runtime${count === 1 ? "" : "s"}`;
}

function nodeInstanceSummary(nodeId: string) {
  const instances = boardItems.value.filter((instance) => instance.nodeId === nodeId);
  const running = instances.filter((instance) => instance.status === "running").length;
  return `${running}/${instances.length} running`;
}

function nodeStatusLabel(nodeId: string) {
  const node = (nodes.data.value || []).find((item) => item.id === nodeId);
  return nodeStatusById[nodeId]?.status || node?.status || "unknown";
}

function nodeStatusVariant(nodeId: string) {
  return nodeStatusLabel(nodeId) === "online" ? "default" : "secondary";
}

function nodeStatusClass(nodeId: string) {
  return `status-${nodeStatusLabel(nodeId)}`;
}

function updateRemoteConnect(field: "controlPlaneUrl" | "joinToken" | "controlPlaneName", value: string) {
  remoteConnect[field] = value;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
</script>

<style scoped>
.control-settings-page {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  align-items: start;
  min-width: 0;
  height: 100%;
  overflow: hidden;
  gap: 12px;
  background:
    radial-gradient(circle at 62% -10%, var(--brand-accent-soft), transparent 28rem),
    var(--surface-inset);
  color: var(--text);
  padding: 18px;
}

.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.control-settings-page :deep(.trigger-board) {
  padding: 12px;
}

.control-settings-page-actions {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  min-width: 0;
  gap: 10px;
}

.control-settings-tabs,
.source-toggle {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  height: 32px;
  min-height: 32px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-inset);
  padding: 2px;
}

.control-settings-tabs {
  align-self: start;
  gap: 1px;
}

.control-settings-tabs button,
.source-toggle button {
  height: 26px;
  min-height: 26px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 750;
  padding: 0 10px;
}

.source-toggle button {
  min-height: 26px;
  padding: 0 9px;
}

.control-settings-tabs button:hover,
.control-settings-tabs button:focus-visible,
.control-settings-tabs button[data-state="active"],
.source-toggle button:hover,
.source-toggle button:focus-visible,
.source-toggle button.active {
  background: var(--surface-active);
  color: var(--white);
  outline: none;
}

.image-management-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.8fr) minmax(0, 1.2fr);
  align-items: start;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}

.project-management-grid {
  display: grid;
  grid-template-columns: minmax(280px, 0.9fr) minmax(0, 1.1fr);
  align-items: start;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}

.node-management-grid {
  display: grid;
  grid-template-columns: minmax(280px, 0.78fr) minmax(0, 1.22fr);
  align-items: start;
  gap: 12px;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.node-list-panel,
.node-detail-panel {
  display: grid;
  grid-template-rows: minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
}

.node-list-panel {
  grid-template-rows: auto minmax(0, 1fr);
}

.node-list {
  min-height: 0;
  padding-right: 2px;
}

.settings-scroll-content {
  display: grid;
  align-content: start;
  gap: 8px;
  min-height: 100%;
  padding-right: 2px;
}

.node-list-item {
  display: grid;
  grid-template-columns: 12px minmax(0, 1fr);
  gap: 9px;
  width: 100%;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  color: inherit;
  cursor: pointer;
  padding: 10px;
  text-align: left;
}

.node-list-item:hover,
.node-list-item:focus-visible,
.node-list-item.active {
  border-color: var(--brand-accent);
  background: var(--surface-hover);
  outline: none;
}

.node-list-item > span:nth-child(2) {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.node-list-item strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-list-item small,
.node-list-item code {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-status-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: var(--text-subtle);
  margin-top: 4px;
  box-shadow: 0 0 0 3px var(--surface-subtle);
}

.node-status-dot.status-online {
  background: var(--status-success);
  box-shadow: 0 0 0 3px var(--brand-accent-soft);
}

.node-status-dot.status-offline,
.node-status-dot.status-failed {
  background: var(--status-danger);
  box-shadow: 0 0 0 3px var(--status-danger-bg);
}

.node-list-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  grid-column: 2;
  min-width: 0;
}

.node-diagnostic-badge {
  display: inline-flex;
  cursor: help;
  outline: none;
}

:global(.node-diagnostic-tooltip) {
  min-width: 230px;
  max-width: min(360px, 80vw);
  border: 1px solid var(--line-strong) !important;
  background: var(--surface-inset) !important;
  color: var(--text) !important;
  box-shadow: var(--shadow-popover);
}

:global(.node-diagnostic-tooltip-grid) {
  display: grid;
  gap: 7px;
}

:global(.node-diagnostic-tooltip-grid span) {
  display: grid;
  grid-template-columns: 64px minmax(0, 1fr);
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

:global(.node-diagnostic-tooltip-grid b),
:global(.node-diagnostic-tooltip-grid em) {
  overflow: hidden;
  font-size: 11px;
  font-style: normal;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:global(.node-diagnostic-tooltip-grid b) {
  color: var(--text-muted) !important;
  font-weight: 750;
}

:global(.node-diagnostic-tooltip-grid em) {
  color: var(--text-strong) !important;
  font-weight: 650;
}

:global(.node-add-menu) {
  min-width: 180px;
}

.remote-node-dialog {
  width: min(520px, calc(100vw - 36px));
}

:global(.node-rename-dialog.node-rename-dialog) {
  width: min(460px, calc(100vw - 36px)) !important;
}

.node-rename-form {
  display: grid;
  gap: 10px;
}

.node-rename-form > label {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.node-rename-form .control-plane-error {
  margin: 0;
}

.remote-node-form {
  display: grid;
  gap: 14px;
}

.remote-node-form label {
  display: grid;
  gap: 7px;
}

.remote-node-form label > span,
.remote-node-invite span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.remote-node-invite {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  border-top: 1px solid var(--line);
  padding-top: 14px;
}

.remote-node-invite > div {
  display: grid;
  gap: 4px;
}

.remote-node-invite strong {
  color: var(--text-strong);
  font-size: 12px;
}

.modal-section {
  display: grid;
  gap: 12px;
  min-height: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  box-shadow:
    var(--shadow-panel),
    inset 0 1px 0 var(--workspace-grid);
  padding: 12px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.section-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.section-head span,
.modal-section label span,
.project-model-picker > span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
}

.section-head > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.section-head .inline-flex {
  flex: 0 0 auto;
}

.section-head button:not(.inline-flex) {
  border: 0;
  background: transparent;
  color: var(--status-success);
  cursor: pointer;
  font-size: 12px;
  font-weight: 800;
  padding: 0;
}

.section-head button:not(.inline-flex):hover,
.section-head button:not(.inline-flex):focus-visible {
  color: var(--white);
  outline: none;
}

.registered-image-list,
.local-image-list,
.registered-project-list {
  min-height: 0;
}

.registered-image-list,
.registered-project-list {
  max-height: min(520px, calc(100vh - 270px));
}

.local-image-list {
  max-height: min(470px, calc(100vh - 330px));
}

.runtime-image-panel {
  display: grid;
  gap: 10px;
  border-top: 1px solid var(--line);
  margin-top: 12px;
  padding-top: 12px;
}

.registered-image-row,
.local-image-row,
.registered-project-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  padding: 9px;
}

.settings-row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  gap: 7px;
  min-width: 0;
  max-width: 100%;
}

.registered-image-row > div:first-child,
.local-image-row > div:first-child,
.registered-project-row > div:first-child {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.registered-image-row strong,
.local-image-row strong,
.registered-project-row strong {
  overflow: hidden;
  color: var(--text-strong);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.registered-image-row code,
.local-image-row span,
.registered-project-row code,
.image-meta-line {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-meta-line {
  line-height: 1.35;
}

.checkbox-row,
.project-model-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
}

.checkbox-row label,
.project-model-picker label {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  padding: 0 11px 0 34px;
}

.checkbox-row input,
.project-model-picker input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  margin: 0;
}

.checkbox-row label::before,
.project-model-picker label::before {
  position: absolute;
  left: 11px;
  top: 50%;
  display: grid;
  width: 15px;
  height: 15px;
  place-items: center;
  border: 1px solid var(--text-subtle);
  border-radius: 4px;
  background: var(--surface-inset);
  color: transparent;
  content: "";
  font-size: 13px;
  font-weight: 900;
  line-height: 1;
  transform: translateY(-50%);
}

.checkbox-row label:hover,
.project-model-picker label:hover,
.checkbox-row label:focus-within,
.project-model-picker label:focus-within {
  border-color: var(--brand-accent);
  background: var(--surface-hover);
  color: var(--text-strong);
}

.checkbox-row label:has(input:focus-visible),
.project-model-picker label:has(input:focus-visible) {
  outline: 2px solid var(--brand-accent);
  outline-offset: 2px;
}

.checkbox-row label:has(input:checked),
.project-model-picker label:has(input:checked) {
  border-color: var(--brand-accent);
  background: var(--surface-active);
  color: var(--text-strong);
}

.checkbox-row label:has(input:checked)::before,
.project-model-picker label:has(input:checked)::before {
  border-color: var(--brand-accent);
  background: var(--brand-accent);
  color: var(--surface-inset);
  content: "✓";
}

.project-model-picker {
  margin-top: 5px;
}

.project-model-picker small {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
}

.project-model-picker.create-picker {
  display: flex;
  margin-top: 0;
}

.settings-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}

.modal-section label,
.inline-create {
  display: grid;
  gap: 7px;
}

.inline-create {
  gap: 9px;
}

.settings-empty,
.settings-success,
.control-plane-error {
  margin: 0;
  font-size: 12px;
  font-weight: 650;
}

.settings-empty {
  color: var(--text-muted);
}

.settings-success {
  color: var(--status-success);
}

.control-plane-error {
  color: var(--status-danger);
}

.modal-section .list-filter {
  display: flex;
  grid-template-columns: none;
  align-items: center;
  gap: 7px;
  min-height: 34px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: var(--surface-raised);
  color: var(--text-muted);
  padding: 0 9px;
}

.modal-section .list-filter input {
  width: 100%;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--text-strong);
  font-size: 13px;
  outline: none;
}

.modal-section .list-filter input::placeholder {
  color: var(--text-subtle);
}

.modal-section .local-image-filter {
  margin-bottom: 0;
}

.modal-section .local-image-filter ~ .control-plane-error,
.modal-section .local-image-filter ~ .settings-success,
.modal-section .local-image-filter ~ .local-image-list {
  margin-top: 2px;
}

@media (max-width: 780px) {
  .image-management-grid,
  .project-management-grid,
  .node-management-grid,
  .settings-form-grid {
    grid-template-columns: 1fr;
  }

  .control-settings-page {
    padding: 12px;
  }
}
</style>
