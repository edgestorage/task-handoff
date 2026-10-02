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
  remoteAccessEnabled: z.boolean(),
  accountId: z.string().optional(),
  bindingId: z.string().optional(),
  bindingRevision: z.number().int().optional(),
  updatedAt: z.string(),
  identity: CloudIdentitySchema,
  hasBackgroundCredential: z.boolean(),
  remoteResult: z.enum(["confirmed", "unknown"]).optional(),
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

function binaryUnsupported(): Error {
  const error = new Error("This client transport cannot download binary responses.");
  Object.assign(error, { code: "CLIENT_BINARY_UNSUPPORTED" });
  return error;
}

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
    setCloudRemoteAccess(enabled: boolean) {
      return requestData("/api/cloud-connectivity/remote-access", CloudConnectivitySchema, jsonRequest("POST", { enabled }));
    },
    disconnectCloud() {
      return requestData("/api/cloud-connectivity/disconnect", CloudConnectivitySchema, jsonRequest("POST", {}));
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
