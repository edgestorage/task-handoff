import { computed, reactive, ref } from "vue";
import { applyNodeUpdate, checkNode, checkNodeUpdate, connectNodeRemote, createNode, createNodeJoinInvite, createNodePairingInvite, deleteNode, deleteNodeRemoteControlPlane, listNodeDockerImages, listNodeRemoteControlPlanes, listNodeUpdateJobs, syncLocalNode, updateNode } from "../../../api/queries";
import type { LocalDockerImage, Node, NodeRemoteControlPlane, NodeRuntime, NodeStatus, UpdateChannel, UpdateCheckResult, UpdateJob, UpdateTarget } from "../../../api/types";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { useNodeRename } from "./useNodeRename";

type UseNodeSettingsInput = {
  errorText: (error: unknown) => string;
  notify?: typeof showControlPlaneToast;
  onNodeDeleted: (runtimeId: string) => void;
  onNodeRenamed: (node: Node) => void | Promise<void>;
  refresh: () => Promise<void>;
  nodes: () => Node[];
  runtimes: () => NodeRuntime[];
  updateNodeAction?: typeof updateNode;
  updateChannel: () => UpdateChannel;
};

const CONTROL_PLANE_BUILTIN_NODE_LABEL = "task-handoff.control-plane.builtin";
export function useNodeSettings({ errorText, notify = showControlPlaneToast, onNodeDeleted, onNodeRenamed, refresh, nodes, runtimes, updateNodeAction = updateNode, updateChannel }: UseNodeSettingsInput) {
  const creatingNode = ref(false);
  const syncingLocalNode = ref(false);
  const deletingNodeId = ref("");
  const checkingNodeId = ref("");
  const creatingPairingInviteNodeId = ref("");
  const creatingJoinInvite = ref(false);
  const connectingRemoteNodeId = ref("");
  const deletingRemoteKeyId = ref("");
  const loadingRemoteKeysNodeId = ref("");
  const loadingNodeImagesId = ref("");
  const selectedImageNodeId = ref("");
  const nodeImages = ref<LocalDockerImage[]>([]);
  const nodeImageError = ref("");
  const generatedToken = ref<{ title: string; token: string; expiresAt: string }>();
  const remoteConnectResultByNodeId = reactive<Record<string, { status: string; error?: string; checkedAt: string }>>({});
  const remoteKeysByNodeId = reactive<Record<string, NodeRemoteControlPlane[]>>({});
  const remoteKeysErrorByNodeId = reactive<Record<string, string>>({});
  const nodeStatusById = reactive<Record<string, NodeStatus>>({});
  const settingsNodeSuccess = ref("");
  const updateChecks = reactive<Record<string, UpdateCheckResult>>({});
  const updateJobs = ref<UpdateJob[]>([]);
  const checkingUpdateTarget = ref("");
  const applyingUpdateTarget = ref("");
  const settingsNode = reactive({
    name: "",
    endpoint: "",
    joinToken: "",
  });
  const remoteConnect = reactive({
    controlPlaneUrl: "",
    joinToken: "",
    controlPlaneName: "",
  });

  const canCreateNode = computed(() => Boolean(settingsNode.name.trim() && settingsNode.endpoint.trim()));
  const canConnectRemote = computed(() => Boolean(remoteConnect.controlPlaneUrl.trim() && remoteConnect.joinToken.trim()));
  const nodeRename = useNodeRename({ errorText, nodes, notify, onNodeRenamed, updateNode: updateNodeAction });

  function clearNodeFeedback() {
    settingsNodeSuccess.value = "";
  }

  async function createSettingsNode() {
    if (!canCreateNode.value || creatingNode.value) {
      return;
    }
    creatingNode.value = true;
    clearNodeFeedback();
    try {
      const node = await createNode({
        name: settingsNode.name.trim(),
        connectionMode: "direct-http",
        endpoint: settingsNode.endpoint.trim(),
        joinToken: settingsNode.joinToken.trim(),
      });
      settingsNodeSuccess.value = `${node.name} created.`;
      settingsNode.name = "";
      settingsNode.endpoint = "";
      settingsNode.joinToken = "";
      await refresh();
    } catch (error) {
      notify(errorText(error));
    } finally {
      creatingNode.value = false;
    }
  }

  async function addLocalNode() {
    if (syncingLocalNode.value) {
      return;
    }
    syncingLocalNode.value = true;
    clearNodeFeedback();
    try {
      const node = await syncLocalNode();
      try {
        await refresh();
        notify(`${node.name} added.`, "success");
      } catch (error) {
        notify(`${node.name} was added, but the control-plane view could not refresh: ${errorText(error)}`);
      }
    } catch (error) {
      notify(errorText(error));
    } finally {
      syncingLocalNode.value = false;
    }
  }

  async function createPairingInviteForNode(id: string) {
    if (creatingPairingInviteNodeId.value) {
      return;
    }
    creatingPairingInviteNodeId.value = id;
    try {
      const invite = await createNodePairingInvite(id);
      generatedToken.value = {
        title: "Node join token",
        token: invite.joinToken,
        expiresAt: invite.expiresAt,
      };
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      creatingPairingInviteNodeId.value = "";
    }
  }

  async function createJoinInvite(showToken = true) {
    if (creatingJoinInvite.value) {
      return;
    }
    creatingJoinInvite.value = true;
    try {
      const invite = await createNodeJoinInvite();
      if (showToken) {
        generatedToken.value = {
          title: "Control-plane join token",
          token: invite.joinToken,
          expiresAt: invite.expiresAt,
        };
      }
      return invite;
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      creatingJoinInvite.value = false;
    }
  }

  async function connectSelectedNodeToRemote(id: string) {
    if (!canConnectRemote.value || connectingRemoteNodeId.value) {
      return;
    }
    connectingRemoteNodeId.value = id;
    try {
      const result = await connectNodeRemote(id, {
        controlPlaneUrl: remoteConnect.controlPlaneUrl.trim(),
        joinToken: remoteConnect.joinToken.trim(),
        ...(remoteConnect.controlPlaneName.trim() ? { controlPlaneName: remoteConnect.controlPlaneName.trim() } : {}),
        activate: true,
      });
      remoteConnectResultByNodeId[id] = {
        status: result.tunnel.status,
        checkedAt: new Date().toISOString(),
        ...(result.tunnel.error ? { error: result.tunnel.error } : {}),
      };
      remoteConnect.joinToken = "";
      await loadRemoteKeys(id);
      await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      connectingRemoteNodeId.value = "";
    }
  }

  async function checkSettingsNode(id: string) {
    if (checkingNodeId.value) {
      return;
    }
    checkingNodeId.value = id;
    try {
      nodeStatusById[id] = await checkNode(id);
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      checkingNodeId.value = "";
    }
  }

  async function loadNodeImages(id: string) {
    if (loadingNodeImagesId.value) {
      return;
    }
    loadingNodeImagesId.value = id;
    selectedImageNodeId.value = id;
    nodeImageError.value = "";
    try {
      nodeImages.value = await listNodeDockerImages(id);
    } catch (error) {
      nodeImages.value = [];
      nodeImageError.value = errorText(error);
    } finally {
      loadingNodeImagesId.value = "";
    }
  }

  async function loadRemoteKeys(id: string) {
    if (!id || loadingRemoteKeysNodeId.value) {
      return;
    }
    loadingRemoteKeysNodeId.value = id;
    remoteKeysErrorByNodeId[id] = "";
    try {
      remoteKeysByNodeId[id] = await listNodeRemoteControlPlanes(id);
    } catch (error) {
      remoteKeysByNodeId[id] = [];
      remoteKeysErrorByNodeId[id] = errorText(error);
    } finally {
      loadingRemoteKeysNodeId.value = "";
    }
  }

  function managedUpdateKey(nodeId: string, target: UpdateTarget) {
    const targetKey = target.component === "node-agent" ? "node-agent" : `instance:${target.instanceId}`;
    return `${nodeId}:${targetKey}`;
  }

  async function checkManagedUpdate(nodeId: string, target: UpdateTarget) {
    const key = managedUpdateKey(nodeId, target);
    checkingUpdateTarget.value = key;
    try {
      updateChecks[key] = await checkNodeUpdate(nodeId, target, updateChannel());
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      checkingUpdateTarget.value = "";
    }
  }

  async function applyManagedUpdate(nodeId: string, target: UpdateTarget, checkOverride?: UpdateCheckResult) {
    const key = managedUpdateKey(nodeId, target);
    const check = checkOverride || updateChecks[key];
    if (!check?.supported || !check.updateAvailable || applyingUpdateTarget.value) return;
    if (!window.confirm(`Update ${key} from ${check.currentVersion || "unknown"} to ${check.availableVersion}?`)) return;
    applyingUpdateTarget.value = key;
    try {
      await applyNodeUpdate(nodeId, target, updateChannel());
      updateJobs.value = await listNodeUpdateJobs(nodeId);
      showControlPlaneToast("Update queued on node agent.", "success");
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      applyingUpdateTarget.value = "";
    }
  }

  async function loadManagedUpdateJobs(nodeId: string) {
    try {
      updateJobs.value = await listNodeUpdateJobs(nodeId);
      const succeededTargets = updateJobs.value.filter((job) => job.status === "succeeded").map((job) => managedUpdateKey(nodeId, job.target));
      for (const key of succeededTargets) delete updateChecks[key];
      await Promise.all([checkSettingsNode(nodeId), refresh()]);
    } catch (error) {
      showControlPlaneToast(errorText(error));
    }
  }

  async function removeRemoteKey(nodeId: string, keyId: string) {
    if (!nodeId || !keyId || deletingRemoteKeyId.value) {
      return;
    }
    deletingRemoteKeyId.value = keyId;
    try {
      await deleteNodeRemoteControlPlane(nodeId, keyId);
      await loadRemoteKeys(nodeId);
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      deletingRemoteKeyId.value = "";
    }
  }

  function nodeNameById(nodeId: string) {
    return nodes().find((node) => node.id === nodeId)?.name || nodeId;
  }

  async function removeNode(target: { id: string; name: string; labels: Record<string, string> }) {
    if (target.labels[CONTROL_PLANE_BUILTIN_NODE_LABEL] === "true" || deletingNodeId.value) {
      return;
    }
    if (!window.confirm(`Delete node ${target.name}?`)) {
      return;
    }
    deletingNodeId.value = target.id;
    try {
      for (const runtime of runtimes().filter((item) => item.nodeId === target.id)) {
        onNodeDeleted(runtime.id);
      }
      await deleteNode(target.id);
      await refresh();
    } catch (error) {
      showControlPlaneToast(errorText(error));
    } finally {
      deletingNodeId.value = "";
    }
  }

  return {
    ...nodeRename,
    addLocalNode,
    applyManagedUpdate,
    applyingUpdateTarget,
    canConnectRemote,
    canCreateNode,
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
    removeNode,
    removeRemoteKey,
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
    syncingLocalNode,
    updateChecks,
    updateJobs,
  };
}
