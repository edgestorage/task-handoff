<template>
  <Dialog :open="true" @update:open="requestClose">
    <DialogContent class="new-instance-modal" style="width: min(900px, calc(100vw - 36px)); max-width: calc(100vw - 36px)" :aria-busy="creating">
      <DialogDescription class="sr-only">{{ t("instances.create.description") }}</DialogDescription>
      <div class="modal-head">
        <div>
          <span>{{ t("instances.create.eyebrow") }}</span>
          <DialogTitle>{{ t("instances.create.title") }}</DialogTitle>
        </div>
        <DialogClose as-child>
          <button type="button" class="panel-close" :aria-label="t('instances.create.close')" :disabled="creating">
            <X :size="16" />
          </button>
        </DialogClose>
      </div>

      <ScrollArea class="new-instance-body">
        <div class="new-instance-body-content">
          <fieldset class="new-instance-fields" :disabled="creating">
            <div class="wizard-layout">
              <nav class="wizard-steps" :aria-label="t('instances.create.stepsLabel')">
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
                  :docker-runtime-check-message="dockerRuntimeCheckMessage"
                  :docker-runtime-check-state="dockerRuntimeCheck.state"
                  :environment-templates="environmentTemplates.data.value || []"
                  :images="imageOptions.data.value || []"
                  :image-availability="imageAvailability.data.value || []"
                  :instance-draft="instanceDraft"
                  :models="models.data.value || []"
                  :new-image="newImage"
                  :nodes="nodes.data.value || []"
                  :runtime-draft="runtimeDraft"
                  :runtimes-for-selected-node="runtimesForSelectedNode"
                  :selected-runtime="selectedRuntime"
                  :selected-runtime-requires-image="selectedRuntimeRequiresImage"
                  :selected-node-platform="dockerRuntimeCheck.platform || selectedNodePlatform"
                  :source-summary="sourceSummary"
                  @check-docker-runtime="checkSelectedDockerRuntime"
                  @create-image="createQuickImage"
                />
              </div>
            </div>
          </fieldset>

          <div class="modal-actions">
            <span v-if="currentBlockedReason" class="create-blocked-reason">{{ currentBlockedReason }}</span>
            <Button variant="outline" size="sm" :disabled="creating" @click="step === 'source' ? $emit('close') : previousStep()">{{ step === "source" ? t("instances.create.cancel") : t("instances.create.back") }}</Button>
            <Button v-if="step === 'source'" size="sm" :disabled="!canContinue || creating" @click="nextStep">
              <ArrowRight :size="15" />
              <span>{{ t("instances.create.continue") }}</span>
            </Button>
            <Button v-else size="sm" :disabled="!canCreateInstance || creating" :aria-label="t(creating ? 'instances.create.creating' : 'instances.create.create')" @click="createInstance">
              <LoaderCircle v-if="creating" class="animate-spin motion-reduce:animate-none" :size="15" />
              <Plus v-else :size="15" />
              <span>{{ creating ? t("instances.create.creating") : t("instances.create.create") }}</span>
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
import { ArrowRight, LoaderCircle, Plus, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { translateApiError } from "../../i18n/apiError";
import { checkNodeRuntime, createControlledInstance, createImage, createProject, listNodeFolderTree, useEnvironmentTemplatesQuery, useImageOptionsQuery, useModelsQuery, useNodeImageAvailabilityQuery, useNodeLocalFoldersQuery, useNodeRuntimesQuery, useNodesQuery, useProjectsQuery } from "../../api/queries";
import { controlPlaneQueryKeys } from "../../api/queryKeys.ts";
import type { CreateControlledInstanceResult, InstanceBoardItem } from "../../api/types";
import { Button } from "../../components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { ScrollArea } from "../../components/ui/scroll-area";
import RuntimeStep from "./new-instance/RuntimeStep.vue";
import SourceStep from "./new-instance/SourceStep.vue";
import { dockerDaemonDetails, nodePlatform, type DockerRuntimeCheckState } from "./new-instance/dockerRuntimeGuidance";
import type { NodeFolderTreeNode } from "./new-instance/nodeFolderTree";
import type { InstanceDraft, NewImageDraft, NewProjectDraft, ProjectFolderSelection, RuntimeDraft, SourceDraft, SourceMode, WizardStep } from "./new-instance/newInstanceTypes";
import { nodeFolderSelectionMode, nodePathName } from "./nodePath";
import { useNodeFolderBrowser } from "./useNodeFolderBrowser";
import { showControlPlaneToast } from "./useControlPlaneToasts";

const { t } = useI18n();

const emit = defineEmits<{
  close: [];
  created: [instance: InstanceBoardItem];
}>();

const props = defineProps<{
  chooseProjectFolder?: () => Promise<ProjectFolderSelection | undefined>;
}>();

const wizardSteps = computed<Array<{ id: WizardStep; label: string }>>(() => [
  { id: "source", label: t("instances.create.workspace") },
  { id: "runtime", label: t("instances.create.runtime") },
]);
const chooseFolderValue = "__choose_folder__";
const CONTROL_PLANE_LOCAL_NODE_LABEL = "task-handoff.control-plane.local";

const queryClient = useQueryClient();
const projects = useProjectsQuery();
const models = useModelsQuery();
const imageOptions = useImageOptionsQuery();
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

function requestClose(open: boolean) {
  if (!open && !creating.value) {
    emit("close");
  }
}

const dockerRuntimeCheck = reactive<{ key: string; state: DockerRuntimeCheckState; rawMessage: string; serverVersion: string; platform: string }>({
  key: "",
  state: "idle",
  rawMessage: "",
  serverVersion: "",
  platform: "",
});

const sourceDraft = reactive<SourceDraft>({
  mode: "local-folder" as SourceMode,
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
  environmentSourceType: "image",
  environmentTemplateId: "",
  imageId: "",
  imageTag: "",
});
const imageAvailability = useNodeImageAvailabilityQuery(() => runtimeDraft.nodeId);
const environmentTemplates = useEnvironmentTemplatesQuery(() => runtimeDraft.nodeId);
const instanceDraft = reactive<InstanceDraft>({
  name: "",
  autoImportAgentConfigs: false,
  codexModelHash: null,
  claudeModelHash: null,
});
const newProject = reactive<NewProjectDraft>({
  name: "",
  url: "",
});
const newImage = reactive<NewImageDraft>({
  name: "",
  reference: "",
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
const selectedNode = computed(() => (nodes.data.value || []).find((node) => node.id === runtimeDraft.nodeId));
const selectedNodePlatform = computed(() => nodePlatform(selectedNode.value));
const selectedRuntime = computed(() => runtimesForSelectedNode.value.find((runtime) => runtime.id === runtimeDraft.runtimeId));
const selectedDockerRuntimeKey = computed(() => selectedRuntime.value?.type === "docker" ? `${runtimeDraft.nodeId}:${selectedRuntime.value.id}` : "");
const dockerRuntimeCheckMessage = computed(() => {
  if (dockerRuntimeCheck.rawMessage) return dockerRuntimeCheck.rawMessage;
  if (dockerRuntimeCheck.state === "checking") return t("instances.create.docker.checkingDaemon");
  if (dockerRuntimeCheck.state === "online") {
    return dockerRuntimeCheck.serverVersion
      ? t("instances.create.docker.daemonVersionAvailable", { version: dockerRuntimeCheck.serverVersion })
      : t("instances.create.docker.daemonAvailable");
  }
  if (dockerRuntimeCheck.state === "offline") return t("instances.create.docker.daemonUnavailable");
  return "";
});
const selectedRuntimeRequiresImage = computed(() => {
  if (!selectedRuntime.value) {
    return true;
  }
  const requiresImage = selectedRuntime.value.capabilities.requiresImage;
  return typeof requiresImage === "boolean" ? requiresImage : selectedRuntime.value.type !== "local";
});
const sourceSummary = computed(() => {
  if (sourceDraft.mode === "project") {
    return selectedProject.value?.name || t("instances.create.repository");
  }
  if (selectedLocalFolder.value) {
    return selectedLocalFolder.value.name || selectedLocalFolder.value.path;
  }
  return localFolderPath.value || t("instances.create.localFolder");
});
const sourceBlockedReason = computed(() => {
  if (sourceDraft.mode === "project") {
    return sourceDraft.projectId ? "" : t("instances.create.blocked.repository");
  }
  if (!sourceDraft.localNodeId) {
    return t("instances.create.blocked.node");
  }
  if (!sourceDraft.localFolderId && !localFolderPath.value) {
    return t("instances.create.blocked.localFolder");
  }
  return "";
});
const runtimeBlockedReason = computed(() => {
  if (!runtimeDraft.nodeId) {
    return t("instances.create.blocked.node");
  }
  if (!runtimeDraft.runtimeId) {
    return t("instances.create.blocked.runtime");
  }
  if (selectedRuntime.value?.type === "docker") {
    if (dockerRuntimeCheck.key !== selectedDockerRuntimeKey.value || dockerRuntimeCheck.state === "idle" || dockerRuntimeCheck.state === "checking") {
      return t("instances.create.blocked.dockerChecking");
    }
    if (dockerRuntimeCheck.state !== "online") {
      return t("instances.create.blocked.dockerUnavailable");
    }
  }
  if (selectedRuntimeRequiresImage.value && runtimeDraft.environmentSourceType === "image" && !runtimeDraft.imageId) {
    return t("instances.create.blocked.image");
  }
  if (selectedRuntimeRequiresImage.value && runtimeDraft.environmentSourceType === "template" && !runtimeDraft.environmentTemplateId) {
    return t("instances.create.blocked.environmentTemplate");
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
const canCreateImage = computed(() => Boolean(newImage.name.trim() && newImage.reference.trim()));

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
  () => imageOptions.data.value,
  (items) => {
    const imageItems = items || [];
    if (runtimeDraft.imageId && !imageItems.some((image) => image.id === runtimeDraft.imageId)) {
      runtimeDraft.imageId = "";
    }
    if (!runtimeDraft.imageId && imageItems[0]) {
      runtimeDraft.imageId = imageItems[0].id;
    }
    const selected = imageItems.find((image) => image.id === runtimeDraft.imageId);
    if (selected?.origin === "market" && !selected.availableTags.some((tag) => tag.name === runtimeDraft.imageTag && tag.status !== "yanked")) {
      runtimeDraft.imageTag = selected.tag || selected.availableTags.find((tag) => tag.status !== "yanked")?.name || "";
    } else if (selected?.origin !== "market") {
      runtimeDraft.imageTag = "";
    }
  },
  { immediate: true },
);

watch(
  () => runtimeDraft.imageId,
  (imageId) => {
    const selected = imageOptions.data.value?.find((image) => image.id === imageId);
    runtimeDraft.imageTag = selected?.origin === "market"
      ? selected.tag || selected.availableTags.find((tag) => tag.status !== "yanked")?.name || ""
      : "";
  },
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
    runtimeDraft.environmentTemplateId = "";
  },
);

watch(
  () => environmentTemplates.data.value,
  (items) => {
    const ready = (items || []).filter((template) => template.status === "ready");
    if (runtimeDraft.environmentTemplateId && !ready.some((template) => template.id === runtimeDraft.environmentTemplateId)) {
      runtimeDraft.environmentTemplateId = "";
    }
    if (runtimeDraft.environmentSourceType === "template" && !runtimeDraft.environmentTemplateId) {
      runtimeDraft.environmentTemplateId = ready[0]?.id || "";
    }
  },
  { immediate: true },
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
      runtimeDraft.imageId = imageOptions.data.value?.[0]?.id || "";
    }
  },
);

watch(
  [() => step.value, selectedDockerRuntimeKey],
  ([currentStep, key]) => {
    dockerRuntimeCheck.key = key;
    dockerRuntimeCheck.state = "idle";
    dockerRuntimeCheck.rawMessage = "";
    dockerRuntimeCheck.serverVersion = "";
    dockerRuntimeCheck.platform = "";
    if (currentStep === "runtime" && key) {
      void checkSelectedDockerRuntime();
    }
  },
  { immediate: true },
);

watch(
  () => models.data.value,
  (items) => {
    const modelIds = new Set((items || []).map((model) => model.id));
    if (typeof instanceDraft.codexModelHash === "string" && !modelIds.has(instanceDraft.codexModelHash)) {
      instanceDraft.codexModelHash = null;
    }
    if (typeof instanceDraft.claudeModelHash === "string" && !modelIds.has(instanceDraft.claudeModelHash)) {
      instanceDraft.claudeModelHash = null;
    }
  },
  { immediate: true },
);

function stepIndex(value: WizardStep) {
  return wizardSteps.value.findIndex((item) => item.id === value);
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
    step.value = wizardSteps.value[index - 1].id;
  }
}

function deriveRuntimeDefaults() {
  const firstNodeId = nodes.data.value?.[0]?.id || "";
  const firstImageId = imageOptions.data.value?.[0]?.id || "";
  if (sourceDraft.mode === "project") {
    const project = selectedProject.value;
    const nodeId = project?.defaultNodeId || runtimeDraft.nodeId || firstNodeId;
    runtimeDraft.nodeId = nodeId;
    runtimeDraft.runtimeId = runtimeIdForNode(nodeId, runtimeDraft.runtimeId);
    runtimeDraft.imageId = selectedRuntimeRequiresImage.value ? project?.defaultImageSelection?.imageId || runtimeDraft.imageId || firstImageId : "";
    return;
  }
  runtimeDraft.nodeId = sourceDraft.localNodeId || runtimeDraft.nodeId || firstNodeId;
  runtimeDraft.runtimeId = runtimeIdForNode(runtimeDraft.nodeId, runtimeDraft.runtimeId);
  runtimeDraft.imageId = selectedRuntimeRequiresImage.value ? runtimeDraft.imageId || firstImageId : "";
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

async function checkSelectedDockerRuntime() {
  const runtime = selectedRuntime.value;
  const key = selectedDockerRuntimeKey.value;
  if (!runtime || runtime.type !== "docker" || !key || dockerRuntimeCheck.state === "checking") {
    return;
  }
  dockerRuntimeCheck.key = key;
  dockerRuntimeCheck.state = "checking";
  dockerRuntimeCheck.rawMessage = "";
  dockerRuntimeCheck.serverVersion = "";
  try {
    const checked = await checkNodeRuntime(runtimeDraft.nodeId, runtime.id);
    if (selectedDockerRuntimeKey.value !== key) return;
    const details = dockerDaemonDetails(checked);
    dockerRuntimeCheck.platform = details.hostPlatform || "";
    if (checked.status === "online") {
      dockerRuntimeCheck.state = "online";
      dockerRuntimeCheck.serverVersion = details.serverVersion || "";
    } else {
      dockerRuntimeCheck.state = "offline";
      dockerRuntimeCheck.rawMessage = details.error || "";
    }
    await queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.nodeRuntimes });
  } catch (error) {
    if (selectedDockerRuntimeKey.value !== key) return;
    dockerRuntimeCheck.state = "error";
    dockerRuntimeCheck.rawMessage = errorText(error);
  }
}

async function refresh() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["control-plane-status"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-projects"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-models"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-images"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-nodes"] }),
    queryClient.invalidateQueries({ queryKey: ["control-plane-node-local-folders"] }),
    queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.nodeRuntimes }),
    queryClient.invalidateQueries({ queryKey: controlPlaneQueryKeys.instanceBoard }),
  ]);
}

async function refreshAfterMutation(description: string) {
  try {
    await refresh();
  } catch (error) {
    showControlPlaneToast(t("instances.create.feedback.refreshFailed", { description, error: errorText(error) }));
  }
}

async function createInstance() {
  if (!canCreateInstance.value || creating.value) {
    return;
  }
  creating.value = true;
  let created: CreateControlledInstanceResult;
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
      ...(selectedRuntimeRequiresImage.value
        ? {
            environmentSource: runtimeDraft.environmentSourceType === "template"
              ? { type: "template" as const, environmentTemplateId: runtimeDraft.environmentTemplateId }
              : { type: "image" as const, imageSelection: { imageId: runtimeDraft.imageId, ...(runtimeDraft.imageTag ? { tag: runtimeDraft.imageTag } : {}) } },
          }
        : {}),
      nodeId: runtimeDraft.nodeId,
      runtimeId: runtimeDraft.runtimeId,
      config: {
        autoImportAgentConfigs: instanceDraft.autoImportAgentConfigs,
      },
      modelSelection: {
        ...(instanceDraft.codexModelHash !== undefined ? { codexModelHash: instanceDraft.codexModelHash } : {}),
        ...(instanceDraft.claudeModelHash !== undefined ? { claudeModelHash: instanceDraft.claudeModelHash } : {}),
      },
      start: true,
      ...(instanceDraft.name.trim() ? { name: instanceDraft.name.trim() } : {}),
    });
    instanceDraft.name = "";
    instanceDraft.autoImportAgentConfigs = false;
    instanceDraft.codexModelHash = null;
    instanceDraft.claudeModelHash = null;
  } catch (error) {
    showControlPlaneToast(errorText(error));
    return;
  } finally {
    creating.value = false;
  }
  emit("created", created);
  emit("close");
  await refreshAfterMutation(t("instances.create.feedback.instanceCreated"));
  if (created.startOutcome.status === "failed") {
    showControlPlaneToast(t("instances.create.feedback.createdButStartFailed", { error: created.startOutcome.error?.message || t("common.status.unknown") }));
  }
}

async function createQuickProject() {
  if (!canCreateProject.value || creatingProject.value) {
    return;
  }
  creatingProject.value = true;
  projectCreateError.value = "";
  let createdProjectName = t("instances.create.feedback.projectCreated");
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
      defaultImageSelection: imageOptions.data.value?.[0] ? { imageId: imageOptions.data.value[0].id } : undefined,
      defaultNodeId: firstNodeId,
    });
    newProject.name = "";
    newProject.url = "";
    newProjectOpen.value = false;
    sourceDraft.mode = "project";
    sourceDraft.projectId = project.id;
    runtimeDraft.imageId = project.defaultImageSelection?.imageId || imageOptions.data.value?.[0]?.id || "";
    runtimeDraft.nodeId = project.defaultNodeId || nodes.data.value?.[0]?.id || "";
    runtimeDraft.runtimeId = runtimeIdForNode(runtimeDraft.nodeId);
    createdProjectName = t("instances.create.feedback.namedCreated", { name: project.name });
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
    projectCreateError.value = t("instances.create.blocked.node");
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
  let createdImageName = t("instances.create.feedback.imageCreated");
  try {
    const image = await createImage({
      name: newImage.name.trim(),
      reference: newImage.reference.trim(),
      pullPolicy: "if-not-present",
      capabilities: [],
      optionalApps: [],
      defaultEnv: {},
      labels: {},
    });
    newImage.name = "";
    newImage.reference = "";
    newImageOpen.value = false;
    runtimeDraft.imageId = image.id;
    createdImageName = t("instances.create.feedback.namedCreated", { name: image.name });
  } catch (error) {
    showControlPlaneToast(errorText(error));
    return;
  } finally {
    creatingImage.value = false;
  }
  await refreshAfterMutation(createdImageName);
}

function errorText(error: unknown) {
  return translateApiError(error, t);
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
  color: var(--text-strong);
  outline: none;
}

.panel-close:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.new-instance-fields {
  min-width: 0;
  margin: 0;
  border: 0;
  padding: 0;
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
  color: var(--text-strong);
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
