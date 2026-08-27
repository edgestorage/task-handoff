import { queryOptions, useQuery } from "@tanstack/vue-query";
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { NodeJoinInviteStatusSchema } from "@task-handoff/protocol/control-plane";
import { api, ApiError, deleteApiData, getApiData, getApiPayload, patchApiData, postApiData, putApiData, withApiError } from "./client";
import { mergeInstanceBoardQueryData } from "./instanceBoardMerge.ts";
import { controlPlaneQueryKeys } from "./queryKeys.ts";
import { sharedAiSessionsApi, sharedControlPlaneClient } from "./sharedClient.ts";
import type { ControlPlaneInstanceResourceEntry } from "@task-handoff/control-plane-client";
import type { GitCredentialCreateRequest, GitCredentialPublic, GitCredentialUpdateRequest, InstanceGitCredentialAssignment } from "@task-handoff/protocol/managed-git-credentials";
export { controlPlaneQueryKeys } from "./queryKeys.ts";
import type {
  ControlPlaneStatusResponse,
  ControlPlaneSettings,
  ControlPlaneAppSessions,
  AppSession,
  AuthSession,
  CreateNodeControlPlaneConnectionInput,
  CreateControlledInstanceInput,
  CreateControlledInstanceResult,
  CreateImageInput,
  CreateModelInput,
  CopyModelInput,
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
  ControlPlaneTriggerMutationResult,
  InstanceTriggerIndex,
  InstanceTriggerMutationResult,
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
  ModelDiscoveryResult,
  ModelEndpointDraft,
  ModelTestResult,
  FederatedModelRegistry,
  Node,
  NodeAgentExternalListener,
  NodeFolderTreeEntry,
  NodeJoinInvite,
  NodeLocalFolder,
  UpdateNodeLocalFolderInput,
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
  CloudConnectivity,
  CloudBindingChallenge,
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
    queryFn: () => sharedControlPlaneClient.auth.session(),
    retry: false,
  });
}

export function bootstrapAdmin(input: { username: string; password: string }) {
  return sharedControlPlaneClient.auth.bootstrapAdmin(input);
}

export function loginControlPlane(input: { username: string; password: string }) {
  return sharedControlPlaneClient.auth.login(input);
}

export function changeControlPlanePassword(input: { currentPassword: string; newPassword: string }) {
  return sharedControlPlaneClient.auth.changePassword(input);
}

export function logoutControlPlane() {
  return sharedControlPlaneClient.auth.logout();
}

export function useMobileSessionsQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: controlPlaneQueryKeys.mobileSessions,
    queryFn: ({ signal }) => sharedControlPlaneClient.auth.mobileSessions(signal),
    enabled: computed(() => toValue(enabled)),
    retry: false,
  });
}

export function revokeMobileSession(sessionId: string) {
  return sharedControlPlaneClient.auth.revokeMobileSession(sessionId);
}

export function useCurrentAccessQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: controlPlaneQueryKeys.currentAccess,
    queryFn: ({ signal }) => sharedControlPlaneClient.users.currentAuthorization(signal),
    enabled: computed(() => toValue(enabled)),
    retry: false,
    refetchInterval: 30_000,
  });
}

export function useUsersQuery(enabled: MaybeRefOrGetter<boolean> = true, includeArchived = false) {
  return useQuery({
    queryKey: [...controlPlaneQueryKeys.users, { includeArchived }],
    queryFn: ({ signal }) => sharedControlPlaneClient.users.list({ includeArchived }, signal),
    enabled: computed(() => toValue(enabled)),
    retry: false,
  });
}

export function usePermissionsQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({ queryKey: controlPlaneQueryKeys.permissions, queryFn: ({ signal }) => sharedControlPlaneClient.users.permissions(signal), enabled: computed(() => toValue(enabled)), retry: false });
}

export function useRolesQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: controlPlaneQueryKeys.roles,
    queryFn: ({ signal }) => sharedControlPlaneClient.users.roles(signal),
    enabled: computed(() => toValue(enabled)),
    retry: false,
  });
}

export function useIdentityProvidersQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: controlPlaneQueryKeys.identityProviders,
    queryFn: ({ signal }) => sharedControlPlaneClient.users.providers(signal),
    enabled: computed(() => toValue(enabled)),
    retry: false,
  });
}

export function useExternalIdentityApprovalsQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({ queryKey: controlPlaneQueryKeys.externalIdentityApprovals, queryFn: ({ signal }) => sharedControlPlaneClient.users.approvals(signal), enabled: computed(() => toValue(enabled)), retry: false });
}

export const createControlPlaneUser = (input: unknown) => sharedControlPlaneClient.users.create(input);
export const updateControlPlaneUser = (userId: string, input: import("@task-handoff/protocol/control-plane-access").ControlPlaneUpdateUserInput) => sharedControlPlaneClient.users.update(userId, input);
export const setControlPlaneUserAccess = (userId: string, input: unknown) => sharedControlPlaneClient.users.setAccess(userId, input);
export const getControlPlaneUserDetail = (userId: string) => sharedControlPlaneClient.users.detail(userId);
export const resetControlPlaneUserPassword = (userId: string, input: { password: string; requirePasswordChange?: boolean }) => sharedControlPlaneClient.users.resetPassword(userId, input);
export const listControlPlaneUserSessions = (userId: string) => sharedControlPlaneClient.users.sessions(userId);
export const revokeControlPlaneUserSession = (userId: string, sessionId: string) => sharedControlPlaneClient.users.revokeSession(userId, sessionId);
export const revokeAllControlPlaneUserSessions = (userId: string) => sharedControlPlaneClient.users.revokeAllSessions(userId);
export const unbindControlPlaneUserExternalIdentity = (userId: string, identityId: string) => sharedControlPlaneClient.users.unbindExternalIdentity(userId, identityId);
export const createControlPlaneRole = (input: unknown) => sharedControlPlaneClient.users.createRole(input);
export const updateControlPlaneRole = (roleId: string, input: unknown) => sharedControlPlaneClient.users.updateRole(roleId, input);
export const archiveControlPlaneRole = (roleId: string) => sharedControlPlaneClient.users.archiveRole(roleId);
export const createControlPlaneIdentityProvider = (input: unknown) => sharedControlPlaneClient.users.createProvider(input);
export const updateControlPlaneIdentityProvider = (providerId: string, input: unknown) => sharedControlPlaneClient.users.updateProvider(providerId, input);
export const removeControlPlaneIdentityProvider = (providerId: string) => sharedControlPlaneClient.users.removeProvider(providerId);
export const approveControlPlaneExternalIdentity = (approvalId: string, input: unknown) => sharedControlPlaneClient.users.approveIdentity(approvalId, input);
export const rejectControlPlaneExternalIdentity = (approvalId: string) => sharedControlPlaneClient.users.rejectIdentity(approvalId);

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

export function useCloudConnectivityQuery() {
  return useQuery({ queryKey: controlPlaneQueryKeys.cloudConnectivity, queryFn: () => getApiData<CloudConnectivity>("cloud-connectivity"), retry: false });
}

export function createCloudBindingChallenge() {
  return postApiData<CloudBindingChallenge>("cloud-connectivity/challenges", {});
}

export function updateCloudRemoteAccess(enabled: boolean) {
  return postApiData<CloudConnectivity>("cloud-connectivity/remote-access", { enabled });
}

export function disconnectCloudAccount() {
  return postApiData<CloudConnectivity>("cloud-connectivity/disconnect", {});
}

export async function downloadControlPlaneDiagnosticLogs() {
  const response = await withApiError(api.get("control-plane/diagnostic-logs/export"));
  const disposition = response.headers.get("content-disposition") || "";
  const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "task-handoff-diagnostic-logs.tar.gz";
  return { blob: await response.blob(), filename };
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
  return getApiData<FederatedModelRegistry>("models?progressive=true", { signal }).catch((error) => {
    // Compatibility for v0.0.21: progressive fleet reads are additive.
    if (!(error instanceof ApiError) || error.status !== 400 || error.code !== "VALIDATION_ERROR") throw error;
    return getApiData<FederatedModelRegistry>("models", { signal });
  });
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

export function useModelsQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: controlPlaneQueryKeys.models,
    queryFn: ({ signal }) => fetchModelRegistry(signal),
    select: modelConfigsFromRegistry,
    enabled: computed(() => toValue(enabled)),
    retry: false,
  });
}

export function useGitCredentialsQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: controlPlaneQueryKeys.gitCredentials,
    queryFn: ({ signal }) => getApiData<{ items: GitCredentialPublic[] }>("git-credentials", { signal }),
    select: (value) => value.items,
    enabled: computed(() => toValue(enabled)),
    retry: false,
  });
}

export function useInstanceGitCredentialAssignmentsQuery(instanceId: MaybeRefOrGetter<string>, enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: computed(() => controlPlaneQueryKeys.instanceGitCredentialAssignments(toValue(instanceId))),
    queryFn: ({ signal }) => getApiData<InstanceGitCredentialAssignment[]>(`controlled-instances/${encodeURIComponent(toValue(instanceId))}/git-credential-assignments`, { signal }),
    enabled: computed(() => Boolean(toValue(instanceId)) && toValue(enabled)),
    retry: false,
  });
}

export function useNodesQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: controlPlaneQueryKeys.nodes,
    queryFn: ({ signal }) => getApiData<Node[]>("nodes", { signal }),
    enabled: computed(() => toValue(enabled)),
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

export function cancelControlPlaneProxyClaim(id: string, force = false) {
  return deleteApiData<CancelProxyClaimResult>(`control-plane-proxy/pending-claims/${id}${force ? "?force=true" : ""}`);
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
  return getApiPayload<NodeRuntime[], NodeRuntimesPayload["meta"]>("node-runtimes?progressive=true", { signal }).catch((error) => {
    // Compatibility for v0.0.21: progressive fleet reads are additive.
    if (!(error instanceof ApiError) || error.status !== 400 || error.code !== "VALIDATION_ERROR") throw error;
    return getApiPayload<NodeRuntime[], NodeRuntimesPayload["meta"]>("node-runtimes", { signal });
  });
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

export function listNodeFolderPlaces(nodeId: string) {
  return getApiData<import("./types").NodeFolderPlace[]>(`nodes/${nodeId}/folders/places`);
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

export function useEnvironmentTemplatesQuery(nodeId: MaybeRefOrGetter<string>) {
  const resolvedNodeId = computed(() => toValue(nodeId));
  return useQuery({
    queryKey: computed(() => controlPlaneQueryKeys.environmentTemplates(resolvedNodeId.value)),
    queryFn: () => getApiData<import("./types").EnvironmentTemplate[]>(`nodes/${resolvedNodeId.value}/environment-templates`),
    enabled: computed(() => Boolean(resolvedNodeId.value)),
    retry: false,
  });
}

export function saveEnvironmentTemplate(instanceId: string, name: string) {
  return postApiData<import("./types").EnvironmentTemplate>(`controlled-instances/${instanceId}/environment-templates`, { name });
}

export function deleteEnvironmentTemplate(nodeId: string, templateId: string) {
  return deleteApiData<import("./types").EnvironmentTemplate>(`nodes/${nodeId}/environment-templates/${templateId}`);
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

export async function fetchInstanceBoardPayload(signal?: AbortSignal, instanceId = "") {
  const params = new URLSearchParams();
  params.set("progressive", "true");
  if (instanceId) params.set("instanceId", instanceId);
  const route = `instance-board?${params.toString()}`;
  try {
    return await getApiPayload<InstanceBoardItem[], InstanceBoardPayload["meta"]>(route, { signal });
  } catch (error) {
    // Compatibility for v0.0.21: its strict query schema rejects progressive
    // and instanceId, so current clients fall back to its blocking snapshot.
    if (!(error instanceof ApiError) || error.status !== 400 || error.code !== "VALIDATION_ERROR") throw error;
    const payload = await getApiPayload<InstanceBoardItem[], InstanceBoardPayload["meta"]>("instance-board", { signal });
    return { ...payload, data: instanceId ? payload.data.filter((item) => item.id === instanceId) : payload.data };
  }
}

export function instanceBoardQueryOptions(instanceId: MaybeRefOrGetter<string> = "") {
  return {
    queryKey: computed(() => controlPlaneQueryKeys.scopedInstanceBoard(toValue(instanceId))),
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchInstanceBoardPayload(signal, toValue(instanceId)),
    structuralSharing: mergeInstanceBoardQueryData,
    // The event stream owns normal convergence. HTTP is reserved for the
    // initial snapshot and explicit stream/event recovery.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  } as const;
}

export function useInstanceBoardQuery(instanceId: MaybeRefOrGetter<string> = "", enabled: MaybeRefOrGetter<boolean> = true) {
  const query = useQuery({
    ...instanceBoardQueryOptions(instanceId),
    enabled: computed(() => toValue(enabled)),
  });
  return {
    ...query,
    data: computed(() => query.data.value?.data),
    nodeStates: computed(() => query.data.value?.meta?.nodeStates || []),
    nodeErrors: computed(() => query.data.value?.meta?.nodeErrors || []),
  };
}

export function getInstanceResourceMetrics(instanceId: string) {
  return getApiData<InstanceResourceMetrics>(`controlled-instances/${encodeURIComponent(instanceId)}/metrics`);
}

export function useInstanceBoardPayloadQuery() {
  return useQuery(instanceBoardQueryOptions());
}

export function useInstanceDirectoryQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: controlPlaneQueryKeys.instanceDirectory,
    queryFn: async ({ signal }) => {
      try {
        return (await sharedControlPlaneClient.resources.instanceDirectory(signal)).data as ControlPlaneInstanceResourceEntry[];
      } catch (error) {
        // Compatibility for v0.0.21: progressive directory query parameters are additive.
        if (!(error instanceof ApiError) || error.status !== 400 || error.code !== "VALIDATION_ERROR") throw error;
        return sharedControlPlaneClient.resources.instanceBoard(signal) as Promise<ControlPlaneInstanceResourceEntry[]>;
      }
    },
    enabled: computed(() => toValue(enabled)),
    refetchInterval: 15_000,
    retry: false,
  });
}

export function useControlPlaneAiSessionsQuery(instanceId: MaybeRefOrGetter<string> = "", enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: computed(() => controlPlaneQueryKeys.aiSessions(toValue(instanceId))),
    queryFn: async ({ signal }) => {
      const scope = toValue(instanceId);
      const view = await sharedAiSessionsApi.list(signal, scope || undefined) as ControlPlaneAiSessions;
      return scope ? { ...view, instances: view.instances.filter((entry) => entry.instanceId === scope) } : view;
    },
    enabled: computed(() => toValue(enabled)),
    // Summary state advances through the revisioned AI Session stream. Stream
    // recovery performs HTTP reads only when the authoritative revision requires it.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}

export function markAiSessionRead(instanceId: string, sessionId: string, sessionUpdatedAt: string) {
  return sharedAiSessionsApi.markRead(instanceId, sessionId, sessionUpdatedAt);
}

export function getAiSessionHistory(instanceId: string) {
  return sharedAiSessionsApi.history(instanceId);
}

export function getAiSessionHistoryDetail(instanceId: string, aiSessionId: string) {
  return sharedAiSessionsApi.historyDetail(instanceId, aiSessionId);
}

export function getAiSessionDetail(instanceId: string, aiSessionId: string, revision?: string, signal?: AbortSignal) {
  return sharedAiSessionsApi.detail(instanceId, aiSessionId, revision, signal);
}

export function getAiSessionTurnIndex(instanceId: string, aiSessionId: string, revision?: string, signal?: AbortSignal) {
  return sharedAiSessionsApi.turnIndex(instanceId, aiSessionId, revision, signal);
}

export function getAiSessionTurnBody(instanceId: string, aiSessionId: string, turnId: string, revision?: string, signal?: AbortSignal) {
  return sharedAiSessionsApi.turnBody(instanceId, aiSessionId, turnId, revision, signal);
}

export function getAiSessionTimeline(instanceId: string, aiSessionId: string, signal?: AbortSignal) {
  return sharedAiSessionsApi.timeline(instanceId, aiSessionId, signal);
}

export function getAiSessionTurnTimeline(instanceId: string, aiSessionId: string, turnId: string, signal?: AbortSignal) {
  return sharedAiSessionsApi.turnTimeline(instanceId, aiSessionId, turnId, signal);
}

export function resumeAiSession(instanceId: string, aiSessionId: string) {
  return sharedAiSessionsApi.resume(instanceId, aiSessionId);
}

export function createAiSession(instanceId: string, input: import("@task-handoff/protocol/ai-sessions").AiSessionCreateRefInput & {
  gitSelection?: import("@task-handoff/protocol/repository").RepositoryAiSessionGitSelection;
}) {
  return sharedAiSessionsApi.create(instanceId, input);
}

export function updateAiSessionModelSelection(instanceId: string, aiSessionId: string, clientRequestId: string, modelSelection: import("@task-handoff/protocol/ai-sessions").AiSessionModelSelection) {
  return sharedAiSessionsApi.updateModelSelection(instanceId, aiSessionId, clientRequestId, modelSelection);
}

export function updateAiSessionReasoningEffort(instanceId: string, aiSessionId: string, clientRequestId: string, reasoningEffort: import("@task-handoff/protocol/ai-sessions").AiSessionReasoningEffort) {
  return sharedAiSessionsApi.updateReasoningEffort(instanceId, aiSessionId, clientRequestId, reasoningEffort);
}

export function forkAiSession(instanceId: string, aiSessionId: string, input: import("@task-handoff/protocol/ai-sessions").AiSessionForkInput) {
  return sharedAiSessionsApi.fork(instanceId, aiSessionId, input);
}

export function getAiSessionWorkspace(instanceId: string, cwdFolderId?: string, signal?: AbortSignal) {
  return sharedAiSessionsApi.workspace(instanceId, cwdFolderId, signal);
}

export function openAiSessionApp(instanceId: string, aiSessionId: string, clientRequestId: string) {
  return sharedAiSessionsApi.openApp(instanceId, aiSessionId, clientRequestId);
}

export function closeAiSession(instanceId: string, aiSessionId: string, clientRequestId: string) {
  return sharedAiSessionsApi.close(instanceId, aiSessionId, clientRequestId);
}

export function useControlPlaneAppSessionsQuery(instanceId: MaybeRefOrGetter<string> = "", enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: computed(() => controlPlaneQueryKeys.appSessions(toValue(instanceId))),
    queryFn: async ({ signal }) => {
      const scope = toValue(instanceId);
      const view = await sharedControlPlaneClient.appSessions.list(signal, scope || undefined) as ControlPlaneAppSessions;
      return scope ? { ...view, instances: view.instances.filter((entry) => entry.instanceId === scope) } : view;
    },
    enabled: computed(() => toValue(enabled)),
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
  return putApiData<ControlPlaneTriggerMutationResult>(`triggers/${configHash}`, input);
}

export function deleteControlPlaneTrigger(configHash: string) {
  return deleteApiData<ControlPlaneTriggerMutationResult>(`triggers/${configHash}`);
}

export function applyControlPlaneTrigger(configHash: string, instanceIds: string[]) {
  return postApiData<Record<string, unknown>>(`triggers/${configHash}/apply`, { instanceIds });
}

export function bindAiSessionTrigger(instanceId: string, sessionId: string, configHash: string) {
  return postApiData<InstanceTriggerMutationResult>(`controlled-instances/${instanceId}/ai-sessions/${sessionId}/triggers`, { configHash });
}

export function unbindAiSessionTrigger(instanceId: string, sessionId: string, configHash: string) {
  return deleteApiData<Record<string, unknown>>(`controlled-instances/${instanceId}/ai-sessions/${sessionId}/triggers/${configHash}`);
}

export function getControlledInstanceTriggers(instanceId: string) {
  return getApiData<InstanceTriggerIndex>(`controlled-instances/${instanceId}/triggers`);
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

export function deleteControlledInstance(id: string, deleteVolumes: boolean) {
  return deleteApiData<import("@task-handoff/protocol/control-plane").InstanceDeleteResult>(`controlled-instances/${id}`, { deleteVolumes });
}

export function launchAppSession(instanceId: string, input: LaunchAppSessionInput = {}) {
  return postApiData<AppSession>(`controlled-instances/${instanceId}/apps/sessions`, input);
}

export function stopAppSession(instanceId: string, sessionId: string) {
  return sharedControlPlaneClient.appSessions.stop(instanceId, sessionId);
}

export function renameAppSession(instanceId: string, sessionId: string, title: string) {
  return sharedControlPlaneClient.appSessions.rename(instanceId, sessionId, title);
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

export function uploadAiSessionAttachment(input: { instanceId: string; sessionId: string; scopeType?: "session" | "create-request"; kind: "image" | "file"; name: string; mime: string; data: string }, onProgress?: (progress: number) => void) {
  return sharedAiSessionsApi.uploadAttachment(input, onProgress);
}

export function sendAiSessionMessage(instanceId: string, sessionId: string, message: string, mode?: "auto" | "queue" | "steer" | "immediate", attachments: AiSessionAttachmentRef[] = [], references: AiSessionReference[] = [], permissionMode?: import("@task-handoff/protocol/ai-sessions").AiSessionPermissionMode) {
  return sharedAiSessionsApi.sendMessage(instanceId, sessionId, { message, mode, attachments, references, permissionMode });
}

export function getAiSessionMentionCatalog(instanceId: string, sessionId: string, signal?: AbortSignal) {
  return sharedAiSessionsApi.mentionCatalog(instanceId, sessionId, signal);
}

export function searchAiSessionMentionFiles(instanceId: string, sessionId: string, query: string, signal?: AbortSignal) {
  return sharedAiSessionsApi.searchMentionFiles(instanceId, sessionId, query, signal);
}

export function steerAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
  return sharedAiSessionsApi.steerQueue(instanceId, sessionId, queueId);
}

export function retryAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
  return sharedAiSessionsApi.retryQueue(instanceId, sessionId, queueId);
}

export function removeAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string) {
  return sharedAiSessionsApi.removeQueue(instanceId, sessionId, queueId);
}

export function editAiSessionQueuedMessage(instanceId: string, sessionId: string, queueId: string, expectedRevision: number, message: string) {
  return sharedAiSessionsApi.editQueue(instanceId, sessionId, queueId, { expectedRevision, message });
}

export function reorderAiSessionQueuedMessages(instanceId: string, sessionId: string, expectedRevision: number, queueIds: string[]) {
  return sharedAiSessionsApi.reorderQueue(instanceId, sessionId, { expectedRevision, queueIds });
}

export function interruptAiSession(instanceId: string, sessionId: string) {
  return sharedAiSessionsApi.interrupt(instanceId, sessionId);
}

export function resolveAiSessionApproval(instanceId: string, sessionId: string, decision: "allow" | "deny" | "skip") {
  return sharedAiSessionsApi.approval(instanceId, sessionId, decision);
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

export function copyModel(id: string, input: CopyModelInput) {
  return postApiData<ModelConfig>(`models/${id}/copy`, input);
}

export function updateModel(id: string, input: UpdateModelInput) {
  return patchApiData<ModelConfig>(`models/${id}`, input);
}

export function deleteModel(id: string) {
  return deleteApiData<{ deleted: boolean }>(`models/${id}`);
}

export function createGitCredential(input: GitCredentialCreateRequest) {
  return postApiData<GitCredentialPublic>("git-credentials", input);
}

export function updateGitCredential(id: string, input: GitCredentialUpdateRequest) {
  return patchApiData<GitCredentialPublic>(`git-credentials/${id}`, input);
}

export function deleteGitCredential(id: string) {
  return deleteApiData<{ deleted: boolean }>(`git-credentials/${id}`);
}

export function authorizeInstanceGitCredential(instanceId: string, credentialId: string) {
  return postApiData<InstanceGitCredentialAssignment>(`controlled-instances/${encodeURIComponent(instanceId)}/git-credential-assignments`, { credentialId });
}

export function revokeInstanceGitCredential(instanceId: string, credentialId: string) {
  return deleteApiData<{ revoked: boolean }>(`controlled-instances/${encodeURIComponent(instanceId)}/git-credential-assignments/${encodeURIComponent(credentialId)}`);
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

export function discoverModels(input: ModelEndpointDraft, nodeId?: string) {
  return postApiData<ModelDiscoveryResult>(nodeId ? `nodes/${nodeId}/models/discover` : "models/discover", input);
}

export function testModel(input: ModelEndpointDraft & { model: string; app?: "codex" | "claude" | "opencode" }, nodeId?: string) {
  return postApiData<ModelTestResult>(nodeId ? `nodes/${nodeId}/models/test` : "models/test", input);
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

export function getNodeJoinInviteStatus(id: string, signal?: AbortSignal) {
  return getApiData<unknown>(`node-join/invites/${encodeURIComponent(id)}`, { signal })
    .then((value) => NodeJoinInviteStatusSchema.parse(value));
}

export function createNodeLocalFolder(nodeId: string, input: CreateNodeLocalFolderInput) {
  return postApiData<NodeLocalFolder>(`nodes/${nodeId}/local-folders`, input);
}

export function updateNodeLocalFolder(nodeId: string, folderId: string, input: UpdateNodeLocalFolderInput) {
  return patchApiData<NodeLocalFolder>(`nodes/${nodeId}/local-folders/${folderId}`, input);
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
