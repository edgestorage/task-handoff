import { z } from "zod";
import {
  ControlPlaneAuthenticatedUserSchema,
  ControlPlaneCliAuthorizationApprovalResponseSchema,
  ControlPlaneCliAuthorizationDenialResponseSchema,
  ControlPlaneCliAuthorizationRequestDetailResponseSchema,
  ControlPlaneCliAuthorizationRequestSchema,
  ControlPlaneCliAuthorizeResponseSchema,
  ControlPlaneCliSessionRenewalResponseSchema,
  ControlPlaneCliSessionRevocationResponseSchema,
  ControlPlaneCliSessionsResponseSchema,
  ControlPlaneCliTokenRequestSchema,
  ControlPlaneCliTokenResponseSchema,
  ControlPlaneCurrentAuthorizationSchema,
  ControlPlaneMobileLoginInputSchema,
  ControlPlaneMobileLoginResponseSchema,
  ControlPlaneMobileSessionRenewalResponseSchema,
  ControlPlaneMobileSessionRevocationResponseSchema,
  ControlPlaneMobileSessionsResponseSchema,
  ControlPlanePublicIdentityDocumentSchema,
  type ControlPlaneCliAuthorizationRequest,
  type ControlPlaneCliTokenRequest,
  type ControlPlaneMobileLoginInput,
} from "@task-handoff/protocol/control-plane-access";
import type { ControlPlaneClientTransport } from "./transport.ts";

const DataSchema = <T extends z.ZodType>(schema: T) => z.object({ data: schema }).strict();

export const ControlPlaneAuthSessionSchema = z.object({
  mode: z.enum(["disabled", "password"]),
  enabled: z.boolean(),
  requiresBootstrap: z.boolean(),
  authenticated: z.boolean(),
  requiresPasswordChange: z.boolean().optional(),
  user: ControlPlaneAuthenticatedUserSchema.optional(),
  authorization: ControlPlaneCurrentAuthorizationSchema.optional(),
}).strict();

export function createControlPlaneAuthApi(transport: ControlPlaneClientTransport) {
  const requestData = async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit) => (
    (await transport.request(path, DataSchema(schema), init)).data
  );
  const post = (body?: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const patch = (body: unknown): RequestInit => ({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    identity() {
      return transport.request("/api/control-plane/identity", ControlPlanePublicIdentityDocumentSchema);
    },
    session(signal?: AbortSignal) {
      return requestData("/api/auth/session", ControlPlaneAuthSessionSchema, { signal });
    },
    bootstrapAdmin(input: { username: string; password: string }) {
      return requestData("/api/auth/bootstrap-admin", ControlPlaneAuthenticatedUserSchema, post(input));
    },
    login(input: { username: string; password: string }) {
      return requestData("/api/auth/login", z.object({ user: ControlPlaneAuthenticatedUserSchema }).strict(), post(input));
    },
    changePassword(input: { currentPassword: string; newPassword: string }) {
      return requestData(
        "/api/auth/password",
        z.object({ user: ControlPlaneAuthenticatedUserSchema }).strict(),
        patch(input),
      );
    },
    logout() {
      return requestData("/api/auth/logout", z.object({ ok: z.boolean() }).strict(), post());
    },
    logoutMobile() {
      return requestData("/api/auth/mobile/logout", z.object({ ok: z.boolean() }).strict(), post());
    },
    renewMobileSession(signal?: AbortSignal) {
      return transport.request(
        "/api/auth/mobile/renew",
        ControlPlaneMobileSessionRenewalResponseSchema,
        { ...post(), signal },
      ).then((response) => response.data);
    },
    async loginMobile(input: ControlPlaneMobileLoginInput) {
      return (await transport.request(
        "/api/auth/mobile/login",
        ControlPlaneMobileLoginResponseSchema,
        post(ControlPlaneMobileLoginInputSchema.parse(input)),
      )).data;
    },
    cliAuthorize(input: ControlPlaneCliAuthorizationRequest) {
      return transport.request(
        "/api/auth/cli/authorize",
        ControlPlaneCliAuthorizeResponseSchema,
        post(ControlPlaneCliAuthorizationRequestSchema.parse(input)),
      ).then((response) => response.data);
    },
    cliToken(input: ControlPlaneCliTokenRequest) {
      return transport.request(
        "/api/auth/cli/token",
        ControlPlaneCliTokenResponseSchema,
        post(ControlPlaneCliTokenRequestSchema.parse(input)),
      ).then((response) => response.data);
    },
    cliAuthorizationRequest(requestId: string, signal?: AbortSignal) {
      return transport.request(
        `/api/auth/cli/requests/${encodeURIComponent(requestId)}`,
        ControlPlaneCliAuthorizationRequestDetailResponseSchema,
        { signal },
      ).then((response) => response.data);
    },
    cliAuthorizationRequestByUserCode(userCode: string, signal?: AbortSignal) {
      return transport.request(
        `/api/auth/cli/requests?userCode=${encodeURIComponent(userCode)}`,
        ControlPlaneCliAuthorizationRequestDetailResponseSchema,
        { signal },
      ).then((response) => response.data);
    },
    approveCliAuthorization(requestId: string) {
      return transport.request(
        `/api/auth/cli/requests/${encodeURIComponent(requestId)}/approve`,
        ControlPlaneCliAuthorizationApprovalResponseSchema,
        post(),
      ).then((response) => response.data);
    },
    denyCliAuthorization(requestId: string) {
      return transport.request(
        `/api/auth/cli/requests/${encodeURIComponent(requestId)}/deny`,
        ControlPlaneCliAuthorizationDenialResponseSchema,
        post(),
      ).then((response) => response.data);
    },
    logoutCli() {
      return requestData("/api/auth/cli/logout", z.object({ ok: z.boolean() }).strict(), post());
    },
    renewCliSession(signal?: AbortSignal) {
      return transport.request(
        "/api/auth/cli/renew",
        ControlPlaneCliSessionRenewalResponseSchema,
        { ...post(), signal },
      ).then((response) => response.data);
    },
    cliSessions(signal?: AbortSignal) {
      return transport.request("/api/auth/cli/sessions", ControlPlaneCliSessionsResponseSchema, { signal }).then((response) => response.data);
    },
    revokeCliSession(sessionId: string) {
      return transport.request(
        `/api/auth/cli/sessions/${encodeURIComponent(sessionId)}`,
        ControlPlaneCliSessionRevocationResponseSchema,
        { method: "DELETE" },
      ).then((response) => response.data);
    },
    mobileSessions(signal?: AbortSignal) {
      return transport.request("/api/auth/mobile/sessions", ControlPlaneMobileSessionsResponseSchema, { signal }).then((response) => response.data);
    },
    revokeMobileSession(sessionId: string) {
      return transport.request(
        `/api/auth/mobile/sessions/${encodeURIComponent(sessionId)}`,
        ControlPlaneMobileSessionRevocationResponseSchema,
        { method: "DELETE" },
      ).then((response) => response.data);
    },
  };
}

export type ControlPlaneAuthSession = z.infer<typeof ControlPlaneAuthSessionSchema>;
