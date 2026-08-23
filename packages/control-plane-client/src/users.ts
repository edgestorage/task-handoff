import { z } from "zod";
import {
  ControlPlaneCurrentAuthorizationSchema,
  ControlPlaneIdentityProviderSummarySchema,
  ControlPlaneLoginIdentitySummarySchema,
  ControlPlanePermissionDescriptorSchema,
  ControlPlaneRoleSummarySchema,
  ControlPlaneUserDetailSchema,
  ControlPlaneUserSessionSummarySchema,
  ControlPlaneUserSummarySchema,
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
    update(userId: string, input: unknown) {
      return transport.request(`/api/users/${encodeURIComponent(userId)}`, DataSchema(ControlPlaneUserDetailSchema), json("PATCH", input)).then((response) => response.data);
    },
    setAccess(userId: string, input: unknown) {
      return transport.request(`/api/users/${encodeURIComponent(userId)}/access`, DataSchema(ControlPlaneUserDetailSchema), json("PUT", input)).then((response) => response.data);
    },
    resetPassword(userId: string, input: { password: string; requirePasswordChange?: boolean }) {
      return transport.request(`/api/users/${encodeURIComponent(userId)}/password-reset`, DataSchema(ControlPlaneLoginIdentitySummarySchema), json("POST", input)).then((response) => response.data);
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
    providers(signal?: AbortSignal) {
      return transport.request("/api/identity-providers", DataSchema(z.array(ControlPlaneIdentityProviderSummarySchema)), { signal }).then((response) => response.data);
    },
  };
}
