import { z } from "zod";
import {
  ControlPlaneCurrentAuthorizationSchema,
  ControlPlaneExternalIdentityApprovalSummarySchema,
  ControlPlaneIdentityProviderSummarySchema,
  ControlPlaneLoginIdentitySummarySchema,
  ControlPlanePermissionDescriptorSchema,
  ControlPlaneRoleSummarySchema,
  ControlPlaneUserDetailSchema,
  ControlPlaneUserSessionSummarySchema,
  ControlPlaneUserSummarySchema,
  ControlPlaneUpdateUserInputSchema,
  type ControlPlaneUpdateUserInput,
} from "@task-handoff/protocol/control-plane-access";
import type { ControlPlaneClientTransport } from "./transport.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).strict();
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export function createControlPlaneUsersApi(transport: ControlPlaneClientTransport) {
  return {
    currentAuthorization(signal?: AbortSignal) {
      return transport.request("/api/access/me", DataSchema(ControlPlaneCurrentAuthorizationSchema), { signal }).then((response) => response.data);
    },
    list(query: { search?: string; includeArchived?: boolean } = {}, signal?: AbortSignal) {
      const search = new URLSearchParams();
      if (query.search) search.set("search", query.search);
      if (query.includeArchived) search.set("includeArchived", "true");
      return transport.request(`/api/users${search.size ? `?${search}` : ""}`, DataSchema(z.array(ControlPlaneUserSummarySchema)), { signal }).then((response) => response.data);
    },
    detail(userId: string, signal?: AbortSignal) {
      return transport.request(`/api/users/${encodeURIComponent(userId)}`, DataSchema(ControlPlaneUserDetailSchema), { signal }).then((response) => response.data);
    },
    create(input: unknown) {
      return transport.request("/api/users", DataSchema(ControlPlaneUserDetailSchema), json("POST", input)).then((response) => response.data);
    },
    update(userId: string, input: ControlPlaneUpdateUserInput) {
      return transport.request(`/api/users/${encodeURIComponent(userId)}`, DataSchema(ControlPlaneUserDetailSchema), json("PATCH", ControlPlaneUpdateUserInputSchema.parse(input))).then((response) => response.data);
    },
    setAccess(userId: string, input: unknown) {
      return transport.request(`/api/users/${encodeURIComponent(userId)}/access`, DataSchema(ControlPlaneUserDetailSchema), json("PUT", input)).then((response) => response.data);
    },
    resetPassword(userId: string, input: { password: string; requirePasswordChange?: boolean }) {
      return transport.request(`/api/users/${encodeURIComponent(userId)}/password-reset`, DataSchema(ControlPlaneLoginIdentitySummarySchema), json("POST", input)).then((response) => response.data);
    },
    unbindExternalIdentity(userId: string, identityId: string) {
      return transport.request(`/api/users/${encodeURIComponent(userId)}/identities/${encodeURIComponent(identityId)}`, DataSchema(z.object({ unbound: z.boolean() }).strict()), { method: "DELETE" }).then((response) => response.data);
    },
    sessions(userId: string, signal?: AbortSignal) {
      return transport.request(`/api/users/${encodeURIComponent(userId)}/sessions`, DataSchema(z.array(ControlPlaneUserSessionSummarySchema)), { signal }).then((response) => response.data);
    },
    revokeSession(userId: string, sessionId: string) {
      return transport.request(`/api/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`, DataSchema(z.object({ revoked: z.boolean() }).strict()), { method: "DELETE" }).then((response) => response.data);
    },
    revokeAllSessions(userId: string) {
      return transport.request(`/api/users/${encodeURIComponent(userId)}/sessions`, DataSchema(z.object({ revokedSessions: z.number().int().nonnegative() }).strict()), { method: "DELETE" }).then((response) => response.data);
    },
    roles(signal?: AbortSignal) {
      return transport.request("/api/roles", DataSchema(z.array(ControlPlaneRoleSummarySchema)), { signal }).then((response) => response.data);
    },
    permissions(signal?: AbortSignal) {
      return transport.request("/api/permissions", DataSchema(z.array(ControlPlanePermissionDescriptorSchema)), { signal }).then((response) => response.data);
    },
    createRole(input: unknown) {
      return transport.request("/api/roles", DataSchema(ControlPlaneRoleSummarySchema), json("POST", input)).then((response) => response.data);
    },
    updateRole(roleId: string, input: unknown) {
      return transport.request(`/api/roles/${encodeURIComponent(roleId)}`, DataSchema(ControlPlaneRoleSummarySchema), json("PATCH", input)).then((response) => response.data);
    },
    archiveRole(roleId: string) {
      return transport.request(`/api/roles/${encodeURIComponent(roleId)}`, DataSchema(ControlPlaneRoleSummarySchema), { method: "DELETE" }).then((response) => response.data);
    },
    providers(signal?: AbortSignal) {
      return transport.request("/api/identity-providers", DataSchema(z.array(ControlPlaneIdentityProviderSummarySchema)), { signal }).then((response) => response.data);
    },
    createProvider(input: unknown) {
      return transport.request("/api/identity-providers", DataSchema(ControlPlaneIdentityProviderSummarySchema), json("POST", input)).then((response) => response.data);
    },
    updateProvider(providerId: string, input: unknown) {
      return transport.request(`/api/identity-providers/${encodeURIComponent(providerId)}`, DataSchema(ControlPlaneIdentityProviderSummarySchema), json("PATCH", input)).then((response) => response.data);
    },
    removeProvider(providerId: string) {
      return transport.request(`/api/identity-providers/${encodeURIComponent(providerId)}`, DataSchema(z.object({ deleted: z.boolean() }).strict()), { method: "DELETE" }).then((response) => response.data);
    },
    approvals(signal?: AbortSignal) {
      return transport.request("/api/external-identity-approvals", DataSchema(z.array(ControlPlaneExternalIdentityApprovalSummarySchema)), { signal }).then((response) => response.data);
    },
    approveIdentity(approvalId: string, input: unknown) {
      return transport.request(`/api/external-identity-approvals/${encodeURIComponent(approvalId)}/approve`, DataSchema(ControlPlaneUserDetailSchema), json("POST", input)).then((response) => response.data);
    },
    rejectIdentity(approvalId: string) {
      return transport.request(`/api/external-identity-approvals/${encodeURIComponent(approvalId)}/reject`, DataSchema(z.object({ rejected: z.boolean() }).strict()), json("POST", {})).then((response) => response.data);
    },
  };
}
