import { computed, ref, watch, type Ref } from "vue";
import { checkNodeRuntime, createNodeLocalFolder, deleteNodeLocalFolder, deleteNodeRuntime, listNodeFolderTree, useNodeLocalFoldersQuery } from "../../../api/queries";
import type { InstanceBoardItem, Node, NodeRuntime, SelectableImage } from "../../../api/types";
import { nativeNodeFolderSelectionResult, nodeFolderSelectionMode, nodePathName } from "../nodePath";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { useNodeStorageFolderPicker } from "./useNodeStorageFolderPicker";
import type { Translate } from "../../../i18n/status.ts";
import { translateApiError } from "../../../i18n/apiError.ts";

type ChooseProjectFolder = () => Promise<string | { path: string; ownerNodeId?: string } | undefined>;

type UseNodeResourceSettingsInput = {
  chooseProjectFolder?: ChooseProjectFolder;
  clearDefaultRuntime: (runtimeId: string) => void;
  errorText: (error: unknown) => string;
  instances: Ref<InstanceBoardItem[] | undefined>;
  imageOptions: Ref<SelectableImage[] | undefined>;
  nodes: Ref<Node[] | undefined>;
  refreshFolders: () => Promise<void>;
  refreshRuntimeState: () => Promise<void>;
  runtimes: Ref<NodeRuntime[] | undefined>;
  translate: Translate;
};

const CONTROL_PLANE_LOCAL_NODE_LABEL = "task-handoff.control-plane.local";
const CONTROL_PLANE_BUILTIN_NODE_LABEL = "task-handoff.control-plane.builtin";

export function useNodeResourceSettings({ chooseProjectFolder, clearDefaultRuntime, errorText, imageOptions, instances, nodes, refreshFolders, refreshRuntimeState, runtimes, translate: t }: UseNodeResourceSettingsInput) {
  const translateError = (error: unknown) => translateApiError(error, t, errorText(error));
  const selectedNodeId = ref("");
  const creatingNodeLocalFolder = ref(false);
  const deletingNodeLocalFolderId = ref("");
  const checkingRuntimeId = ref("");
  const deletingRuntimeId = ref("");
  const nodeFolderDefaultImageId = ref("");
  const nodeLocalFolders = useNodeLocalFoldersQuery(() => selectedNodeId.value);

  const orderedNodes = computed(() => [...(nodes.value || [])].sort((a, b) => Number(isControlPlaneLocalNode(b)) - Number(isControlPlaneLocalNode(a)) || a.name.localeCompare(b.name)));
  const selectedNode = computed(() => (nodes.value || []).find((node) => node.id === selectedNodeId.value) || orderedNodes.value[0]);
  const localNodeId = computed(() => (nodes.value || []).find(isControlPlaneLocalNode)?.id || orderedNodes.value[0]?.id || "");
  const selectedNodeRuntimes = computed(() => selectedNode.value ? (runtimes.value || []).filter((runtime) => runtime.nodeId === selectedNode.value?.id) : []);
  const selectedNodeInstances = computed(() => selectedNode.value ? (instances.value || []).filter((instance) => instance.nodeId === selectedNode.value?.id) : []);
  const selectedNodeIsLocal = computed(() => Boolean(selectedNode.value && isControlPlaneLocalNode(selectedNode.value)));
  const folderSelectionMode = computed(() => nodeFolderSelectionMode(Boolean(selectedNode.value && isControlPlaneLocalNode(selectedNode.value) && isControlPlaneBuiltinNode(selectedNode.value)), Boolean(chooseProjectFolder)));
  const storageFolderPicker = useNodeStorageFolderPicker({
    createFolder: (nodeId, input) => createNodeLocalFolder(nodeId, {
      ...input,
      ...(nodeFolderDefaultImageId.value ? { defaultImageSelection: { imageId: nodeFolderDefaultImageId.value } } : {}),
    }),
    errorText,
    loadFolders: listNodeFolderTree,
    refresh: refreshFolders,
    translate: t,
  });

  watch(
    nodes,
    (items) => {
      const nodeItems = items || [];
      if (selectedNodeId.value && nodeItems.some((node) => node.id === selectedNodeId.value)) {
        return;
      }
      selectedNodeId.value = nodeItems.find(isControlPlaneLocalNode)?.id || nodeItems[0]?.id || "";
    },
    { immediate: true },
  );

  watch(selectedNodeId, (nodeId, previousNodeId) => {
    if (previousNodeId && nodeId !== previousNodeId) storageFolderPicker.close();
  });

  async function checkRuntime(runtime: NodeRuntime) {
    if (!selectedNode.value || checkingRuntimeId.value) {
      return;
    }
    checkingRuntimeId.value = runtime.id;
    try {
      await checkNodeRuntime(selectedNode.value.id, runtime.id);
      await refreshRuntimeState();
    } catch (error) {
      showControlPlaneToast(translateError(error));
    } finally {
      checkingRuntimeId.value = "";
    }
  }

  async function removeRuntime(runtime: NodeRuntime) {
    if (!selectedNode.value || deletingRuntimeId.value) {
      return;
    }
    deletingRuntimeId.value = runtime.id;
    try {
      await deleteNodeRuntime(selectedNode.value.id, runtime.id);
      clearDefaultRuntime(runtime.id);
      await refreshRuntimeState();
    } catch (error) {
      showControlPlaneToast(translateError(error));
    } finally {
      deletingRuntimeId.value = "";
    }
  }

  async function submitNodeLocalFolder() {
    const node = selectedNode.value;
    if (!node) {
      return;
    }
    if (folderSelectionMode.value === "node") {
      await storageFolderPicker.openForNode(node);
      return;
    }
    await chooseNativeNodeLocalFolder(node);
  }

  async function chooseNativeNodeLocalFolder(node: Node) {
    if (!isControlPlaneLocalNode(node) || !isControlPlaneBuiltinNode(node) || creatingNodeLocalFolder.value) {
      return;
    }
    creatingNodeLocalFolder.value = true;
    try {
      const selected = await chooseProjectFolder?.();
      const result = nativeNodeFolderSelectionResult(selected, node.id);
      if (result.status === "cancelled") return;
      if (result.status === "invalid-owner") {
        showControlPlaneToast(t("settings.nodeDetail.invalidLocalFolderOwner"));
        return;
      }
      const folderPath = result.path;
      await createNodeLocalFolder(node.id, {
        name: nodePathName(folderPath),
        path: folderPath,
        ...(nodeFolderDefaultImageId.value ? { defaultImageSelection: { imageId: nodeFolderDefaultImageId.value } } : {}),
      });
      await refreshFolders();
    } catch (error) {
      showControlPlaneToast(translateError(error));
    } finally {
      creatingNodeLocalFolder.value = false;
    }
  }

  async function removeNodeLocalFolder(folderId: string) {
    if (!selectedNode.value || deletingNodeLocalFolderId.value) {
      return;
    }
    deletingNodeLocalFolderId.value = folderId;
    try {
      await deleteNodeLocalFolder(selectedNode.value.id, folderId);
      await refreshFolders();
    } catch (error) {
      showControlPlaneToast(translateError(error));
    } finally {
      deletingNodeLocalFolderId.value = "";
    }
  }

  function selectNode(nodeId: string) {
    selectedNodeId.value = nodeId;
  }

  function runtimeName(runtime: NodeRuntime) {
    const node = (nodes.value || []).find((item) => item.id === runtime.nodeId);
    return `${node?.name || runtime.nodeId} / ${runtime.name}`;
  }

  function isControlPlaneLocalNode(node: { labels: Record<string, string> }) {
    return node.labels[CONTROL_PLANE_LOCAL_NODE_LABEL] === "true";
  }

  function isControlPlaneBuiltinNode(node: { labels: Record<string, string> }) {
    return node.labels[CONTROL_PLANE_BUILTIN_NODE_LABEL] === "true";
  }

  function nodeLocationLabel(node: { id: string; labels: Record<string, string> }) {
    return isControlPlaneLocalNode(node) ? t("settings.nodeDetail.builtinLocal") : t("settings.nodeDetail.remoteNode");
  }

  return {
    checkingRuntimeId,
    closeNodeStorageFolderPicker: storageFolderPicker.close,
    confirmNodeStorageFolder: storageFolderPicker.confirm,
    creatingNodeLocalFolder,
    deletingNodeLocalFolderId,
    deletingRuntimeId,
    isControlPlaneBuiltinNode,
    isControlPlaneLocalNode,
    localNodeId,
    nodeStorageFolderCanConfirm: storageFolderPicker.canConfirm,
    nodeStorageFolderDialogOpen: storageFolderPicker.dialogOpen,
    nodeStorageFolderError: storageFolderPicker.error,
    nodeStorageFolderLoading: storageFolderPicker.loading,
    nodeStorageFolderRows: storageFolderPicker.rows,
    nodeStorageFolderSelectedPath: storageFolderPicker.selectedPath,
    nodeStorageFolderSubmitError: storageFolderPicker.submitError,
    nodeStorageFolderSubmitting: storageFolderPicker.submitting,
    nodeStorageFolderTarget: storageFolderPicker.targetNode,
    nodeLocalFolders,
    nodeFolderDefaultImageId,
    nodeFolderImageOptions: imageOptions,
    nodeLocationLabel,
    orderedNodes,
    removeNodeLocalFolder,
    removeRuntime,
    runtimeName,
    checkRuntime,
    selectedNode,
    selectedNodeId,
    selectedNodeInstances,
    selectedNodeIsLocal,
    selectedNodeRuntimes,
    selectNode,
    selectNodeStorageFolder: storageFolderPicker.selectFolder,
    setNodeStorageFolderDialogOpen: storageFolderPicker.setOpen,
    submitNodeLocalFolder,
    refreshNodeStorageFolderRoots: () => {
      const nodeId = storageFolderPicker.targetNode.value?.id;
      return nodeId ? storageFolderPicker.loadRoots(nodeId) : Promise.resolve();
    },
  };
}
