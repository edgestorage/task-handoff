import { queryOptions, useQuery } from "@tanstack/vue-query";
import { computed, toValue, type MaybeRefOrGetter } from "vue";
import { NodeJoinInviteStatusSchema } from "@task-handoff/protocol/control-plane";
import { api, ApiError, deleteApiData, getApiData, getApiPayload, patchApiData, postApiData, putApiData, withApiError } from "./client";
import { mergeAppSessionQueryData } from "./appSessionMerge.ts";
import { mergeInstanceBoardQueryData } from "./instanceBoardMerge.ts";
import { controlPlaneQueryKeys } from "./queryKeys.ts";
import { sharedAiSessionsApi, sharedControlPlaneClient } from "./sharedClient.ts";
import type { ControlPlaneInstanceResourceEntry } from "@task-handoff/control-plane-client";
import type { GitCredentialCreateRequest, GitCredentialPublic, GitCredentialUpdateRequest, InstanceGitCredentialAssignment } from "@task-handoff/protocol/managed-git-credentials";
import type { Story, StoryDecision, StoryDecisionDecideInput, StoryDecisionCancelInput } from "@task-handoff/protocol/stories";
import type { AgentDefinitionCreateInput, AgentDefinitionUpdateInput } from "@task-handoff/protocol/agent-definitions";
import type { AgentOrchestrationCreateInput, AgentOrchestrationUpdateInput } from "@task-handoff/protocol/agent-orchestrations";
import type { AgentRunManualCreateInput } from "@task-handoff/protocol/agent-runs";
import type { AiSessionQueueEditInput } from "@task-handoff/protocol/ai-sessions";
export { controlPlaneQueryKeys } from "./queryKeys.ts";
import type { AiSessionAttachmentRef, AiSessionHistoryDetail, AiSessionHistoryList, AiSessionMentionCatalog, AiSessionMentionFileSearch, AiSessionReference, AiSessionResumeResult, AiSessionUploadedAttachment, AppManagementJobResponse, AppManagementSnapshot, AppSession, ApplyUpdateRequest, AuthSession, CancelProxyClaimResult, ChatBridgeConfig, ChatChannel, ChatGatewayStatus, ClaimProxyNodeResult, CloudBindingChallenge, CloudConnectivity, ControlPlaneAiSessions, ControlPlaneAppSessions, ControlPlaneProxyDiagnostic, ControlPlaneSettings, ControlPlaneStatusResponse, ControlPlaneTriggerMutationResult, ControlPlaneTriggers, CopyModelInput, CreateChatBridgeInput, CreateControlPlaneTriggerInput, CreateControlledInstanceInput, CreateControlledInstanceResult, CreateImageInput, CreateModelInput, CreateNodeControlPlaneConnectionInput, CreateNodeInput, CreateNodeLocalFolderInput, CreateNodeRuntimeInput, CreateProjectInput, CreateProxyInviteResult, DeleteNodeResult, FederatedModelRegistry, HealthResponse, ImageProfile, InstanceBoardItem, InstanceBoardPayload, InstanceResourceMetrics, InstanceTriggerIndex, InstanceTriggerMutationResult, LaunchAppSessionInput, LocalDockerImage, MarketCatalog, ModelConfig, ModelDiscoveryResult, ModelEndpointDraft, ModelMergeResult, ModelMutationResult, ModelTestResult, Node, NodeAgentExternalListener, NodeAgentModelRelay, NodeControlPlaneConnection, NodeControlPlaneConnectionCreateResult, NodeControlPlanePairing, NodeFolderTreeEntry, NodeImageAvailability, NodeJoinInvite, NodeLocalFolder, NodePairingInvite, NodeRuntime, NodeRuntimesPayload, NodeStatus, Project, PublicPendingProxyClaim, PublicProxyBinding, PublicProxyInvite, SelectableImage, UpdateChannel, UpdateChatBridgeInput, UpdateCheckResult, UpdateControlledInstanceInput, UpdateJob, UpdateModelInput, UpdateNodeAgentExternalListener, UpdateNodeAgentModelRelay, UpdateNodeInput, UpdateNodeLocalFolderInput, UpdateProjectInput } from "./types";

/**
 * Several control plane UI view models in `./types.ts` stay looser than the
 * shared wire schemas: they keep legacy optional fields, accept form drafts, and
 * omit newer protocol variants their views do not render yet (for example
 * `git-template` in `ProjectSource`). The shared client still validates the wire
 * model, then this re-asserts the established UI shape so existing consumers keep
 * their contracts instead of every view being rewritten in the same change.
 */
function asUiModel<T>(promise: Promise<unknown>): Promise<T> {
  return promise as Promise<T>;
}

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

export function useCliAuthorizationRequestQuery(requestId: MaybeRefOrGetter<string | undefined>) {
  return useQuery({
    queryKey: computed(() => ["cli-authorization-request", toValue(requestId)]),
    queryFn: ({ signal }) => sharedControlPlaneClient.auth.cliAuthorizationRequest(toValue(requestId) as string, signal),
    enabled: computed(() => Boolean(toValue(requestId))),
    retry: false,
  });
}

export function useCliAuthorizationRequestByUserCodeQuery(userCode: MaybeRefOrGetter<string | undefined>) {
  return useQuery({
    queryKey: computed(() => ["cli-authorization-request-by-code", toValue(userCode)]),
    queryFn: ({ signal }) => sharedControlPlaneClient.auth.cliAuthorizationRequestByUserCode(toValue(userCode) as string, signal),
    enabled: computed(() => Boolean(toValue(userCode))),
    retry: false,
  });
}

export function approveCliAuthorization(requestId: string) {
  return sharedControlPlaneClient.auth.approveCliAuthorization(requestId);
}

export function denyCliAuthorization(requestId: string) {
  return sharedControlPlaneClient.auth.denyCliAuthorization(requestId);
}

export function useMobileSessionsQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: controlPlaneQueryKeys.mobileSessions,
    queryFn: ({ signal }) => sharedControlPlaneClient.auth.mobileSessions(signal),
    enabled: computed(() => toValue(enabled)),
    retry: false,
  });
}

export function useCliSessionsQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: controlPlaneQueryKeys.cliSessions,
    queryFn: ({ signal }) => sharedControlPlaneClient.auth.cliSessions(signal),
    enabled: computed(() => toValue(enabled)),
    retry: false,
  });
}

export function revokeMobileSession(sessionId: string) {
  return sharedControlPlaneClient.auth.revokeMobileSession(sessionId);
}

export function revokeCliSession(sessionId: string) {
  return sharedControlPlaneClient.auth.revokeCliSession(sessionId);
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
    queryFn: () => sharedControlPlaneClient.admin.status(),
    retry: false,
  });
}

export function useControlPlaneSettingsQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.settings,
    queryFn: () => sharedControlPlaneClient.admin.getSettings(),
    retry: false,
  });
}

export function updateControlPlaneSettings(input: Partial<ControlPlaneSettings>) {
  return sharedControlPlaneClient.admin.updateSettings(input);
}

export function useCloudConnectivityQuery() {
  return useQuery({ queryKey: controlPlaneQueryKeys.cloudConnectivity, queryFn: () => sharedControlPlaneClient.admin.cloudConnectivity(), retry: false });
}

export function createCloudBindingChallenge() {
  return sharedControlPlaneClient.admin.createCloudChallenge();
}

export function updateCloudRemoteAccess(enabled: boolean) {
  return sharedControlPlaneClient.admin.setCloudRemoteAccess(enabled);
}

export function disconnectCloudAccount() {
  return sharedControlPlaneClient.admin.disconnectCloud();
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
    queryFn: () => asUiModel<Project[]>(sharedControlPlaneClient.catalog.listProjects()),
    retry: false,
  });
}

export function useImagesQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.images,
    queryFn: () => asUiModel<ImageProfile[]>(sharedControlPlaneClient.catalog.listImages()),
    retry: false,
  });
}

export function useMarketCatalogQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.marketCatalog,
    queryFn: () => asUiModel<MarketCatalog>(sharedControlPlaneClient.catalog.marketCatalog()),
    retry: false,
  });
}

export function useImageOptionsQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.imageOptions,
    queryFn: () => asUiModel<SelectableImage[]>(sharedControlPlaneClient.catalog.imageOptions()),
    retry: false,
  });
}

function fetchModelRegistry(signal?: AbortSignal) {
  return sharedControlPlaneClient.catalog.listModels({ progressive: true, signal }).catch((error) => {
    // Compatibility for v0.0.21: progressive fleet reads are additive.
    if (!(error instanceof ApiError) || error.status !== 400 || error.code !== "VALIDATION_ERROR") throw error;
    return sharedControlPlaneClient.catalog.listModels({ signal });
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
    queryFn: ({ signal }) => sharedControlPlaneClient.gitCredentials.listCredentials(signal),
    select: (value) => value.items,
    enabled: computed(() => toValue(enabled)),
    retry: false,
  });
}

export function useInstanceGitCredentialAssignmentsQuery(instanceId: MaybeRefOrGetter<string>, enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: computed(() => controlPlaneQueryKeys.instanceGitCredentialAssignments(toValue(instanceId))),
    queryFn: ({ signal }) => sharedControlPlaneClient.gitCredentials.listInstanceAssignments(toValue(instanceId), signal),
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
    queryFn: ({ signal }) => sharedControlPlaneClient.admin.proxyInvites(signal),
    retry: false,
  });
}

export function createControlPlaneProxyInvite(input: { targetNodeId: string; expiresInSeconds?: number }) {
  return asUiModel<CreateProxyInviteResult>(sharedControlPlaneClient.admin.createProxyInvite(input));
}

export function revokeControlPlaneProxyInvite(id: string) {
  return sharedControlPlaneClient.admin.revokeProxyInvite(id);
}

export function useControlPlaneProxyBindingsQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.controlPlaneProxyBindings,
    queryFn: ({ signal }) => sharedControlPlaneClient.admin.proxyBindings(signal),
    retry: false,
  });
}

export function revokeControlPlaneProxyBinding(id: string) {
  return deleteApiData<{ binding: PublicProxyBinding; closed: { abortedRequests: number; closedSockets: number } }>(`control-plane-proxy/bindings/${id}`);
}

export function useControlPlaneProxyDiagnosticsQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.controlPlaneProxyDiagnostics,
    queryFn: ({ signal }) => sharedControlPlaneClient.admin.proxyDiagnostics(signal),
    retry: false,
  });
}

export function usePendingControlPlaneProxyClaimsQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.controlPlaneProxyPendingClaims,
    queryFn: ({ signal }) => sharedControlPlaneClient.admin.pendingProxyClaims(signal),
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
  return sharedControlPlaneClient.nodeAdmin.checkUpdate(nodeId, { channel });
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
  return sharedControlPlaneClient.nodeAdmin.applyUpdate(nodeId, input);
}

export function listNodeUpdateJobs(nodeId: string) {
  return sharedControlPlaneClient.nodeAdmin.updateJobs(nodeId);
}

function fetchNodeRuntimesPayload(signal?: AbortSignal) {
  return sharedControlPlaneClient.nodeAdmin.listAllRuntimes({ progressive: true, signal }).catch((error) => {
    // Compatibility for v0.0.21: progressive fleet reads are additive.
    if (!(error instanceof ApiError) || error.status !== 400 || error.code !== "VALIDATION_ERROR") throw error;
    return sharedControlPlaneClient.nodeAdmin.listAllRuntimes({ signal });
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
    queryFn: ({ signal }) => sharedControlPlaneClient.nodeAdmin.listFolders(nodeId, signal),
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
  return sharedControlPlaneClient.nodeAdmin.listFolderTree(nodeId, input);
}

export function listNodeFolderPlaces(nodeId: string) {
  return sharedControlPlaneClient.nodeAdmin.listFolderPlaces(nodeId);
}

export function useLocalDockerImagesQuery(nodeId: MaybeRefOrGetter<string>) {
  const resolvedNodeId = computed(() => toValue(nodeId));
  return useQuery({
    queryKey: computed(() => ["node-docker-images", resolvedNodeId.value]),
    queryFn: () => sharedControlPlaneClient.nodeAdmin.listDockerImages(resolvedNodeId.value),
    enabled: false,
    retry: false,
  });
}

export function useNodeImageAvailabilityQuery(nodeId: MaybeRefOrGetter<string>) {
  const resolvedNodeId = computed(() => toValue(nodeId));
  return useQuery({
    queryKey: computed(() => controlPlaneQueryKeys.nodeImageCatalog(resolvedNodeId.value)),
    queryFn: () => asUiModel<NodeImageAvailability[]>(sharedControlPlaneClient.nodeAdmin.imageOptions(resolvedNodeId.value)),
    enabled: computed(() => Boolean(resolvedNodeId.value)),
    retry: false,
  });
}

export function useEnvironmentTemplatesQuery(nodeId: MaybeRefOrGetter<string>) {
  const resolvedNodeId = computed(() => toValue(nodeId));
  return useQuery({
    queryKey: computed(() => controlPlaneQueryKeys.environmentTemplates(resolvedNodeId.value)),
    queryFn: () => sharedControlPlaneClient.environmentTemplates.listForNode(resolvedNodeId.value),
    enabled: computed(() => Boolean(resolvedNodeId.value)),
    retry: false,
  });
}

export function saveEnvironmentTemplate(instanceId: string, name: string) {
  return sharedControlPlaneClient.environmentTemplates.createFromInstance(instanceId, { name });
}

export function deleteEnvironmentTemplate(nodeId: string, templateId: string) {
  return sharedControlPlaneClient.environmentTemplates.remove(nodeId, templateId);
}

export function listNodeControlPlanePairings(nodeId: string) {
  return sharedControlPlaneClient.nodeAdmin.listControlPlanePairings(nodeId);
}

export function deleteNodeControlPlanePairing(nodeId: string, keyId: string) {
  return sharedControlPlaneClient.nodeAdmin.removeControlPlanePairing(nodeId, keyId);
}

export function listNodeControlPlaneConnections(nodeId: string) {
  return sharedControlPlaneClient.nodeAdmin.listControlPlaneConnections(nodeId);
}

export function deleteNodeControlPlaneConnection(nodeId: string, connectionId: string) {
  return sharedControlPlaneClient.nodeAdmin.removeControlPlaneConnection(nodeId, connectionId);
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

export function useInstanceDirectoryQuery(
  enabled: MaybeRefOrGetter<boolean> = true,
  eventStreamAuthoritative: MaybeRefOrGetter<boolean> = false,
) {
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
    // Lifecycle events own normal convergence. The event connection recovers
    // this authoritative snapshot on every socket generation. Compatibility
    // for v0.0.28 and older: retain polling until the stream proves that it
    // supports the authoritative session-stream handshake.
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: computed(() => toValue(eventStreamAuthoritative) ? false : 15_000),
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

export function markAiSessionRead(instanceId: string, sessionId: string) {
  return sharedAiSessionsApi.markRead(instanceId, sessionId);
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

export function resumeAiSession(instanceId: string, aiSessionId: string, input: import("@task-handoff/protocol/ai-sessions").AiSessionResumeInput = {}) {
  return sharedAiSessionsApi.resume(instanceId, aiSessionId, input);
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

export function checkoutAiSessionWorkspaceBranch(instanceId: string, input: { cwdFolderId?: string; branch: string }) {
  return sharedAiSessionsApi.checkoutWorkspaceBranch(instanceId, input);
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
    structuralSharing: mergeAppSessionQueryData,
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
    queryFn: () => sharedControlPlaneClient.chatGateway.status(),
    refetchInterval: 5000,
    retry: false,
  });
}

export function useChatBridgesQuery() {
  return useQuery({
    queryKey: controlPlaneQueryKeys.chatBridges,
    queryFn: () => sharedControlPlaneClient.chatGateway.listBridges(),
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

export function useInstanceAppProfilesQuery(
  instanceId: MaybeRefOrGetter<string>,
  appId: MaybeRefOrGetter<string>,
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  return useQuery({
    queryKey: computed(() => controlPlaneQueryKeys.instanceAppProfiles(toValue(instanceId), toValue(appId))),
    queryFn: ({ signal }) => sharedControlPlaneClient.appProfiles.list(toValue(instanceId), toValue(appId), signal),
    enabled: computed(() => toValue(enabled) && Boolean(toValue(instanceId)) && Boolean(toValue(appId))),
    retry: false,
  });
}

export function createInstanceAppProfile(instanceId: string, appId: string, name: string) {
  return sharedControlPlaneClient.appProfiles.create(instanceId, appId, name);
}

export function renameInstanceAppProfile(instanceId: string, appId: string, profileId: string, name: string) {
  return sharedControlPlaneClient.appProfiles.rename(instanceId, appId, profileId, name);
}

export function setDefaultInstanceAppProfile(instanceId: string, appId: string, profileId: string) {
  return sharedControlPlaneClient.appProfiles.setDefault(instanceId, appId, profileId);
}

export function removeInstanceAppProfile(instanceId: string, appId: string, profileId: string) {
  return sharedControlPlaneClient.appProfiles.remove(instanceId, appId, profileId);
}

export function renameAppSession(instanceId: string, sessionId: string, title: string) {
  return sharedControlPlaneClient.appSessions.rename(instanceId, sessionId, title);
}

export function renameAiSession(instanceId: string, sessionId: string, input: import("@task-handoff/protocol/ai-sessions").AiSessionRenameInput) {
  return sharedAiSessionsApi.rename(instanceId, sessionId, input);
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

export function editAiSessionQueuedMessage(
  instanceId: string,
  sessionId: string,
  queueId: string,
  expectedRevision: number,
  message: string,
  attachments?: AiSessionQueueEditInput["attachments"],
) {
  return sharedAiSessionsApi.editQueue(instanceId, sessionId, queueId, { expectedRevision, message, attachments });
}

export function reorderAiSessionQueuedMessages(instanceId: string, sessionId: string, expectedRevision: number, queueIds: string[]) {
  return sharedAiSessionsApi.reorderQueue(instanceId, sessionId, { expectedRevision, queueIds });
}

export function setAiSessionQueuePaused(instanceId: string, sessionId: string, paused: boolean) {
  return sharedAiSessionsApi.pauseQueue(instanceId, sessionId, { paused });
}

export function interruptAiSession(instanceId: string, sessionId: string) {
  return sharedAiSessionsApi.interrupt(instanceId, sessionId);
}

export function resolveAiSessionApproval(instanceId: string, sessionId: string, decision: "allow" | "deny" | "skip") {
  return sharedAiSessionsApi.approval(instanceId, sessionId, decision);
}

export function listStories(nodeId?: string) {
  const query = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : "";
  return getApiData<{ stories: Story[]; unavailableNodeIds: string[] }>(`stories${query}`);
}

// The event stream owns normal convergence. Keep the last authoritative Story
// snapshot across view remounts and refetch only after invalidation.
const storySnapshotQueryOptions = {
  staleTime: Infinity,
  gcTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
} as const;

/**
 * Node-scoped Story list query. Node agents answer independently, so consumers
 * read one query per node and render nodes as soon as they respond.
 */
export function storyNodeQueryOptions(nodeId: string, enabled: MaybeRefOrGetter<boolean> = true) {
  return queryOptions({
    queryKey: controlPlaneQueryKeys.stories(nodeId),
    queryFn: () => listStories(nodeId),
    enabled: Boolean(nodeId) && toValue(enabled),
    ...storySnapshotQueryOptions,
  });
}

export function useStoriesQuery(nodeId?: MaybeRefOrGetter<string | undefined>, enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: computed(() => controlPlaneQueryKeys.stories(toValue(nodeId))),
    queryFn: () => listStories(toValue(nodeId)),
    enabled: computed(() => toValue(enabled)),
    ...storySnapshotQueryOptions,
  });
}

export function storyAgentEntriesQueryOptions(storyId: string, nodeId: string, enabled: MaybeRefOrGetter<boolean> = true) {
  return queryOptions({
    queryKey: controlPlaneQueryKeys.storyAgentEntries(nodeId, storyId),
    queryFn: () => sharedControlPlaneClient.agents.storyEntries(storyId, nodeId),
    enabled: Boolean(storyId && nodeId) && toValue(enabled),
    ...storySnapshotQueryOptions,
  });
}

export function getStoryRetentionSettings(storyId: string, nodeId: string) {
  return sharedControlPlaneClient.stories.retentionSettings(storyId, nodeId);
}

export function storyDecisionsQueryOptions(storyId: MaybeRefOrGetter<string>, nodeId: MaybeRefOrGetter<string>, enabled: MaybeRefOrGetter<boolean> = true) {
  return queryOptions({
    queryKey: computed(() => controlPlaneQueryKeys.storyDecisions(toValue(nodeId), toValue(storyId))),
    queryFn: () => sharedControlPlaneClient.stories.listDecisions(toValue(storyId), toValue(nodeId)),
    enabled: computed(() => Boolean(toValue(storyId) && toValue(nodeId)) && toValue(enabled)),
    ...storySnapshotQueryOptions,
  });
}

export function decideStoryDecision(storyId: string, decisionId: string, nodeId: string, input: StoryDecisionDecideInput): Promise<StoryDecision> {
  return sharedControlPlaneClient.stories.decideStory(storyId, decisionId, nodeId, input);
}

export function cancelStoryDecision(storyId: string, decisionId: string, nodeId: string, input: StoryDecisionCancelInput): Promise<StoryDecision> {
  return sharedControlPlaneClient.stories.cancelDecision(storyId, decisionId, nodeId, input);
}

export function assignAiSessionToStory(instanceId: string, sessionId: string, storyId: string | null) {
  return putApiData<Record<string, unknown>>(
    `controlled-instances/${encodeURIComponent(instanceId)}/ai-sessions/${encodeURIComponent(sessionId)}/story`,
    { storyId },
  );
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
  return patchApiData<ModelMutationResult>(`models/${id}`, input);
}

export function syncModel(id: string) {
  return postApiData<ModelMutationResult>(`models/${id}/sync`, {});
}

export function mergeModel(id: string, targetModelId: string) {
  return postApiData<ModelMergeResult>(`models/${id}/merge`, { targetModelId });
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

export function retryInstanceGitProvisioning(id: string) {
  return postApiData<InstanceBoardItem>(`controlled-instances/${id}/git-provisioning/retry`, {});
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

export function getNodeModelRelay(id: string) {
  return getApiData<NodeAgentModelRelay>(`nodes/${id}/settings/model-relay`);
}

export function updateNodeModelRelay(id: string, input: UpdateNodeAgentModelRelay) {
  return patchApiData<NodeAgentModelRelay>(`nodes/${id}/settings/model-relay`, input);
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

/**
 * AgentDefinition 目录按 Node 独立读取：每个 Node Agent 只回答自己的定义，
 * 列表随各 Node 响应逐步出现，不等待最慢的 Node。写操作始终带 nodeId 路由回定义所属 Node。
 */
export function listAgents(nodeId?: string) {
  return sharedControlPlaneClient.agents.list(nodeId);
}

// 授权事件是常态收敛路径。视图重挂载时先复用最后一次权威快照，只在失效后才重新拉取。
const agentSnapshotQueryOptions = {
  staleTime: Infinity,
  gcTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  retry: false,
} as const;

export function agentNodeQueryOptions(nodeId: string, enabled: MaybeRefOrGetter<boolean> = true) {
  return queryOptions({
    queryKey: controlPlaneQueryKeys.agents(nodeId),
    queryFn: () => listAgents(nodeId),
    enabled: Boolean(nodeId) && toValue(enabled),
    ...agentSnapshotQueryOptions,
  });
}

export function listAgentOrchestrations(nodeId?: string) {
  return sharedControlPlaneClient.agents.listOrchestrations(nodeId);
}

export function agentOrchestrationsQueryOptions(nodeId: string, enabled: MaybeRefOrGetter<boolean> = true) {
  return queryOptions({
    queryKey: controlPlaneQueryKeys.agentOrchestrations(nodeId),
    queryFn: () => listAgentOrchestrations(nodeId),
    enabled: Boolean(nodeId) && toValue(enabled),
    ...agentSnapshotQueryOptions,
  });
}

export function useAgentRunsQuery(enabled: MaybeRefOrGetter<boolean> = true) {
  return useQuery({
    queryKey: controlPlaneQueryKeys.agentRuns,
    queryFn: ({ signal }) => sharedControlPlaneClient.agents.listRuns(undefined, signal),
    enabled: computed(() => toValue(enabled)),
    ...agentSnapshotQueryOptions,
  });
}

export function createAgentDefinition(nodeId: string, input: AgentDefinitionCreateInput) {
  return sharedControlPlaneClient.agents.create(nodeId, input);
}

export function updateAgentDefinition(agentId: string, nodeId: string, input: AgentDefinitionUpdateInput) {
  return sharedControlPlaneClient.agents.update(agentId, nodeId, input);
}

export function deleteAgentDefinition(agentId: string, nodeId: string, options: { referencingOrchestrations?: "keep" | "delete" } = {}) {
  return sharedControlPlaneClient.agents.remove(agentId, nodeId, options);
}

export function createAgentOrchestration(nodeId: string, input: AgentOrchestrationCreateInput) {
  return sharedControlPlaneClient.agents.createOrchestration(nodeId, input);
}

export function updateAgentOrchestration(orchestrationId: string, nodeId: string, input: AgentOrchestrationUpdateInput) {
  return sharedControlPlaneClient.agents.updateOrchestration(orchestrationId, nodeId, input);
}

export function deleteAgentOrchestration(orchestrationId: string, nodeId: string) {
  return sharedControlPlaneClient.agents.removeOrchestration(orchestrationId, nodeId);
}

export function cancelAgentRun(runId: string, nodeId: string, expectedRevision?: number) {
  return sharedControlPlaneClient.agents.cancelRun(runId, nodeId, expectedRevision === undefined ? {} : { expectedRevision });
}

export function createManualAgentRun(nodeId: string, input: AgentRunManualCreateInput) {
  return sharedControlPlaneClient.agents.createManualRun(nodeId, input);
}
