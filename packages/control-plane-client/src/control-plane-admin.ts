import { z } from "zod";
import {
  ControlPlaneSettingsSchema,
  UpdateControlPlaneSettingsSchema,
} from "@task-handoff/protocol/control-plane";
import {
  CreateProxyInviteInputSchema,
  CreateProxyInviteResultSchema,
  PublicPendingProxyClaimSchema,
  PublicProxyBindingSchema,
  PublicProxyInviteSchema,
} from "@task-handoff/protocol/control-plane-proxy";
import type { ControlPlaneClientTransport } from "./transport.ts";
import { jsonRequest } from "./json-request.ts";
import { binaryUnsupported } from "./errors.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).passthrough();

const ControlPlaneStatusSchema = z.object({
  protocolVersion: z.string(),
  build: z.record(z.string(), z.unknown()).optional(),
  storage: z.record(z.string(), z.string()),
}).passthrough();

const CloudIdentitySchema = z.object({
  controlPlaneId: z.string(),
  algorithm: z.literal("Ed25519"),
  publicKey: z.string(),
  fingerprint: z.string(),
}).strict();

const CloudConnectivitySchema = z.object({
  version: z.literal(1),
  serviceOrigin: z.string(),
  status: z.enum(["unbound", "pending-claim", "active", "pending-revocation", "clone-conflict"]),
  // Two independent scopes: device access (account devices reach this Control
  // Plane) and node relay (this Control Plane claims account nodes). Only both
  // being off stops the cloud connection.
  scopes: z.object({ deviceAccess: z.boolean(), nodeRelay: z.boolean() }),
  remoteAccessEnabled: z.boolean(),
  accountId: z.string().optional(),
  bindingId: z.string().optional(),
  bindingRevision: z.number().int().optional(),
  updatedAt: z.string(),
  identity: CloudIdentitySchema,
  cloudControlPlaneId: z.string().optional(),
  hasBackgroundCredential: z.boolean(),
  remoteResult: z.enum(["confirmed", "unknown"]).optional(),
}).strict();

/** Account node directory projection: only allowlisted identity fields, never endpoints or business data. */
const CloudAccountNodeSchema = z.object({
  nodeHandle: z.string(),
  displayName: z.string().optional(),
  publicKeyFingerprint: z.string(),
  status: z.enum(["active", "suspended", "revoked"]),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();

const CloudNodeRelayStateSchema = z.object({
  channels: z.array(z.object({ nodeHandle: z.string(), nodeId: z.string(), allocationId: z.string(), connectedAt: z.string(), connected: z.boolean() }).strict()),
  claims: z.array(z.object({ nodeHandle: z.string(), requestedAt: z.string() }).strict()),
  errors: z.array(z.object({ nodeHandle: z.string(), code: z.string(), message: z.string(), at: z.string() }).strict()),
  onboarding: z.array(z.object({ nodeHandle: z.string(), tokenId: z.string().optional(), at: z.string() }).strict()),
}).strict();

const CloudAccountNodesSchema = z.object({
  signedIn: z.boolean(),
  nodeRelay: CloudNodeRelayStateSchema,
  items: z.array(CloudAccountNodeSchema),
}).strict();

const CloudNodeClaimSchema = z.object({
  claimed: z.boolean(),
  nodeHandle: z.string(),
  controlPlaneId: z.string(),
  status: z.string(),
  revision: z.number().int().nonnegative(),
}).passthrough();

const CloudNodeClaimRevocationSchema = z.object({
  nodeHandle: z.string(),
  status: z.string(),
  revision: z.number().int().nonnegative().optional(),
}).passthrough();

/**
 * Both node-side commands rendered from one token, shown exactly once: the CLI
 * bind for a machine that already runs an agent, and the installer command for
 * a machine with nothing deployed.
 */
const CloudRelayNodeBindingSchema = z.object({
  bound: z.boolean(),
  nodeHandle: z.string().trim().min(1).max(160).optional(),
  tokenId: z.string().trim().min(1).max(160).optional(),
  expiresAt: z.string().datetime().optional(),
}).passthrough();

const CloudNodeBindingTokenSchema = z.object({
  tokenId: z.string(),
  expiresAt: z.string(),
  command: z.string(),
  installCommand: z.string(),
}).strict();

const CloudNodeBindingTokenCancelSchema = z.object({ tokenId: z.string(), cancelled: z.literal(true) }).strict();

const CloudAccountRequestSchema = z.object({
  requestId: z.string(),
  scope: z.string(),
  expiresAt: z.string(),
  authorizationUrl: z.string(),
}).strict();

const CloudAccountSessionSchema = z.object({
  signedIn: z.boolean(),
  accountId: z.string().optional(),
  email: z.string().optional(),
  sessionExpiresAt: z.string().optional(),
  pendingRequest: z.object({ requestId: z.string(), authorizationUrl: z.string().optional(), scope: z.string().optional(), expiresAt: z.string().optional() }).strict().optional(),
}).strict();

const CloudBindingChallengeSchema = z.object({
  challengeCode: z.string(),
  authorizationUrl: z.string(),
  payload: z.object({
    controlPlaneId: z.string(),
    publicKeyFingerprint: z.string(),
    expiresAt: z.string(),
  }).strict(),
  signature: z.string(),
}).strict();

const ProxyDiagnosticSchema = z.object({
  bindingId: z.string(),
  activeHttp: z.number().int().nonnegative(),
  activeStreams: z.number().int().nonnegative(),
  activeWebSockets: z.number().int().nonnegative(),
}).strict();

const ClaimMutationResultSchema = z.record(z.string(), z.unknown());

export function createControlPlaneAdminApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  const invitePath = (inviteId: string) => `/api/control-plane-proxy/invites/${encodeURIComponent(inviteId)}`;
  const bindingPath = (bindingId: string) => `/api/control-plane-proxy/bindings/${encodeURIComponent(bindingId)}`;
  const pendingClaimPath = (claimId: string) => `/api/control-plane-proxy/pending-claims/${encodeURIComponent(claimId)}`;
  return {
    status(signal?: AbortSignal) {
      return requestData("/api/control-plane/status", ControlPlaneStatusSchema, { signal });
    },
    getSettings(signal?: AbortSignal) {
      return requestData("/api/control-plane/settings", ControlPlaneSettingsSchema, { signal });
    },
    updateSettings(input: unknown) {
      const parsed = UpdateControlPlaneSettingsSchema.parse(input);
      return requestData("/api/control-plane/settings", ControlPlaneSettingsSchema, jsonRequest("PATCH", parsed));
    },
    async exportDiagnosticLogs() {
      if (!transport.requestBinary) throw binaryUnsupported();
      return transport.requestBinary("/api/control-plane/diagnostic-logs/export");
    },
    cloudConnectivity(signal?: AbortSignal) {
      return requestData("/api/cloud-connectivity", CloudConnectivitySchema, { signal });
    },
    createCloudChallenge() {
      return requestData("/api/cloud-connectivity/challenges", CloudBindingChallengeSchema, jsonRequest("POST", {}));
    },
    cloudAccount(signal?: AbortSignal) {
      return requestData("/api/cloud-account", CloudAccountSessionSchema, { signal });
    },
    createCloudSignInRequest() {
      return requestData("/api/cloud-account/sign-in-requests", CloudAccountRequestSchema, jsonRequest("POST", {}));
    },
    signOutCloudAccount() {
      return requestData("/api/cloud-account/sign-out", CloudAccountSessionSchema, jsonRequest("POST", {}));
    },
    createCloudBindingRequest() {
      return requestData("/api/cloud-connectivity/binding-requests", CloudAccountRequestSchema, jsonRequest("POST", {}));
    },
    setCloudRemoteAccess(enabled: boolean) {
      return requestData("/api/cloud-connectivity/remote-access", CloudConnectivitySchema, jsonRequest("POST", { enabled }));
    },
    setCloudScopes(scopes: { deviceAccess: boolean; nodeRelay: boolean }) {
      return requestData("/api/cloud-connectivity/remote-access", CloudConnectivitySchema, jsonRequest("POST", { scopes }));
    },
    disconnectCloud() {
      return requestData("/api/cloud-connectivity/disconnect", CloudConnectivitySchema, jsonRequest("POST", {}));
    },
    cloudAccountNodes(signal?: AbortSignal) {
      return requestData("/api/cloud-connectivity/account-nodes", CloudAccountNodesSchema, { signal });
    },
    claimCloudAccountNode(nodeHandle: string) {
      return requestData(`/api/cloud-connectivity/account-nodes/${encodeURIComponent(nodeHandle)}/claim`, CloudNodeClaimSchema, jsonRequest("POST", {}));
    },
    releaseCloudAccountNodeClaim(nodeHandle: string) {
      return requestData(`/api/cloud-connectivity/account-nodes/${encodeURIComponent(nodeHandle)}/claim`, CloudNodeClaimRevocationSchema, jsonRequest("DELETE"));
    },
    createCloudNodeBindingToken(input: { displayName?: string } = {}) {
      return requestData("/api/cloud-connectivity/node-binding-tokens", CloudNodeBindingTokenSchema, jsonRequest("POST", input));
    },
    cancelCloudNodeBindingToken(tokenId: string) {
      return requestData(`/api/cloud-connectivity/node-binding-tokens/${encodeURIComponent(tokenId)}`, CloudNodeBindingTokenCancelSchema, jsonRequest("DELETE"));
    },
    cloudNodeRelayState(signal?: AbortSignal) {
      return requestData("/api/cloud-connectivity/node-relay", CloudNodeRelayStateSchema, { signal });
    },
    bindCloudRelayNode(nodeId: string) {
      return requestData(`/api/nodes/${encodeURIComponent(nodeId)}/cloud-relay-binding`, CloudRelayNodeBindingSchema, jsonRequest("POST", {}));
    },
    proxyInvites(signal?: AbortSignal) {
      return requestData("/api/control-plane-proxy/invites", z.array(PublicProxyInviteSchema), { signal });
    },
    createProxyInvite(input: unknown) {
      const parsed = CreateProxyInviteInputSchema.parse(input);
      return requestData("/api/control-plane-proxy/invites", CreateProxyInviteResultSchema, jsonRequest("POST", parsed));
    },
    revokeProxyInvite(inviteId: string) {
      return requestData(invitePath(inviteId), PublicProxyInviteSchema, jsonRequest("DELETE"));
    },
    proxyBindings(signal?: AbortSignal) {
      return requestData("/api/control-plane-proxy/bindings", z.array(PublicProxyBindingSchema), { signal });
    },
    revokeProxyBinding(bindingId: string) {
      return requestData(bindingPath(bindingId), PublicProxyBindingSchema, jsonRequest("DELETE"));
    },
    proxyDiagnostics(signal?: AbortSignal) {
      return requestData("/api/control-plane-proxy/diagnostics", z.array(ProxyDiagnosticSchema), { signal });
    },
    pendingProxyClaims(signal?: AbortSignal) {
      return requestData("/api/control-plane-proxy/pending-claims", z.array(PublicPendingProxyClaimSchema), { signal });
    },
    resumeProxyClaim(claimId: string) {
      return requestData(`${pendingClaimPath(claimId)}/resume`, ClaimMutationResultSchema, jsonRequest("POST", {}));
    },
    cancelProxyClaim(claimId: string, options: { force?: boolean } = {}) {
      const query = options.force ? "?force=true" : "";
      return requestData(`${pendingClaimPath(claimId)}${query}`, ClaimMutationResultSchema, jsonRequest("DELETE"));
    },
  };
}

export type ControlPlaneAdminApi = ReturnType<typeof createControlPlaneAdminApi>;
