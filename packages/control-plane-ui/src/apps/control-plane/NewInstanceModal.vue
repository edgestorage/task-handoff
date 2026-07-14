<template>
  <Dialog :open="true" @update:open="(open) => !open && $emit('close')">
    <DialogContent class="new-instance-modal" style="width: min(900px, calc(100vw - 36px)); max-width: calc(100vw - 36px)">
      <DialogDescription class="sr-only">Choose a workspace and runtime for the controlled instance.</DialogDescription>
      <div class="modal-head">
        <div>
          <span>New instance</span>
          <DialogTitle>Create controlled instance</DialogTitle>
        </div>
        <DialogClose as-child>
          <button type="button" class="panel-close" aria-label="Close setup panel">
            <X :size="16" />
          </button>
        </DialogClose>
      </div>

      <ScrollArea class="new-instance-body">
        <div class="new-instance-body-content">
      <div class="wizard-layout">
        <nav class="wizard-steps" aria-label="Create instance steps">
          <button v-for="item in wizardSteps" :key="item.id" type="button" :class="{ active: step === item.id, complete: stepIndex(item.id) < activeStepIndex }" @click="goToStep(item.id)">
            <span>{{ stepIndex(item.id) + 1 }}</span>
            <strong>{{ item.label }}</strong>
          </button>
        </nav>

        <div class="wizard-panel">
          <SourceStep
            v-if="step === 'source'"
            v-model:new-project-open="newProjectOpen"
            :can-browse-project-folder="canBrowseProjectFolder"
            :can-create-project="canCreateProject"
            :choose-folder-value="chooseFolderValue"
            :creating-local-folder="creatingLocalFolder"
            :creating-project="creatingProject"
            :loading-node-folder-tree="loadingNodeFolderTree"
            :local-folder-select-value="localFolderSelectValue"
            :local-folders="localFolders.data.value || []"
            :local-path-open="localPathOpen"
            :local-path-placeholder="localPathPlaceholder"
            :new-project="newProject"
            :node-folder-tree-error="nodeFolderTreeError"
            :node-folder-tree-rows="nodeFolderTreeRows"
            :nodes="nodes.data.value || []"
            :project-create-error="projectCreateError"
            :projects="projects.data.value || []"
            :show-node-folder-tree="showNodeFolderTree"
            :source-draft="sourceDraft"
            @choose-project-folder-path="chooseProjectFolderPath"
            @create-project="createQuickProject"
            @load-node-folder-roots="loadNodeFolderRoots"
            @select-local-folder="selectLocalFolder"
            @select-node-folder-path="selectNodeFolderPath"
            @select-source-mode="selectSourceMode"
            @set-local-folder-path="setLocalFolderPath"
          />

          <RuntimeStep
            v-else
            v-model:new-image-open="newImageOpen"
            :can-create-image="canCreateImage"
            :creating-image="creatingImage"
            :images="images.data.value || []"
            :instance-draft="instanceDraft"
            :models="models.data.value || []"
            :new-image="newImage"
            :nodes="nodes.data.value || []"
            :runtime-draft="runtimeDraft"
            :runtimes-for-selected-node="runtimesForSelectedNode"
            :selected-runtime="selectedRuntime"
            :selected-runtime-requires-image="selectedRuntimeRequiresImage"
            :source-summary="sourceSummary"
            @create-image="createQuickImage"
          />
        </div>
      </div>

      <div class="modal-actions">
        <span v-if="currentBlockedReason" class="create-blocked-reason">{{ currentBlockedReason }}</span>
        <Button variant="outline" size="sm" @click="step === 'source' ? $emit('close') : previousStep()">{{ step === "source" ? "Cancel" : "Back" }}</Button>
        <Button v-if="step === 'source'" size="sm" :disabled="!canContinue" @click="nextStep">
          <ArrowRight :size="15" />
          <span>Continue</span>
        </Button>
        <Button v-else size="sm" :disabled="!canCreateInstance || creating" @click="createInstance">
          <Plus :size="15" />
          <span>{{ creating ? "Creating" : "Create & start" }}</span>
        </Button>
      </div>
        </div>
      </ScrollArea>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { ArrowRight, Plus, X } from "@lucide/vue";
import { createControlledInstance, createImage, createProject, listNodeFolderTree, useImagesQuery, useModelsQuery, useNodeLocalFoldersQuery, useNodeRuntimesQuery, useNodesQuery, useProjectsQuery } from "../../api/queries";
import type { InstanceBoardItem } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { ScrollArea } from "../../components/ui/scroll-area";
import RuntimeStep from "./new-instance/RuntimeStep.vue";
import SourceStep from "./new-instance/SourceStep.vue";
import type { NodeFolderTreeNode } from "./new-instance/nodeFolderTree";
import type { InstanceDraft, NewImageDraft, NewProjectDraft, ProjectFolderSelection, RuntimeDraft, SourceDraft, SourceMode, WizardStep } from "./new-instance/newInstanceTypes";
import { nodeFolderSelectionMode, nodePathName } from "./nodePath";
import { useNodeFolderBrowser } from "./useNodeFolderBrowser";
import { showControlPlaneToast } from "./useControlPlaneToasts";

const emit = defineEmits<{
  close: [];
  created: [instance: InstanceBoardItem];
}>();

const props = defineProps<{
  chooseProjectFolder?: () => Promise<ProjectFolderSelection | undefined>;
}>();

const wizardSteps: Array<{ id: WizardStep; label: string }> = [
  { id: "source", label: "Workspace" },
  { id: "runtime", label: "Runtime" },
];
const chooseFolderValue = "__choose_folder__";
const CONTROL_PLANE_LOCAL_NODE_LABEL = "task-handoff.control-plane.local";

const queryClient = useQueryClient();
const projects = useProjectsQuery();
const models = useModelsQuery();
const images = useImagesQuery();
const nodes = useNodesQuery();
const nodeRuntimes = useNodeRuntimesQuery();

const step = ref<WizardStep>("source");
const newProjectOpen = ref(false);
const newImageOpen = ref(false);
const projectCreateError = ref("");
const creating = ref(false);
const creatingProject = ref(false);
const creatingImage = ref(false);
const creatingLocalFolder = ref(false);
const localPathOpen = ref(false);

const sourceDraft = reactive<SourceDraft>({
  mode: "project" as SourceMode,
  projectId: "",
  localNodeId: "",
  localFolderId: "",
  localPath: "",
});
const {
  error: nodeFolderTreeError,
  loadRoots: loadNodeFolderRootsForNode,
  loading: loadingNodeFolderTree,
  reset: resetNodeFolderTree,
  rows: nodeFolderTreeRows,
  selectFolder: expandNodeFolder,
} = useNodeFolderBrowser({
  errorText,
  load: listNodeFolderTree,
  onSelect: setLocalFolderPath,
});
const runtimeDraft = reactive<RuntimeDraft>({
  nodeId: "",
  runtimeId: "",
  imageId: "",
});
const instanceDraft = reactive<InstanceDraft>({
  name: "",
  autoImportAgentConfigs: true,
  codexModelHash: "",
  claudeModelHash: "",
});
const newProject = reactive<NewProjectDraft>({
  name: "",
  url: "",
});
const newImage = reactive<NewImageDraft>({
  name: "",
  image: "",
});
const localFolders = useNodeLocalFoldersQuery(() => sourceDraft.localNodeId);

const activeStepIndex = computed(() => stepIndex(step.value));
const selectedProject = computed(() => (projects.data.value || []).find((project) => project.id === sourceDraft.projectId));
const selectedLocalNode = computed(() => (nodes.data.value || []).find((node) => node.id === sourceDraft.localNodeId));
const selectedLocalFolder = computed(() => (localFolders.data.value || []).find((folder) => folder.id === sourceDraft.localFolderId));
const localFolderPath = computed(() => sourceDraft.localPath.trim());
const localFolderSelectValue = computed(() => (localPathOpen.value || localFolderPath.value ? chooseFolderValue : sourceDraft.localFolderId));
const selectedLocalNodeIsControlPlaneLocal = computed(() => selectedLocalNode.value?.labels[CONTROL_PLANE_LOCAL_NODE_LABEL] === "true");
const folderSelectionMode = computed(() => nodeFolderSelectionMode(selectedLocalNodeIsControlPlaneLocal.value, Boolean(props.chooseProjectFolder)));
const canBrowseProjectFolder = computed(() => folderSelectionMode.value === "native");
const showNodeFolderTree = computed(() => sourceDraft.mode === "local-folder" && localPathOpen.value && Boolean(sourceDraft.localNodeId) && folderSelectionMode.value === "node");
const localPathPlaceholder = computed(() => (folderSelectionMode.value === "native" ? "/Users/me/project" : "/path/to/project/on-node"));
const runtimesForSelectedNode = computed(() => (nodeRuntimes.data.value || []).filter((runtime) => runtime.nodeId === runtimeDraft.nodeId));
const selectedRuntime = computed(() => runtimesForSelectedNode.value.find((runtime) => runtime.id === runtimeDraft.runtimeId));
const selectedRuntimeRequiresImage = computed(() => {
  if (!selectedRuntime.value) {
    return true;
  }
  const requiresImage = selectedRuntime.value.capabilities.requiresImage;
  return typeof requiresImage === "boolean" ? requiresImage : selectedRuntime.value.type !== "local";
});
const sourceSummary = computed(() => {
  if (sourceDraft.mode === "project") {
    return selectedProject.value?.name || "Repository";
  }
  if (selectedLocalFolder.value) {
    return selectedLocalFolder.value.name || selectedLocalFolder.value.path;
  }
  return localFolderPath.value || "Local folder";
});
const sourceBlockedReason = computed(() => {
  if (sourceDraft.mode === "project") {
    return sourceDraft.projectId ? "" : "Select a repository.";
  }
  if (!sourceDraft.localNodeId) {
    return "Select a node.";
  }
  if (!sourceDraft.localFolderId && !localFolderPath.value) {
    return "Select or choose a local folder.";
  }
  return "";
});
const runtimeBlockedReason = computed(() => {
  if (!runtimeDraft.nodeId) {
    return "Select a node.";
  }
  if (!runtimeDraft.runtimeId) {
    return "Select a runtime.";
  }
  if (selectedRuntimeRequiresImage.value && !runtimeDraft.imageId) {
    return "Select an image.";
  }
  return "";
});
const currentBlockedReason = computed(() => {
  if (step.value === "source") {
    return sourceBlockedReason.value;
  }
  if (step.value === "runtime") {
    return runtimeBlockedReason.value;
  }
  return runtimeBlockedReason.value;
});
const canContinue = computed(() => !currentBlockedReason.value);
const canCreateInstance = computed(() => !sourceBlockedReason.value && !runtimeBlockedReason.value);
const canCreateProject = computed(() => Boolean(newProject.name.trim() && newProject.url.trim()));
const canCreateImage = computed(() => Boolean(newImage.name.trim() && newImage.image.trim()));

watch(
  () => projects.data.value,
  (items) => {
    const projectItems = items || [];
    if (sourceDraft.projectId && !projectItems.some((project) => project.id === sourceDraft.projectId)) {
      sourceDraft.projectId = "";
    }
    if (!sourceDraft.projectId && projectItems[0]) {
      sourceDraft.projectId = projectItems[0].id;
    }
  },
  { immediate: true },
);

watch(
  () => nodes.data.value,
  (items) => {
    const nodeItems = items || [];
    if (sourceDraft.localNodeId && !nodeItems.some((node) => node.id === sourceDraft.localNodeId)) {
      sourceDraft.localNodeId = "";
    }
    if (runtimeDraft.nodeId && !nodeItems.some((node) => node.id === runtimeDraft.nodeId)) {
      runtimeDraft.nodeId = "";
    }
    if (!sourceDraft.localNodeId && nodeItems[0]) {
      sourceDraft.localNodeId = nodeItems[0].id;
    }
  },
  { immediate: true },
);

watch(
  () => sourceDraft.localNodeId,
  () => {
    resetNodeFolderTree();
  },
);

watch(
  showNodeFolderTree,
  (open) => {
    if (open && !nodeFolderTreeRows.value.length) {
      void loadNodeFolderRoots();
    }
  },
);

watch(
  () => images.data.value,
  (items) => {
    const imageItems = items || [];
    if (runtimeDraft.imageId && !imageItems.some((image) => image.id === runtimeDraft.imageId)) {
      runtimeDraft.imageId = "";
    }
    if (!runtimeDraft.imageId && imageItems[0]) {
      runtimeDraft.imageId = imageItems[0].id;
    }
  },
  { immediate: true },
);

watch(
  () => nodeRuntimes.data.value,
  () => {
    ensureRuntimeForNode();
  },
  { immediate: true },
);

watch(
  () => sourceDraft.localNodeId,
  () => {
    sourceDraft.localFolderId = "";
    sourceDraft.localPath = "";
    localPathOpen.value = false;
  },
);

watch(
  () => localFolders.data.value,
  (items) => {
    if (sourceDraft.localFolderId && !(items || []).some((folder) => folder.id === sourceDraft.localFolderId)) {
      sourceDraft.localFolderId = "";
    }
    if (sourceDraft.mode === "local-folder" && !sourceDraft.localFolderId && !sourceDraft.localPath && !localPathOpen.value && items?.[0]) {
      sourceDraft.localFolderId = items[0].id;
    }
  },
  { immediate: true },
);

watch(
  () => sourceDraft.localFolderId,
  (folderId) => {
    if (folderId) {
      sourceDraft.localPath = "";
    }
  },
);

watch(
  () => runtimeDraft.nodeId,
  () => {
    ensureRuntimeForNode();
  },
);

watch(
  () => runtimeDraft.runtimeId,
  () => {
    if (!selectedRuntimeRequiresImage.value) {
      runtimeDraft.imageId = "";
      newImageOpen.value = false;
      return;
    }
    if (!runtimeDraft.imageId) {
      runtimeDraft.imageId = images.data.value?.[0]?.id || "";
    }
  },
);

watch(
  () => models.data.value,
  (items) => {
    const modelIds = new Set((items || []).map((model) => model.id));
    if (instanceDraft.codexModelHash && !modelIds.has(instanceDraft.codexModelHash)) {
      instanceDraft.codexModelHash = "";
    }
    if (instanceDraft.claudeModelHash && !modelIds.has(instanceDraft.claudeModelHash)) {
      instanceDraft.claudeModelHash = "";
    }
  },
  { immediate: true },
);

function stepIndex(value: WizardStep) {
  return wizardSteps.findIndex((item) => item.id === value);
}

function selectSourceMode(mode: SourceMode) {
  sourceDraft.mode = mode;
  projectCreateError.value = "";
  if (mode === "local-folder") {
    newProjectOpen.value = false;
  }
}

function selectLocalFolder(value: string) {
  projectCreateError.value = "";
  if (value === chooseFolderValue) {
    sourceDraft.localFolderId = "";
    localPathOpen.value = true;
    if (canBrowseProjectFolder.value) {
      void chooseProjectFolderPath();
    } else {
      void loadNodeFolderRoots();
    }
    return;
  }
  sourceDraft.localFolderId = value;
  sourceDraft.localPath = "";
  localPathOpen.value = false;
}

function goToStep(target: WizardStep) {
  if (stepIndex(target) <= activeStepIndex.value) {
    step.value = target;
    return;
  }
  if (target === "runtime" && !sourceBlockedReason.value) {
    deriveRuntimeDefaults();
    step.value = "runtime";
    return;
  }
}

function nextStep() {
  if (!canContinue.value) {
    return;
  }
  if (step.value === "source") {
    deriveRuntimeDefaults();
    step.value = "runtime";
    return;
  }
}

function previousStep() {
  const index = activeStepIndex.value;
  if (index > 0) {
    step.value = wizardSteps[index - 1].id;
  }
}

function deriveRuntimeDefaults() {
  const firstNodeId = nodes.data.value?.[0]?.id || "";
  const firstImageId = images.data.value?.[0]?.id || "";
  if (sourceDraft.mode === "project") {
    const project = selectedProject.value;
    const nodeId = project?.defaultNodeId || runtimeDraft.nodeId || firstNodeId;
    runtimeDraft.nodeId = nodeId;
    runtimeDraft.runtimeId = runtimeIdForNode(nodeId, project?.defaultRuntimeId || runtimeDraft.runtimeId);
    runtimeDraft.imageId = selectedRuntimeRequiresImage.value ? project?.defaultImageId || runtimeDraft.imageId || firstImageId : "";
    return;
  }
  runtimeDraft.nodeId = sourceDraft.localNodeId || runtimeDraft.nodeId || firstNodeId;
  runtimeDraft.runtimeId = runtimeIdForNode(runtimeDraft.nodeId, runtimeDraft.runtimeId);
  runtimeDraft.imageId = selectedRuntimeRequiresImage.value ? selectedLocalFolder.value?.defaultImageId || runtimeDraft.imageId || firstImageId : "";
}

function ensureRuntimeForNode() {
  if (!runtimeDraft.nodeId) {
    return;
  }
  runtimeDraft.runtimeId = runtimeIdForNode(runtimeDraft.nodeId, runtimeDraft.runtimeId);
  if (!selectedRuntimeRequiresImage.value) {
    runtimeDraft.imageId = "";
    newImageOpen.value = false;
  }
}

function runtimeIdForNode(nodeId: string, preferredId?: string) {
  const runtimeItems = nodeRuntimes.data.value || [];
  if (preferredId && runtimeItems.some((runtime) => runtime.id === preferredId && runtime.nodeId === nodeId)) {
    return preferredId;
  }
  return runtimeItems.find((runtime) => runtime.nodeId === nodeId)?.id || "";
}

async function refresh() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["control-plane-status"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-projects"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-models"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-images"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-nodes"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-node-local-folders"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-node-runtimes"] }),
    queryClient.invalidateQueries({ queryKey: ["instance-board"] }),
  ]);
}

async function refreshAfterMutation(description: string) {
  try {
    await refresh();
  } catch (error) {
    showControlPlaneToast(`${description}, but the control-plane view could not refresh: ${errorText(error)}`);
  }
}

async function createInstance() {
  if (!canCreateInstance.value || creating.value) {
    return;
  }
  creating.value = true;
  let created: InstanceBoardItem;
  try {
    created = await createControlledInstance({
      ...(sourceDraft.mode === "project"
        ? { projectId: sourceDraft.projectId }
        : {
            source: {
              type: "local-folder",
              ...(selectedLocalFolder.value ? { localFolderId: selectedLocalFolder.value.id } : {}),
              path: selectedLocalFolder.value?.path || localFolderPath.value,
              ownerNodeId: sourceDraft.localNodeId,
            },
            sourceSnapshot: selectedLocalFolder.value
              ? { ...selectedLocalFolder.value }
              : {
                  name: nodePathName(localFolderPath.value),
                  path: localFolderPath.value,
                },
          }),
      ...(selectedRuntimeRequiresImage.value ? { imageId: runtimeDraft.imageId } : {}),
      nodeId: runtimeDraft.nodeId,
      runtimeId: runtimeDraft.runtimeId,
      config: {
        autoImportAgentConfigs: instanceDraft.autoImportAgentConfigs,
      },
      modelSelection: {
        ...(instanceDraft.codexModelHash ? { codexModelHash: instanceDraft.codexModelHash } : {}),
        ...(instanceDraft.claudeModelHash ? { claudeModelHash: instanceDraft.claudeModelHash } : {}),
      },
      ...(instanceDraft.name.trim() ? { name: instanceDraft.name.trim() } : {}),
    });
    instanceDraft.name = "";
    instanceDraft.autoImportAgentConfigs = true;
    instanceDraft.codexModelHash = "";
    instanceDraft.claudeModelHash = "";
  } catch (error) {
    showControlPlaneToast(errorText(error));
    return;
  } finally {
    creating.value = false;
  }
  emit("created", created);
  emit("close");
  await refreshAfterMutation("Instance created");
}

async function createQuickProject() {
  if (!canCreateProject.value || creatingProject.value) {
    return;
  }
  creatingProject.value = true;
  projectCreateError.value = "";
  let createdProjectName = "Project created";
  try {
    const firstNodeId = nodes.data.value?.[0]?.id;
    const project = await createProject({
      name: newProject.name.trim(),
      source: {
        type: "git-repository",
        url: newProject.url.trim(),
        ref: { type: "branch", name: "main" },
        auth: { type: "none" },
        clone: { submodules: false, lfs: false, subdirectory: "" },
      },
      defaultImageId: images.data.value?.[0]?.id,
      defaultNodeId: firstNodeId,
      defaultRuntimeId: nodeRuntimes.data.value?.find((runtime) => runtime.nodeId === firstNodeId)?.id,
    });
    newProject.name = "";
    newProject.url = "";
    newProjectOpen.value = false;
    sourceDraft.mode = "project";
    sourceDraft.projectId = project.id;
    runtimeDraft.imageId = project.defaultImageId || images.data.value?.[0]?.id || "";
    runtimeDraft.nodeId = project.defaultNodeId || nodes.data.value?.[0]?.id || "";
    runtimeDraft.runtimeId = project.defaultRuntimeId || runtimeIdForNode(runtimeDraft.nodeId);
    createdProjectName = `${project.name} created`;
  } catch (error) {
    showControlPlaneToast(errorText(error));
    return;
  } finally {
    creatingProject.value = false;
  }
  await refreshAfterMutation(createdProjectName);
}

async function chooseProjectFolderPath() {
  if (!canBrowseProjectFolder.value) {
    localPathOpen.value = true;
    return;
  }
  const selected = await props.chooseProjectFolder?.();
  if (!selected) {
    return;
  }
  const path = typeof selected === "string" ? selected : selected.path;
  const ownerNodeId = typeof selected === "string" ? sourceDraft.localNodeId : selected.ownerNodeId || sourceDraft.localNodeId;
  if (!ownerNodeId) {
    projectCreateError.value = "Select a node.";
    return;
  }
  creatingLocalFolder.value = true;
  try {
    if (sourceDraft.localNodeId !== ownerNodeId) {
      sourceDraft.localNodeId = ownerNodeId;
      await nextTick();
    }
    sourceDraft.localFolderId = "";
    sourceDraft.localPath = path;
  } catch (error) {
    showControlPlaneToast(errorText(error));
  } finally {
    creatingLocalFolder.value = false;
  }
}

function setLocalFolderPath(value: string) {
  sourceDraft.localPath = value;
  localPathOpen.value = true;
  if (value.trim()) {
    sourceDraft.localFolderId = "";
  }
}

async function loadNodeFolderRoots() {
  await loadNodeFolderRootsForNode(sourceDraft.localNodeId);
}

async function selectNodeFolderPath(folder: NodeFolderTreeNode) {
  await expandNodeFolder(folder);
}

async function createQuickImage() {
  if (!canCreateImage.value || creatingImage.value) {
    return;
  }
  creatingImage.value = true;
  let createdImageName = "Image created";
  try {
    const image = await createImage({
      name: newImage.name.trim(),
      image: newImage.image.trim(),
      registry: "local",
      capabilities: [],
      optionalApps: [],
      defaultEnv: {},
      labels: {},
    });
    newImage.name = "";
    newImage.image = "";
    newImageOpen.value = false;
    runtimeDraft.imageId = image.id;
    createdImageName = `${image.name} created`;
  } catch (error) {
    showControlPlaneToast(errorText(error));
    return;
  } finally {
    creatingImage.value = false;
  }
  await refreshAfterMutation(createdImageName);
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
</script>

<style scoped>
:global(.new-instance-modal) {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  width: min(900px, calc(100vw - 36px)) !important;
  max-width: calc(100vw - 36px) !important;
  max-height: calc(100vh - 36px);
  overflow: hidden;
  gap: 12px !important;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-inset);
  color: var(--text);
  box-shadow: var(--shadow-popover);
  padding: 14px !important;
}

.new-instance-body {
  min-height: 0;
}

.new-instance-body-content {
  display: grid;
  gap: 12px;
  min-height: 100%;
  padding-right: 2px;
}

.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.modal-head div {
  display: grid;
  gap: 2px;
}

.modal-head span {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: 0;
  text-transform: uppercase;
}

.modal-head strong {
  color: var(--text-strong);
  font-size: 19px;
}

.panel-close {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: var(--surface-hover);
  color: var(--brand-accent-muted);
  cursor: pointer;
}

.panel-close:hover,
.panel-close:focus-visible {
  background: var(--surface-active);
  color: var(--white);
  outline: none;
}

.wizard-layout {
  display: grid;
  grid-template-columns: 170px minmax(0, 1fr);
  min-height: 410px;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-inset);
}

.wizard-steps {
  display: grid;
  align-content: start;
  gap: 6px;
  border-right: 1px solid var(--line);
  background: var(--surface-inset);
  padding: 10px;
}

.wizard-steps button {
  display: grid;
  grid-template-columns: 25px minmax(0, 1fr);
  align-items: center;
  gap: 9px;
  min-height: 42px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
  padding: 7px;
}

.wizard-steps button:hover,
.wizard-steps button:focus-visible,
.wizard-steps button.active {
  border-color: var(--line-strong);
  background: var(--surface-raised);
  color: var(--white);
  outline: none;
}

.wizard-steps button.complete {
  color: var(--brand-accent-muted);
}

.wizard-steps span {
  display: grid;
  width: 25px;
  height: 25px;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  color: inherit;
  font-size: 12px;
  font-weight: 850;
}

.wizard-steps strong {
  overflow: hidden;
  font-size: 13px;
  font-weight: 800;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wizard-panel {
  min-width: 0;
  padding: 14px;
}

.modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.create-blocked-reason {
  min-width: 0;
  margin-right: auto;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 650;
}

@media (max-width: 820px) {
  .new-instance-modal {
    align-self: end;
    width: 100%;
    max-height: calc(100vh - 24px);
  }

  .wizard-layout {
    grid-template-columns: 1fr;
  }

  .wizard-steps {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }

  .wizard-steps button {
    grid-template-columns: 1fr;
    justify-items: center;
    text-align: center;
  }

  .modal-actions {
    flex-wrap: wrap;
  }

  .create-blocked-reason {
    width: 100%;
  }
}
</style>
