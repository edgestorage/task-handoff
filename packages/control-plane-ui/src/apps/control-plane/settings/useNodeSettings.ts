import { computed, onScopeDispose, reactive, ref } from "vue";
import { applyNodeUpdate, checkNode, checkNodeUpdate, createNode, createNodeControlPlaneConnection, createNodeJoinInvite, createNodePairingInvite, deleteNode, deleteNodeControlPlaneConnection, deleteNodeControlPlanePairing, listNodeControlPlaneConnections, listNodeControlPlanePairings, listNodeDockerImages, listNodeUpdateJobs, syncLocalNode, updateNode } from "../../../api/queries";
import type { LocalDockerImage, Node, NodeControlPlaneConnection, NodeControlPlanePairing, NodeRuntime, NodeStatus, UpdateChannel, UpdateCheckResult, UpdateJob } from "../../../api/types";
import { showControlPlaneToast } from "../useControlPlaneToasts";
import { useNodeRename } from "./useNodeRename";
import type { Translate } from "../../../i18n/status.ts";
import { translateApiError } from "../../../i18n/apiError.ts";
import { isActiveNodeUpdate, isTerminalNodeUpdate, refreshNodeUpdateHttpState } from "./nodeUpdatePolling.ts";

type UseNodeSettingsInput = {
  errorText: (error: unknown) => string;
  notify?: typeof showControlPlaneToast;
  onNodeDeleted: (runtimeId: string) => void;
  onNodeRenamed: (node: Node) => void | Promise<void>;
  refreshNodeRuntimeState: () => Promise<void>;
  refreshNodeTopology: () => Promise<void>;
  nodes: () => Node[];
  runtimes: () => NodeRuntime[];
  updateNodeAction?: typeof updateNode;
  updateChannel: () => UpdateChannel;
  translate: Translate;
};

const CONTROL_PLANE_BUILTIN_NODE_LABEL = "task-handoff.control-plane.builtin";
export function useNodeSettings({ errorText, notify = showControlPlaneToast, onNodeDeleted, onNodeRenamed, refreshNodeRuntimeState, refreshNodeTopology, nodes, runtimes, updateNodeAction = updateNode, updateChannel, translate: t }: UseNodeSettingsInput) {
  const translateError = (error: unknown) => translateApiError(error, t, errorText(error));
  const creatingNode = ref(false);
  const syncingLocalNode = ref(false);
  const deletingNodeId = ref("");
  const checkingNodeId = ref("");
  const creatingPairingInviteNodeId = ref("");
  const creatingJoinInvite = ref(false);
  const connectingRemoteNodeId = ref("");
  const deletingRemoteKeyId = ref("");
  const deletingControlPlaneConnectionId = ref("");
  const loadingRemoteKeysNodeId = ref("");
  const loadingNodeImagesId = ref("");
  const selectedImageNodeId = ref("");
  const nodeImages = ref<LocalDockerImage[]>([]);
  const nodeImageError = ref("");
  const generatedToken = ref<{ titleKey: string; token: string; expiresAt: string }>();
  const remoteConnectResultByNodeId = reactive<Record<string, { status: string; error?: string; checkedAt: string }>>({});
  const controlPlanePairingsByNodeId = reactive<Record<string, NodeControlPlanePairing[]>>({});
  const controlPlaneConnectionsByNodeId = reactive<Record<string, NodeControlPlaneConnection[]>>({});
  const remoteKeysErrorByNodeId = reactive<Record<string, string>>({});
  const nodeStatusById = reactive<Record<string, NodeStatus>>({});
  const settingsNodeSuccess = ref("");
  const updateChecks = reactive<Record<string, UpdateCheckResult>>({});
  const updateJobs = ref<UpdateJob[]>([]);
  const checkingUpdateNodeId = ref("");
  const applyingUpdateNodeId = ref("");
  let updateJobsRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let updateJobsLoadRevision = 0;
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
  const nodeRename = useNodeRename({ errorText, nodes, notify, onNodeRenamed, translate: t, updateNode: updateNodeAction });

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
      settingsNodeSuccess.value = t("settings.nodeDetail.nodeCreated", { name: node.name });
      settingsNode.name = "";
      settingsNode.endpoint = "";
      settingsNode.joinToken = "";
      await refreshNodeTopology();
    } catch (error) {
      notify(translateError(error));
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
        await refreshNodeTopology();
        notify(t("settings.nodeDetail.nodeAdded", { name: node.name }), "success");
      } catch (error) {
        notify(t("settings.nodeDetail.nodeAddedRefreshFailed", { name: node.name, error: translateError(error) }));
      }
    } catch (error) {
      notify(translateError(error));
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
        titleKey: "settings.nodeDetail.nodeJoinToken",
        token: invite.joinToken,
        expiresAt: invite.expiresAt,
      };
    } catch (error) {
      showControlPlaneToast(translateError(error));
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
          titleKey: "settings.nodeDetail.controlPlaneJoinToken",
          token: invite.joinToken,
          expiresAt: invite.expiresAt,
        };
      }
      return invite;
    } catch (error) {
      showControlPlaneToast(translateError(error));
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
      const result = await createNodeControlPlaneConnection(id, {
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
      await loadControlPlaneAccess(id);
    } catch (error) {
      showControlPlaneToast(translateError(error));
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
      showControlPlaneToast(translateError(error));
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
      nodeImageError.value = translateError(error);
    } finally {
      loadingNodeImagesId.value = "";
    }
  }

  async function loadControlPlaneAccess(id: string) {
    if (!id || loadingRemoteKeysNodeId.value) {
      return;
    }
    loadingRemoteKeysNodeId.value = id;
    remoteKeysErrorByNodeId[id] = "";
    try {
      const [pairings, connections] = await Promise.all([
        listNodeControlPlanePairings(id),
        listNodeControlPlaneConnections(id),
      ]);
      controlPlanePairingsByNodeId[id] = pairings;
      controlPlaneConnectionsByNodeId[id] = connections;
    } catch (error) {
      controlPlanePairingsByNodeId[id] = [];
      controlPlaneConnectionsByNodeId[id] = [];
      remoteKeysErrorByNodeId[id] = translateError(error);
    } finally {
      loadingRemoteKeysNodeId.value = "";
    }
  }

  async function checkManagedUpdate(nodeId: string) {
    checkingUpdateNodeId.value = nodeId;
    try {
      updateChecks[nodeId] = await checkNodeUpdate(nodeId, updateChannel());
    } catch (error) {
      showControlPlaneToast(translateError(error));
    } finally {
      checkingUpdateNodeId.value = "";
    }
  }

  async function applyManagedUpdate(nodeId: string, checkOverride?: UpdateCheckResult) {
    const check = checkOverride || updateChecks[nodeId];
    if (!check?.supported || !check.updateAvailable || !check.preflightToken || applyingUpdateNodeId.value) return;
    if (!window.confirm(t("settings.nodeDetail.updateConfirm", {
      current: check.currentVersion || t("settings.nodeDetail.unknown"),
      available: check.availableVersion,
      restarting: check.impact.restartInstanceCount,
      active: check.impact.activeInstanceCount,
      stopped: check.impact.stoppedInstanceCount,
    }))) return;
    applyingUpdateNodeId.value = nodeId;
    try {
      await applyNodeUpdate(nodeId, {
        channel: check.channel,
        targetVersion: check.availableVersion,
        preflightToken: check.preflightToken,
      });
      await loadManagedUpdateJobs(nodeId, true);
      showControlPlaneToast(t("settings.nodeDetail.updateQueued"), "success");
    } catch (error) {
      showControlPlaneToast(translateError(error));
    } finally {
      applyingUpdateNodeId.value = "";
    }
  }

  function scheduleManagedUpdateJobsRefresh(nodeId: string) {
    if (updateJobsRefreshTimer) clearTimeout(updateJobsRefreshTimer);
    const active = updateJobs.value.some((job) => isActiveNodeUpdate(job.status));
    if (!active) return;
    updateJobsRefreshTimer = setTimeout(() => void loadManagedUpdateJobs(nodeId, true), 2_000);
  }

  async function loadManagedUpdateJobs(nodeId: string, silent = false) {
    const revision = ++updateJobsLoadRevision;
    if (updateJobsRefreshTimer) clearTimeout(updateJobsRefreshTimer);
    updateJobsRefreshTimer = undefined;
    try {
      const jobs = await listNodeUpdateJobs(nodeId);
      if (revision !== updateJobsLoadRevision) return;
      updateJobs.value = jobs;
      const latest = jobs[0];
      if (isTerminalNodeUpdate(latest?.status)) delete updateChecks[nodeId];
      await refreshNodeUpdateHttpState({
        status: latest?.status,
        refreshRuntimeState: refreshNodeRuntimeState,
        refreshTopology: refreshNodeTopology,
      });
    } catch (error) {
      if (!silent) showControlPlaneToast(translateError(error));
    } finally {
      if (revision === updateJobsLoadRevision) scheduleManagedUpdateJobsRefresh(nodeId);
    }
  }

  onScopeDispose(() => {
    if (updateJobsRefreshTimer) clearTimeout(updateJobsRefreshTimer);
  });

  async function removeRemoteKey(nodeId: string, keyId: string) {
    if (!nodeId || !keyId || deletingRemoteKeyId.value) {
      return;
    }
    deletingRemoteKeyId.value = keyId;
    try {
      await deleteNodeControlPlanePairing(nodeId, keyId);
      await loadControlPlaneAccess(nodeId);
    } catch (error) {
      showControlPlaneToast(translateError(error));
    } finally {
      deletingRemoteKeyId.value = "";
    }
  }

  async function removeControlPlaneConnection(nodeId: string, connectionId: string) {
    if (!nodeId || !connectionId || deletingControlPlaneConnectionId.value) return;
    deletingControlPlaneConnectionId.value = connectionId;
    try {
      await deleteNodeControlPlaneConnection(nodeId, connectionId);
      await loadControlPlaneAccess(nodeId);
    } catch (error) {
      showControlPlaneToast(translateError(error));
    } finally {
      deletingControlPlaneConnectionId.value = "";
    }
  }

  function nodeNameById(nodeId: string) {
    return nodes().find((node) => node.id === nodeId)?.name || nodeId;
  }

  async function removeNode(target: { id: string; name: string; labels: Record<string, string> }) {
    if (target.labels[CONTROL_PLANE_BUILTIN_NODE_LABEL] === "true" || deletingNodeId.value) {
      return;
    }
    if (!window.confirm(t("settings.nodeDetail.deleteConfirm", { name: target.name }))) {
      return;
    }
    deletingNodeId.value = target.id;
    try {
      for (const runtime of runtimes().filter((item) => item.nodeId === target.id)) {
        onNodeDeleted(runtime.id);
      }
      await deleteNode(target.id);
      await refreshNodeTopology();
    } catch (error) {
      showControlPlaneToast(translateError(error));
    } finally {
      deletingNodeId.value = "";
    }
  }

  return {
    ...nodeRename,
    addLocalNode,
    applyManagedUpdate,
    applyingUpdateNodeId,
    canConnectRemote,
    canCreateNode,
    checkSettingsNode,
    checkManagedUpdate,
    checkingUpdateNodeId,
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
    deletingControlPlaneConnectionId,
    loadControlPlaneAccess,
    loadManagedUpdateJobs,
    loadNodeImages,
    loadingRemoteKeysNodeId,
    loadingNodeImagesId,
    removeNode,
    removeRemoteKey,
    removeControlPlaneConnection,
    nodeImageError,
    nodeImages,
    nodeStatusById,
    nodeNameById,
    selectedImageNodeId,
    remoteConnectResultByNodeId,
    controlPlanePairingsByNodeId,
    controlPlaneConnectionsByNodeId,
    remoteKeysErrorByNodeId,
    remoteConnect,
    settingsNode,
    settingsNodeSuccess,
    syncingLocalNode,
    updateChecks,
    updateJobs,
  };
}
