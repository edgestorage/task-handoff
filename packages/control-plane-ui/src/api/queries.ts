import { useQuery } from "@tanstack/vue-query";
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { deleteApiData, getApiData, getApiPayload, patchApiData, postApiData } from "./client";
import type {
  ControlPlaneStatusResponse,
  ControlPlaneSettings,
  ControlPlaneAppSessions,
  AppSession,
  AuthSession,
  AuthUser,
  ConfigSyncPreset,
  ConnectNodeRemoteInput,
  CreateControlledInstanceInput,
  CreateImageInput,
  CreateModelInput,
  CreateNodeInput,
  NodePairingInvite,
  CreateNodeLocalFolderInput,
  CreateNodeRuntimeInput,
  CreateProjectInput,
  HealthResponse,
  ImageProfile,
  ControlPlaneAiSessions,
  ControlPlaneTriggers,
  CreateControlPlaneTriggerInput,
  ChatBridgeConfig,
  ChatChannel,
  AiSessionAttachment,
  AiSessionAttachmentRef,
  AiSessionHistoryList,
  AiSessionHistoryDetail,
  AiSessionMentionCatalog,
  AiSessionMentionFileSearch,
  AiSessionReference,
  AiSessionResumeResult,
  CreateChatBridgeInput,
  ChatGatewayStatus,
  InstanceBoardItem,
  InstanceResourceMetrics,
  InstanceBoardPayload,
  LaunchAppSessionInput,
  LocalDockerImage,
  NodeImageAvailability,
  ModelConfig,
  FederatedModelRegistry,
  Node,
  NodeAgentExternalListener,
  NodeFolderTreeEntry,
  NodeJoinInvite,
  NodeLocalFolder,
  NodeRuntimesPayload,
  NodeRemoteControlPlane,
  NodeRemoteConnectResult,
  NodeRuntime,
  NodeStatus,
  Project,
  UpdateControlledInstanceInput,
  UpdateChatBridgeInput,
  UpdateModelInput,
  UpdateProjectInput,
  UpdateChannel,
  UpdateCheckResult,
  UpdateJob,
  UpdateTarget,
  UpdateNodeAgentExternalListener,
  UpdateNodeInput,
  AppManagementJobResponse,
  AppManagementSnapshot,
} from "./types";

export function useHealthQuery() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => getApiData<HealthResponse>("health"),
    retry: false,
  });
}

export function useAuthSessionQuery() {
  return useQuery({
    queryKey: ["auth-session"],
    queryFn: () => getApiData<AuthSession>("auth/session"),
    retry: false,
  });
}

export function bootstrapAdmin(input: { username: string; password: string }) {
  return postApiData<AuthUser>("auth/bootstrap-admin", input);
}

export function loginControlPlane(input: { username: string; password: string }) {
  return postApiData<{ user: AuthUser }>("auth/login", input);
}

export function logoutControlPlane() {
  return postApiData<{ ok: boolean }>("auth/logout");
}

export function useControlPlaneStatusQuery() {
  return useQuery({
    queryKey: ["control-plane-status"],
    queryFn: () => getApiData<ControlPlaneStatusResponse>("control-plane/status"),
    retry: false,
  });
}

export function useControlPlaneSettingsQuery() {
  return useQuery({
    queryKey: ["control-plane-settings"],
    queryFn: () => getApiData<ControlPlaneSettings>("control-plane/settings"),
    retry: false,
  });
}

export function updateControlPlaneSettings(input: Partial<ControlPlaneSettings>) {
  return patchApiData<ControlPlaneSettings>("control-plane/settings", input);
}

export function useProjectsQuery() {
  return useQuery({
    queryKey: ["control-plane-projects"],
    queryFn: () => getApiData<Project[]>("projects"),
    retry: false,
  });
}

export function useImagesQuery() {
  return useQuery({
    queryKey: ["control-plane-images"],
    queryFn: () => getApiData<ImageProfile[]>("images"),
    retry: false,
  });
}

const modelRegistryQueryKey = ["control-plane-models"] as const;

function fetchModelRegistry() {
  return getApiData<FederatedModelRegistry>("models");
}

export function modelConfigsFromRegistry(registry: FederatedModelRegistry) {
  return registry.models.map((group) => ({
    ...group.model,
    locations: group.locations,
    referenceCount: group.referenceCount,
  } satisfies ModelConfig));
}

export function useModelRegistryQuery() {
  return useQuery({
    queryKey: modelRegistryQueryKey,
    queryFn: fetchModelRegistry,
    retry: false,
  });
}

export function useModelsQuery() {
  return useQuery({
    queryKey: modelRegistryQueryKey,
    queryFn: fetchModelRegistry,
    select: modelConfigsFromRegistry,
    retry: false,
  });
}

export function useNodesQuery() {
  return useQuery({
    queryKey: ["control-plane-nodes"],
    queryFn: () => getApiData<Node[]>("nodes"),
    retry: false,
  });
}

export function checkNodeUpdate(nodeId: string, target: UpdateTarget, channel: UpdateChannel) {
  return postApiData<UpdateCheckResult>(`nodes/${nodeId}/updates/check`, { target, channel });
}

export function useServerUpdateCheckQuery(
  nodeId: MaybeRefOrGetter<string>,
  channel: MaybeRefOrGetter<UpdateChannel> = "stable",
) {
  const resolvedNodeId = computed(() => toValue(nodeId));
  const resolvedChannel = computed(() => toValue(channel));
  return useQuery({
    queryKey: computed(() => ["server-update-check", resolvedNodeId.value, resolvedChannel.value]),
    queryFn: () => checkNodeUpdate(resolvedNodeId.value, { component: "node-agent" }, resolvedChannel.value),
    enabled: computed(() => Boolean(resolvedNodeId.value)),
    staleTime: 15 * 60 * 1000,
    retry: false,
  });
}

export function applyNodeUpdate(nodeId: string, target: UpdateTarget, channel: UpdateChannel) {
  return postApiData<UpdateJob>(`nodes/${nodeId}/updates/apply`, { target, channel });
}

export function listNodeUpdateJobs(nodeId: string) {
  return getApiData<UpdateJob[]>(`nodes/${nodeId}/updates/jobs`);
}

export function useNodeRuntimesQuery() {
  return useQuery({
    queryKey: ["control-plane-node-runtimes"],
    queryFn: () => getApiData<NodeRuntime[]>("node-runtimes"),
    retry: false,
  });
}

export function useNodeRuntimesPayloadQuery() {
  return useQuery({
    queryKey: ["control-plane-node-runtimes-payload"],
    queryFn: () => getApiPayload<NodeRuntime[], NodeRuntimesPayload["meta"]>("node-runtimes"),
    retry: false,
  });
}

export function useNodeLocalFoldersQuery(nodeId: MaybeRefOrGetter<string>) {
  const resolvedNodeId = computed(() => toValue(nodeId));
  return useQuery({
    queryKey: computed(() => ["control-plane-node-local-folders", resolvedNodeId.value]),
    queryFn: () => getApiData<NodeLocalFolder[]>(`nodes/${resolvedNodeId.value}/local-folders`),
    enabled: computed(() => Boolean(resolvedNodeId.value)),
    retry: false,
  });
}

export function listNodeFolderTree(nodeId: string, input: { path?: string; depth?: number } = {}) {
  const params = new URLSearchParams();
  if (input.path) {
    params.set("path", input.path);
  }
  if (input.depth !== undefined) {
    params.set("depth", String(input.depth));
  }
  const query = params.toString();
  return getApiData<NodeFolderTreeEntry[]>(`nodes/${nodeId}/folders/tree${query ? `?${query}` : ""}`);
}

export function useLocalDockerImagesQuery(nodeId: MaybeRefOrGetter<string>) {
  const resolvedNodeId = computed(() => toValue(nodeId));
  return useQuery({
    queryKey: computed(() => ["node-docker-images", resolvedNodeId.value]),
    queryFn: () => getApiData<LocalDockerImage[]>(`nodes/${resolvedNodeId.value}/docker/images`),
    enabled: false,
    retry: false,
  });
}

export function useNodeImageAvailabilityQuery(nodeId: MaybeRefOrGetter<string>) {
  const resolvedNodeId = computed(() => toValue(nodeId));
  return useQuery({
    queryKey: computed(() => ["node-image-catalog", resolvedNodeId.value]),
    queryFn: () => getApiData<NodeImageAvailability[]>(`nodes/${resolvedNodeId.value}/images/catalog`),
    enabled: computed(() => Boolean(resolvedNodeId.value)),
    retry: false,
  });
}

export function listNodeRemoteControlPlanes(nodeId: string) {
  return getApiData<NodeRemoteControlPlane[]>(`nodes/${nodeId}/remotes`);
}

export function deleteNodeRemoteControlPlane(nodeId: string, keyId: string) {
  return deleteApiData<{ deleted: boolean }>(`nodes/${nodeId}/remotes/${encodeURIComponent(keyId)}`);
}

export function useInstanceBoardQuery() {
  return useQuery({
    queryKey: ["instance-board"],
    queryFn: () => getApiData<InstanceBoardItem[]>("instance-board"),
    retry: false,
  });
}

export function getInstanceResourceMetrics(instanceId: string) {
  return getApiData<InstanceResourceMetrics>(`controlled-instances/${encodeURIComponent(instanceId)}/metrics`);
}

export function useInstanceBoardPayloadQuery() {
  return useQuery({
    queryKey: ["instance-board-payload"],
    queryFn: () => getApiPayload<InstanceBoardItem[], InstanceBoardPayload["meta"]>("instance-board"),
    retry: false,
  });
}

export function useControlPlaneAiSessionsQuery() {
  return useQuery({
    queryKey: ["control-plane-ai-sessions"],
    queryFn: () => getApiData<ControlPlaneAiSessions>("ai-sessions"),
    retry: false,
  });
}

export function getAiSessionHistory(instanceId: string) {
  return getApiData<AiSessionHistoryList>(`controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/history`);
}

export function getAiSessionHistoryDetail(instanceId: string, aiSessionId: string) {
  return getApiData<AiSessionHistoryDetail>(`controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/history/${encodeURIComponent(aiSessionId)}`);
}

export function resumeAiSession(instanceId: string, aiSessionId: string) {
  return postApiData<AiSessionResumeResult>(`controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(aiSessionId)}/resume`, {});
}

export function useControlPlaneAppSessionsQuery() {
  return useQuery({
    queryKey: ["control-plane-app-sessions"],
    queryFn: () => getApiData<ControlPlaneAppSessions>("app-sessions"),
    retry: false,
  });
}

export function useControlPlaneTriggersQuery() {
  return useQuery({
    queryKey: ["control-plane-triggers"],
    queryFn: () => getApiData<ControlPlaneTriggers>("triggers"),
    retry: false,
  });
}

export function runControlledInstanceTrigger(instanceId: string, configHash: string, input: { deploymentId?: string } = {}) {
  return postApiData<Record<string, unknown>>(`controlled-instances/${instanceId}/triggers/${configHash}/run`, input);
}

export function createControlPlaneTrigger(input: CreateControlPlaneTriggerInput) {
  return postApiData<Record<string, unknown>>("triggers", input);
}

export function deleteControlPlaneTrigger(configHash: string) {
  return deleteApiData<Record<string, unknown>>(`triggers/${configHash}`);
}

export function applyControlPlaneTrigger(configHash: string, instanceIds: string[]) {
  return postApiData<Record<string, unknown>>(`triggers/${configHash}/apply`, { instanceIds });
}

export function bindAiSessionTrigger(instanceId: string, sessionId: string, configHash: string) {
  return postApiData<Record<string, unknown>>(`controlled-instances/${instanceId}/ai-sessions/${sessionId}/triggers`, { configHash });
}

export function unbindAiSessionTrigger(instanceId: string, sessionId: string, configHash: string) {
  return deleteApiData<Record<string, unknown>>(`controlled-instances/${instanceId}/ai-sessions/${sessionId}/triggers/${configHash}`);
}

export function useChatGatewayStatusQuery() {
  return useQuery({
    queryKey: ["chat-gateway-status"],
    queryFn: () => getApiData<ChatGatewayStatus>("chat-gateway/status"),
    refetchInterval: 5000,
    retry: false,
  });
}

export function useChatBridgesQuery() {
  return useQuery({
    queryKey: ["chat-gateway-bridges"],
    queryFn: () => getApiData<ChatBridgeConfig[]>("chat-gateway/bridges"),
    retry: false,
  });
}

export function createChatBridge(input: CreateChatBridgeInput) {
  return postApiData<ChatBridgeConfig>("chat-gateway/bridges", input);
}

export function updateChatBridge(id: string, input: UpdateChatBridgeInput) {
  return patchApiData<ChatBridgeConfig>(`chat-gateway/bridges/${id}`, input);
}

export function startChatBridge(id: string) {
  return postApiData<ChatGatewayStatus>(`chat-gateway/bridges/${id}/start`);
}

export function stopChatBridge(id: string) {
  return postApiData<ChatGatewayStatus>(`chat-gateway/bridges/${id}/stop`);
}

export function deleteChatBridge(id: string) {
  return deleteApiData<{ deleted: boolean }>(`chat-gateway/bridges/${id}`);
}

export function useConfigSyncPresetsQuery() {
  return useQuery({
    queryKey: ["config-sync-presets"],
    queryFn: () => getApiData<ConfigSyncPreset[]>("config-sync/presets"),
    retry: false,
  });
}

export function createControlledInstance(input: CreateControlledInstanceInput) {
  return postApiData<InstanceBoardItem & { registrationToken?: string }>("controlled-instances", input);
}

export function updateControlledInstance(id: string, input: UpdateControlledInstanceInput) {
  return patchApiData<InstanceBoardItem>(`controlled-instances/${id}`, input);
}

export function startControlledInstance(id: string) {
  return postApiData<InstanceBoardItem>(`controlled-instances/${id}/start`);
}

export function stopControlledInstance(id: string) {
  return postApiData<InstanceBoardItem>(`controlled-instances/${id}/stop`);
}

export function restartControlledInstance(id: string) {
  return postApiData<InstanceBoardItem>(`controlled-instances/${id}/restart`);
}

export function deleteControlledInstance(id: string) {
  return deleteApiData<{ deleted: boolean }>(`controlled-instances/${id}`);
}

export function launchAppSession(instanceId: string, input: LaunchAppSessionInput = {}) {
  return postApiData<AppSession>(`controlled-instances/${instanceId}/apps/sessions`, input);
}

export function stopAppSession(instanceId: string, sessionId: string) {
  return postApiData<AppSession>(`controlled-instances/${instanceId}/apps/sessions/${sessionId}/stop`);
}

export function renameAppSession(instanceId: string, sessionId: string, title: string) {
  return patchApiData<AppSession>(`controlled-instances/${instanceId}/apps/sessions/${sessionId}`, { title });
}

export function getInstanceAppManagement(instanceId: string) {
  return getApiData<AppManagementSnapshot>(`controlled-instances/${instanceId}/apps/management`);
}

export function installInstanceApp(instanceId: string, appId: string, requestId?: string) {
  return postApiData<AppManagementJobResponse>(`controlled-instances/${instanceId}/apps/${encodeURIComponent(appId)}/install`, requestId ? { requestId } : {});
}

export function uninstallInstanceApp(instanceId: string, appId: string, requestId?: string) {
  return postApiData<AppManagementJobResponse>(`controlled-instances/${instanceId}/apps/${encodeURIComponent(appId)}/uninstall`, requestId ? { requestId } : {});
}

export function getInstanceAppManagementJob(instanceId: string, jobId: string) {
  return getApiData<AppManagementJobResponse>(`controlled-instances/${instanceId}/apps/jobs/${encodeURIComponent(jobId)}`);
}

export function uploadAiSessionAttachment(input: { instanceId: string; sessionId: string; kind: "image"; name: string; mime: string; data: string }) {
  return postApiData<AiSessionAttachment>("ai-session-attachments", input);
}

export function sendAiSessionMessage(instanceId: string, sessionId: string, message: string, mode?: "auto" | "queue" | "steer" | "immediate", attachments: AiSessionAttachmentRef[] = [], references: AiSessionReference[] = []) {
  return postApiData<Record<string, unknown>>(`controlled-instances/${instanceId}/ai-sessions/${sessionId}/messages`, { message, mode, attachments, references });
}

export function getAiSessionMentionCatalog(instanceId: string, sessionId: string, signal?: AbortSignal) {
  return getApiData<AiSessionMentionCatalog>(`controlled-instances/${instanceId}/ai-sessions/${sessionId}/mentions`, { signal });
}

export function searchAiSessionMentionFiles(instanceId: string, sessionId: string, query: string, signal?: AbortSignal) {
  return postApiData<AiSessionMentionFileSearch>(`controlled-instances/${instanceId}/ai-sessions/${sessionId}/mentions/files`, { query }, { signal });
}

export function steerAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
  return postApiData<Record<string, unknown>>(`controlled-instances/${instanceId}/ai-sessions/${sessionId}/queue/${queueId}/steer`);
}

export function retryAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
  return postApiData<Record<string, unknown>>(`controlled-instances/${instanceId}/ai-sessions/${sessionId}/queue/${queueId}/retry`);
}

export function removeAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
  return deleteApiData<Record<string, unknown>>(`controlled-instances/${instanceId}/ai-sessions/${sessionId}/queue/${queueId}`);
}

export function interruptAiSession(instanceId: string, sessionId: string) {
  return postApiData<Record<string, unknown>>(`controlled-instances/${instanceId}/ai-sessions/${sessionId}/interrupt`);
}

export function resolveAiSessionApproval(instanceId: string, sessionId: string, decision: "allow" | "deny" | "skip") {
  return postApiData<Record<string, unknown>>(`controlled-instances/${instanceId}/ai-sessions/${sessionId}/approval`, { decision });
}

export function syncControlledInstanceConfig(instanceId: string, direction: "import" | "export", preset: string) {
  return postApiData<Record<string, unknown>>(`controlled-instances/${instanceId}/config-sync/${direction}/${preset}`);
}

export function createProject(input: CreateProjectInput) {
  return postApiData<Project>("projects", input);
}

export function updateProject(id: string, input: UpdateProjectInput) {
  return patchApiData<Project>(`projects/${id}`, input);
}

export function deleteProject(id: string) {
  return deleteApiData<{ deleted: boolean }>(`projects/${id}`);
}

export function createModel(input: CreateModelInput) {
  return postApiData<ModelConfig>("models", input);
}

export function updateModel(id: string, input: UpdateModelInput) {
  return patchApiData<ModelConfig>(`models/${id}`, input);
}

export function deleteModel(id: string) {
  return deleteApiData<{ deleted: boolean }>(`models/${id}`);
}

export function createNodeModel(nodeId: string, input: CreateModelInput) {
  return postApiData<ModelConfig>(`nodes/${nodeId}/models`, input);
}

export function updateNodeModel(nodeId: string, id: string, input: UpdateModelInput) {
  return patchApiData<ModelConfig>(`nodes/${nodeId}/models/${id}`, input);
}

export function deleteNodeModel(nodeId: string, id: string) {
  return deleteApiData<{ deleted: boolean }>(`nodes/${nodeId}/models/${id}`);
}

export function reorderModels(ids: string[]) {
  return postApiData<ModelConfig[]>("models/reorder", { ids });
}

export function createImage(input: CreateImageInput) {
  return postApiData<ImageProfile>("images", input);
}

export function deleteImage(id: string) {
  return deleteApiData<{ deleted: boolean }>(`images/${id}`);
}

export function retryInstanceImageProvisioning(id: string) {
  return postApiData<InstanceBoardItem>(`controlled-instances/${id}/image-provisioning/retry`, {});
}

export function createNode(input: CreateNodeInput) {
  return postApiData<Node>("nodes", input);
}

export function updateNode(id: string, input: UpdateNodeInput) {
  return patchApiData<Node>(`nodes/${id}`, input);
}

export function syncLocalNode() {
  return postApiData<Node>("nodes/local/sync");
}

export function deleteNode(id: string) {
  return deleteApiData<{ deleted: boolean }>(`nodes/${id}`);
}

export function checkNode(id: string) {
  return postApiData<NodeStatus>(`nodes/${id}/check`);
}

export function getNodeExternalListener(id: string) {
  return getApiData<NodeAgentExternalListener>(`nodes/${id}/settings/external-listener`);
}

export function updateNodeExternalListener(id: string, input: UpdateNodeAgentExternalListener) {
  return patchApiData<NodeAgentExternalListener>(`nodes/${id}/settings/external-listener`, input);
}

export function createNodePairingInvite(id: string) {
  return postApiData<NodePairingInvite>(`nodes/${id}/pairing/invites`, {});
}

export function connectNodeRemote(id: string, input: ConnectNodeRemoteInput) {
  return postApiData<NodeRemoteConnectResult>(`nodes/${id}/remotes/connect`, input);
}

export function createNodeJoinInvite(input: { nodeName?: string } = {}) {
  return postApiData<NodeJoinInvite>("node-join/invites", input);
}

export function createNodeLocalFolder(nodeId: string, input: CreateNodeLocalFolderInput) {
  return postApiData<NodeLocalFolder>(`nodes/${nodeId}/local-folders`, input);
}

export function deleteNodeLocalFolder(nodeId: string, folderId: string) {
  return deleteApiData<{ deleted: boolean }>(`nodes/${nodeId}/local-folders/${folderId}`);
}

export function createNodeRuntime(nodeId: string, input: CreateNodeRuntimeInput) {
  return postApiData<NodeRuntime>(`nodes/${nodeId}/runtimes`, input);
}

export function checkNodeRuntime(nodeId: string, runtimeId: string) {
  return postApiData<NodeRuntime>(`nodes/${nodeId}/runtimes/${runtimeId}/check`);
}

export function deleteNodeRuntime(nodeId: string, runtimeId: string) {
  return deleteApiData<{ deleted: boolean }>(`nodes/${nodeId}/runtimes/${runtimeId}`);
}

export function listNodeDockerImages(id: string) {
  return getApiData<LocalDockerImage[]>(`nodes/${id}/docker/images`);
}
