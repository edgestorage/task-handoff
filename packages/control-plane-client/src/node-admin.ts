import { z } from "zod";
import {
  ApplyUpdateRequestSchema,
  LocalDockerImageSchema,
  NodeAgentControlPlaneConnectionCreateResultSchema,
  NodeAgentControlPlaneConnectionSchema,
  NodeAgentControlPlanePairingSchema,
  NodeAgentDeleteResponseSchema,
  NodeAgentExternalListenerSchema,
  NodeAgentModelRelaySchema,
  NodeAgentPairingInviteResponseSchema,
  NodeFolderPlaceSchema,
  NodeFolderTreeEntrySchema,
  NodeImageAvailabilitySchema,
  NodeJoinInviteStatusSchema,
  NodeLocalFolderSchema,
  NodeRuntimeSchema,
  NodeSchema,
  UpdateCheckRequestSchema,
  UpdateCheckResultSchema,
  UpdateJobSchema,
  UpdateNodeAgentExternalListenerSchema,
  UpdateNodeAgentModelRelaySchema,
} from "@task-handoff/protocol/control-plane";
import {
  ControlPlaneNodeFleetErrorSchema,
  ControlPlaneNodeFleetStateSchema,
} from "@task-handoff/protocol/control-plane-directory";
import type { ControlPlaneClientTransport } from "./transport.ts";
import { jsonRequest } from "./json-request.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();

/**
 * `checkNode` returns the probe outcome, not the node entity; only `agent` is
 * present when the probe succeeded.
 */
const NodeCheckResultSchema = z.object({
  id: z.string().trim().min(1),
  status: z.enum(["online", "offline"]),
  checkedAt: z.string(),
  agent: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
}).passthrough();

export const DeleteNodeResultSchema = z.object({
  deleted: z.boolean(),
  revoke: z.object({
    mode: z.enum(["not-proxied", "revoked", "forced"]),
    orphanRisk: z.boolean(),
  }).strict(),
}).strict();

const NodeRuntimesPayloadSchema = z.object({
  data: z.array(NodeRuntimeSchema),
  meta: z.object({
    nodeErrors: z.array(ControlPlaneNodeFleetErrorSchema).default([]),
    nodeStates: z.array(ControlPlaneNodeFleetStateSchema).default([]),
  }).passthrough().optional(),
}).passthrough();

const NodeJoinInviteSchema = z.object({
  id: z.string().trim().min(1),
  joinToken: z.string().trim().min(1),
  expiresAt: z.string(),
}).strict();

/**
 * Node reads must not surface `auth.secret`. The control-plane already strips
 * it for most routes, but `check` and a few diagnostics return the raw entity,
 * so the client normalizes every node projection here.
 */
const PublicNodeSchema = NodeSchema.transform((node) => {
  const { secret: _secret, ...auth } = node.auth;
  return { ...node, auth };
});

export function createControlPlaneNodeAdminApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  const nodePath = (nodeId: string) => `/api/nodes/${encodeURIComponent(nodeId)}`;
  const runtimePath = (nodeId: string, runtimeId?: string) => (
    `${nodePath(nodeId)}/runtimes${runtimeId === undefined ? "" : `/${encodeURIComponent(runtimeId)}`}`
  );
  const folderPath = (nodeId: string, folderId?: string) => (
    `${nodePath(nodeId)}/local-folders${folderId === undefined ? "" : `/${encodeURIComponent(folderId)}`}`
  );
  return {
    createNode(input: unknown) {
      return requestData("/api/nodes", PublicNodeSchema, jsonRequest("POST", input));
    },
    updateNode(nodeId: string, input: unknown) {
      return requestData(nodePath(nodeId), PublicNodeSchema, jsonRequest("PATCH", input));
    },
    removeNode(nodeId: string, options: { force?: boolean } = {}) {
      const query = options.force ? "?force=true" : "";
      return requestData(`${nodePath(nodeId)}${query}`, DeleteNodeResultSchema, jsonRequest("DELETE"));
    },
    checkNode(nodeId: string) {
      return requestData(`${nodePath(nodeId)}/check`, NodeCheckResultSchema, jsonRequest("POST", {}));
    },
    syncLocalNode() {
      return requestData("/api/nodes/local/sync", PublicNodeSchema, jsonRequest("POST", {}));
    },
    listFolders(nodeId: string, signal?: AbortSignal) {
      return requestData(folderPath(nodeId), z.array(NodeLocalFolderSchema), { signal });
    },
    listFolderPlaces(nodeId: string, signal?: AbortSignal) {
      return requestData(`${nodePath(nodeId)}/folders/places`, z.array(NodeFolderPlaceSchema), { signal });
    },
    listFolderTree(nodeId: string, input: { path?: string; depth?: number } = {}, signal?: AbortSignal) {
      const query = new URLSearchParams();
      if (input.path) query.set("path", input.path);
      if (input.depth !== undefined) query.set("depth", String(input.depth));
      return requestData(`${nodePath(nodeId)}/folders/tree${query.size ? `?${query}` : ""}`, z.array(NodeFolderTreeEntrySchema), { signal });
    },
    createFolder(nodeId: string, input: unknown) {
      return requestData(folderPath(nodeId), NodeLocalFolderSchema, jsonRequest("POST", input));
    },
    updateFolder(nodeId: string, folderId: string, input: unknown) {
      return requestData(folderPath(nodeId, folderId), NodeLocalFolderSchema, jsonRequest("PATCH", input));
    },
    removeFolder(nodeId: string, folderId: string) {
      return requestData(folderPath(nodeId, folderId), NodeAgentDeleteResponseSchema, jsonRequest("DELETE"));
    },
    listAllRuntimes(options: { progressive?: boolean; signal?: AbortSignal } = {}) {
      const query = options.progressive ? "?progressive=true" : "";
      return transport.request(`/api/node-runtimes${query}`, NodeRuntimesPayloadSchema, { signal: options.signal });
    },
    listRuntimes(nodeId: string, signal?: AbortSignal) {
      return requestData(runtimePath(nodeId), z.array(NodeRuntimeSchema), { signal });
    },
    createRuntime(nodeId: string, input: unknown) {
      return requestData(runtimePath(nodeId), NodeRuntimeSchema, jsonRequest("POST", input));
    },
    updateRuntime(nodeId: string, runtimeId: string, input: unknown) {
      return requestData(runtimePath(nodeId, runtimeId), NodeRuntimeSchema, jsonRequest("PATCH", input));
    },
    removeRuntime(nodeId: string, runtimeId: string) {
      return requestData(runtimePath(nodeId, runtimeId), NodeAgentDeleteResponseSchema, jsonRequest("DELETE"));
    },
    checkRuntime(nodeId: string, runtimeId: string) {
      return requestData(`${runtimePath(nodeId, runtimeId)}/check`, NodeRuntimeSchema, jsonRequest("POST", {}));
    },
    listDockerImages(nodeId: string, signal?: AbortSignal) {
      return requestData(`${nodePath(nodeId)}/docker/images`, z.array(LocalDockerImageSchema), { signal });
    },
    imageOptions(nodeId: string, signal?: AbortSignal) {
      return requestData(`${nodePath(nodeId)}/image-options`, z.array(NodeImageAvailabilitySchema), { signal });
    },
    getExternalListener(nodeId: string, signal?: AbortSignal) {
      return requestData(`${nodePath(nodeId)}/settings/external-listener`, NodeAgentExternalListenerSchema, { signal });
    },
    updateExternalListener(nodeId: string, input: unknown) {
      const parsed = UpdateNodeAgentExternalListenerSchema.parse(input);
      return requestData(`${nodePath(nodeId)}/settings/external-listener`, NodeAgentExternalListenerSchema, jsonRequest("PATCH", parsed));
    },
    getModelRelay(nodeId: string, signal?: AbortSignal) {
      return requestData(`${nodePath(nodeId)}/settings/model-relay`, NodeAgentModelRelaySchema, { signal });
    },
    updateModelRelay(nodeId: string, input: unknown) {
      const parsed = UpdateNodeAgentModelRelaySchema.parse(input);
      return requestData(`${nodePath(nodeId)}/settings/model-relay`, NodeAgentModelRelaySchema, jsonRequest("PATCH", parsed));
    },
    updateJobs(nodeId: string, signal?: AbortSignal) {
      return requestData(`${nodePath(nodeId)}/updates/jobs`, z.array(UpdateJobSchema), { signal });
    },
    checkUpdate(nodeId: string, input: unknown = {}) {
      const parsed = UpdateCheckRequestSchema.parse(input);
      return requestData(`${nodePath(nodeId)}/updates/check`, UpdateCheckResultSchema, jsonRequest("POST", parsed));
    },
    applyUpdate(nodeId: string, input: unknown) {
      const parsed = ApplyUpdateRequestSchema.parse(input);
      return requestData(`${nodePath(nodeId)}/updates/apply`, UpdateJobSchema, jsonRequest("POST", parsed));
    },
    createPairingInvite(nodeId: string, input: unknown = {}) {
      return requestData(`${nodePath(nodeId)}/pairing/invites`, NodeAgentPairingInviteResponseSchema, jsonRequest("POST", input));
    },
    listControlPlanePairings(nodeId: string, signal?: AbortSignal) {
      return requestData(`${nodePath(nodeId)}/control-plane-pairings`, z.array(NodeAgentControlPlanePairingSchema), { signal });
    },
    removeControlPlanePairing(nodeId: string, keyId: string) {
      return requestData(`${nodePath(nodeId)}/control-plane-pairings/${encodeURIComponent(keyId)}`, NodeAgentDeleteResponseSchema, jsonRequest("DELETE"));
    },
    listControlPlaneConnections(nodeId: string, signal?: AbortSignal) {
      return requestData(`${nodePath(nodeId)}/control-plane-connections`, z.array(NodeAgentControlPlaneConnectionSchema), { signal });
    },
    createControlPlaneConnection(nodeId: string, input: unknown) {
      return requestData(`${nodePath(nodeId)}/control-plane-connections`, NodeAgentControlPlaneConnectionCreateResultSchema, jsonRequest("POST", input));
    },
    removeControlPlaneConnection(nodeId: string, connectionId: string) {
      return requestData(`${nodePath(nodeId)}/control-plane-connections/${encodeURIComponent(connectionId)}`, NodeAgentDeleteResponseSchema, jsonRequest("DELETE"));
    },
    createJoinInvite(input: unknown = {}) {
      return requestData("/api/node-join/invites", NodeJoinInviteSchema, jsonRequest("POST", input));
    },
    joinInviteStatus(inviteId: string, signal?: AbortSignal) {
      return requestData(`/api/node-join/invites/${encodeURIComponent(inviteId)}`, NodeJoinInviteStatusSchema, { signal });
    },
    completeJoin(input: unknown) {
      return requestData("/api/node-join/complete", PublicNodeSchema, jsonRequest("POST", input));
    },
  };
}

export type ControlPlaneNodeAdminApi = ReturnType<typeof createControlPlaneNodeAdminApi>;
