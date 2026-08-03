import { queryOptions, useQuery } from "@tanstack/vue-query";
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { deleteApiData, getApiData, getApiPayload, patchApiData, postApiData, putApiData } from "./client";
import { mergeInstanceBoardQueryData } from "./instanceBoardMerge.ts";
import { controlPlaneQueryKeys } from "./queryKeys.ts";
export { controlPlaneQueryKeys } from "./queryKeys.ts";
import type {
  ControlPlaneStatusResponse,
  ControlPlaneSettings,
  ControlPlaneAppSessions,
  AppSession,
  AuthSession,
  AuthUser,
  CreateNodeControlPlaneConnectionInput,
  CreateControlledInstanceInput,
  CreateControlledInstanceResult,
  CreateImageInput,
  CreateModelInput,
  CreateNodeInput,
  NodePairingInvite,
  CreateNodeLocalFolderInput,
  CreateNodeRuntimeInput,
  CreateProjectInput,
  HealthResponse,
  MarketCatalog,
  ImageProfile,
  SelectableImage,
  ControlPlaneAiSessions,
  ControlPlaneTriggers,
  CreateControlPlaneTriggerInput,
  ChatBridgeConfig,
  ChatChannel,
  AiSessionUploadedAttachment,
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
  NodeControlPlaneConnection,
  NodeControlPlanePairing,
  NodeControlPlaneConnectionCreateResult,
  NodeRuntime,
  NodeStatus,
  Project,
  UpdateControlledInstanceInput,
  UpdateChatBridgeInput,
  UpdateModelInput,
  UpdateProjectInput,
  UpdateChannel,
  ApplyUpdateRequest,
  UpdateCheckResult,
  UpdateJob,
  UpdateNodeAgentExternalListener,
  UpdateNodeInput,
  AppManagementJobResponse,
  AppManagementSnapshot,
  ClaimProxyNodeResult,
  CancelProxyClaimResult,
  ControlPlaneProxyDiagnostic,
  CreateProxyInviteResult,
  DeleteNodeResult,
  PublicPendingProxyClaim,
  PublicProxyBinding,
  PublicProxyInvite,
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
    queryKey: controlPlaneQueryKeys.status,
    queryFn: () => getApiData<ControlPlaneStatusResponse>("control-plane/status"),
    retry: false,
  });
}

export function useControlPlaneSettingsQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.settings,
    queryFn: () => getApiData<ControlPlaneSettings>("control-plane/settings"),
    retry: false,
  });
}

export function updateControlPlaneSettings(input: Partial<ControlPlaneSettings>) {
  return patchApiData<ControlPlaneSettings>("control-plane/settings", input);
}

export function useProjectsQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.projects,
    queryFn: () => getApiData<Project[]>("projects"),
    retry: false,
  });
}

export function useImagesQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.images,
    queryFn: () => getApiData<ImageProfile[]>("images"),
    retry: false,
  });
}

export function useMarketCatalogQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.marketCatalog,
    queryFn: () => getApiData<MarketCatalog>("market/catalog"),
    retry: false,
  });
}

export function useImageOptionsQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.imageOptions,
    queryFn: () => getApiData<SelectableImage[]>("image-options"),
    retry: false,
  });
}

function fetchModelRegistry(signal?: AbortSignal) {
  return getApiData<FederatedModelRegistry>("models", { signal });
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
    queryKey: controlPlaneQueryKeys.models,
    queryFn: ({ signal }) => fetchModelRegistry(signal),
    retry: false,
  });
}

export function useModelsQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.models,
    queryFn: ({ signal }) => fetchModelRegistry(signal),
    select: modelConfigsFromRegistry,
    retry: false,
  });
}

export function useNodesQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.nodes,
    queryFn: ({ signal }) => getApiData<Node[]>("nodes", { signal }),
    retry: false,
  });
}

export function useControlPlaneProxyInvitesQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.controlPlaneProxyInvites,
    queryFn: ({ signal }) => getApiData<PublicProxyInvite[]>("control-plane-proxy/invites", { signal }),
    retry: false,
  });
}

export function createControlPlaneProxyInvite(input: { targetNodeId: string; expiresInSeconds?: number }) {
  return postApiData<CreateProxyInviteResult>("control-plane-proxy/invites", input);
}

export function revokeControlPlaneProxyInvite(id: string) {
  return deleteApiData<PublicProxyInvite>(`control-plane-proxy/invites/${id}`);
}

export function useControlPlaneProxyBindingsQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.controlPlaneProxyBindings,
    queryFn: ({ signal }) => getApiData<PublicProxyBinding[]>("control-plane-proxy/bindings", { signal }),
    retry: false,
  });
}

export function revokeControlPlaneProxyBinding(id: string) {
  return deleteApiData<{ binding: PublicProxyBinding; closed: { abortedRequests: number; closedSockets: number } }>(`control-plane-proxy/bindings/${id}`);
}

export function useControlPlaneProxyDiagnosticsQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.controlPlaneProxyDiagnostics,
    queryFn: ({ signal }) => getApiData<ControlPlaneProxyDiagnostic[]>("control-plane-proxy/diagnostics", { signal }),
    retry: false,
  });
}

export function usePendingControlPlaneProxyClaimsQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.controlPlaneProxyPendingClaims,
    queryFn: ({ signal }) => getApiData<PublicPendingProxyClaim[]>("control-plane-proxy/pending-claims", { signal }),
    retry: false,
  });
}

export function claimControlPlaneProxyNode(input: { proxyOrigin: string; inviteToken: string; name?: string }) {
  return postApiData<ClaimProxyNodeResult>("control-plane-proxy/claims", input);
}

export function resumeControlPlaneProxyClaim(id: string) {
  return postApiData<ClaimProxyNodeResult>(`control-plane-proxy/pending-claims/${id}/resume`);
}

export function cancelControlPlaneProxyClaim(id: string) {
  return deleteApiData<CancelProxyClaimResult>(`control-plane-proxy/pending-claims/${id}`);
}

export function checkNodeUpdate(nodeId: string, channel: UpdateChannel) {
  return postApiData<UpdateCheckResult>(`nodes/${nodeId}/updates/check`, { channel });
}

export function useServerUpdateCheckQuery(
  nodeId: MaybeRefOrGetter<string>,
  channel: MaybeRefOrGetter<UpdateChannel> = "stable",
) {
  const resolvedNodeId = computed(() => toValue(nodeId));
  const resolvedChannel = computed(() => toValue(channel));
  return useQuery({
    queryKey: computed(() => ["server-update-check", resolvedNodeId.value, resolvedChannel.value]),
    queryFn: () => checkNodeUpdate(resolvedNodeId.value, resolvedChannel.value),
    enabled: computed(() => Boolean(resolvedNodeId.value)),
    staleTime: 15 * 60 * 1000,
    retry: false,
  });
}

export function applyNodeUpdate(nodeId: string, input: ApplyUpdateRequest) {
  return postApiData<UpdateJob>(`nodes/${nodeId}/updates/apply`, input);
}

export function listNodeUpdateJobs(nodeId: string) {
  return getApiData<UpdateJob[]>(`nodes/${nodeId}/updates/jobs`);
}

function fetchNodeRuntimesPayload(signal?: AbortSignal) {
  return getApiPayload<NodeRuntime[], NodeRuntimesPayload["meta"]>("node-runtimes", { signal });
}

export function useNodeRuntimesQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.nodeRuntimes,
    queryFn: ({ signal }) => fetchNodeRuntimesPayload(signal),
    select: (payload) => payload.data,
    retry: false,
  });
}

export function useNodeRuntimesPayloadQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.nodeRuntimes,
    queryFn: ({ signal }) => fetchNodeRuntimesPayload(signal),
    retry: false,
  });
}

export function nodeLocalFoldersQueryOptions(nodeId: string) {
  return queryOptions({
    queryKey: controlPlaneQueryKeys.nodeLocalFolders(nodeId),
    queryFn: ({ signal }) => getApiData<NodeLocalFolder[]>(`nodes/${nodeId}/local-folders`, { signal }),
    enabled: Boolean(nodeId),
    retry: false,
  });
}

export function useNodeLocalFoldersQuery(nodeId: MaybeRefOrGetter<string>) {
  const resolvedNodeId = computed(() => toValue(nodeId));
  return useQuery(computed(() => nodeLocalFoldersQueryOptions(resolvedNodeId.value)));
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
    queryKey: computed(() => controlPlaneQueryKeys.nodeImageCatalog(resolvedNodeId.value)),
    queryFn: () => getApiData<NodeImageAvailability[]>(`nodes/${resolvedNodeId.value}/image-options`),
    enabled: computed(() => Boolean(resolvedNodeId.value)),
    retry: false,
  });
}

export function listNodeControlPlanePairings(nodeId: string) {
  return getApiData<NodeControlPlanePairing[]>(`nodes/${nodeId}/control-plane-pairings`);
}

export function deleteNodeControlPlanePairing(nodeId: string, keyId: string) {
  return deleteApiData<{ deleted: boolean }>(`nodes/${nodeId}/control-plane-pairings/${encodeURIComponent(keyId)}`);
}

export function listNodeControlPlaneConnections(nodeId: string) {
  return getApiData<NodeControlPlaneConnection[]>(`nodes/${nodeId}/control-plane-connections`);
}

export function deleteNodeControlPlaneConnection(nodeId: string, connectionId: string) {
  return deleteApiData<{ deleted: boolean }>(`nodes/${nodeId}/control-plane-connections/${encodeURIComponent(connectionId)}`);
}

function fetchInstanceBoardPayload(signal?: AbortSignal) {
  return getApiPayload<InstanceBoardItem[], InstanceBoardPayload["meta"]>("instance-board", { signal });
}

function instanceBoardQueryOptions() {
  return {
    queryKey: controlPlaneQueryKeys.instanceBoard,
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchInstanceBoardPayload(signal),
    structuralSharing: mergeInstanceBoardQueryData,
    retry: false,
  } as const;
}

export function useInstanceBoardQuery() {
  return useQuery({
    ...instanceBoardQueryOptions(),
    select: (payload) => payload.data,
  });
}

export function getInstanceResourceMetrics(instanceId: string) {
  return getApiData<InstanceResourceMetrics>(`controlled-instances/${encodeURIComponent(instanceId)}/metrics`);
}

export function useInstanceBoardPayloadQuery() {
  return useQuery(instanceBoardQueryOptions());
}

export function useControlPlaneAiSessionsQuery() {
  return useQuery({
    queryKey: ["control-plane-ai-sessions"],
    queryFn: () => getApiData<ControlPlaneAiSessions>("ai-sessions"),
    retry: false,
  });
}

export function markAiSessionRead(instanceId: string, sessionId: string, sessionUpdatedAt: string) {
  return postApiData<import("./types").AiSessionUnreadState>(`controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}/read`, { sessionUpdatedAt });
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

export function updateControlPlaneTrigger(configHash: string, input: CreateControlPlaneTriggerInput) {
  return putApiData<Record<string, unknown>>(`triggers/${configHash}`, input);
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
    queryKey: controlPlaneQueryKeys.chatStatus,
    queryFn: () => getApiData<ChatGatewayStatus>("chat-gateway/status"),
    refetchInterval: 5000,
    retry: false,
  });
}

export function useChatBridgesQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.chatBridges,
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

export function createControlledInstance(input: CreateControlledInstanceInput) {
  return postApiData<CreateControlledInstanceResult>("controlled-instances", input);
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

export function uploadAiSessionAttachment(input: { instanceId: string; sessionId: string; kind: "image" | "file"; name: string; mime: string; data: string }) {
  return postApiData<AiSessionUploadedAttachment>("ai-session-attachments", input);
}

export function sendAiSessionMessage(instanceId: string, sessionId: string, message: string, mode?: "auto" | "queue" | "steer" | "immediate", attachments: AiSessionAttachmentRef[] = [], references: AiSessionReference[] = [], permissionMode?: import("@task-handoff/protocol/ai-sessions").AiSessionPermissionMode) {
  return postApiData<Record<string, unknown>>(`controlled-instances/${instanceId}/ai-sessions/${sessionId}/messages`, { message, mode, attachments, references, permissionMode });
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

export function getControlledInstanceConfigSyncState(instanceId: string) {
  return getApiData<import("@task-handoff/protocol/config-sync").ConfigSyncState>(`controlled-instances/${instanceId}/config-sync`);
}

export function listControlledInstanceConfigSyncFolders(instanceId: string, input: { path?: string; depth?: number } = {}) {
  const params = new URLSearchParams();
  if (input.path) params.set("path", input.path);
  if (input.depth !== undefined) params.set("depth", String(input.depth));
  const query = params.toString();
  return getApiData<NodeFolderTreeEntry[]>(`controlled-instances/${instanceId}/config-sync/folders${query ? `?${query}` : ""}`);
}

export function syncControlledInstanceConfigs(instanceId: string, input: import("@task-handoff/protocol/config-sync").ConfigSyncRequest) {
  return postApiData<import("@task-handoff/protocol/config-sync").ConfigSyncBatchResult>(`controlled-instances/${instanceId}/config-sync`, input);
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

export function deleteNode(id: string, force = false) {
  return deleteApiData<DeleteNodeResult>(`nodes/${id}${force ? "?force=true" : ""}`);
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

export function createNodeControlPlaneConnection(id: string, input: CreateNodeControlPlaneConnectionInput) {
  return postApiData<NodeControlPlaneConnectionCreateResult>(`nodes/${id}/control-plane-connections`, input);
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
