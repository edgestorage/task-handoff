import { z } from "zod";
import {
  ControlPlaneCliLocalSessionRequestSchema,
  ControlPlaneCliTokenResponseSchema,
  type ControlPlaneMobileDevice,
} from "@task-handoff/protocol/control-plane-access";
import { nowIso as now } from "@task-handoff/core/core/time";
import { createId } from "../../shared/persistence/store.ts";
import type { ControlPlaneStorePaths } from "../persistence/paths.ts";
import type { ControlPlaneUserDatabaseConfigInput } from "./database/index.ts";
import type { ControlPlaneUserRepository } from "./database/repository.ts";
import { assertCanAccessResolvedResource, type ControlPlaneUserAuthorizationContext } from "./authorization.ts";
import { ControlPlaneExternalAuthentication } from "./external-authentication.ts";
import { ControlPlaneCliAuthorizationService, type ControlPlaneCliAuthorizationApprover } from "./cli-authorization.ts";
import { ControlPlaneIdentityProviderService } from "./identity-provider-service.ts";
import { isLoopbackRemoteAddress } from "./local-trust.ts";
import { ControlPlaneUserAuthentication, type ControlPlaneSessionClientType } from "./user-authentication.ts";
import { ControlPlaneUserService } from "./user-service.ts";
import type { SecretEnvelopeService } from "../persistence/secret-envelope.ts";

export const CONTROL_PLANE_SESSION_COOKIE = "task_handoff_cp_session";
export const ControlPlaneAuthModeSchema = z.enum(["disabled", "password"]);
export type ControlPlaneAuthMode = z.infer<typeof ControlPlaneAuthModeSchema>;

export type ControlPlaneAuthOptions = {
  mode?: ControlPlaneAuthMode;
  database?: ControlPlaneUserDatabaseConfigInput;
  loginRateLimit?: {
    windowMs?: number;
    maxFailuresPerSource?: number;
    maxFailuresPerUsername?: number;
    maxConcurrent?: number;
  };
  onUserAuthorizationChanged?: (change: { userId: string; authorizationRevision: number; status: "active" | "disabled" | "archived" }) => void;
};

export class ControlPlaneAuth {
  readonly mode: ControlPlaneAuthMode;
  readonly users: ControlPlaneUserService;
  readonly sessions: ControlPlaneUserAuthentication;
  readonly cli: ControlPlaneCliAuthorizationService;
  readonly identityProviders: ControlPlaneIdentityProviderService;
  readonly external: ControlPlaneExternalAuthentication;
  private readonly onUserAuthorizationChanged?: ControlPlaneAuthOptions["onUserAuthorizationChanged"];

  constructor(paths: ControlPlaneStorePaths, options: ControlPlaneAuthOptions = {}, runtime: { repository?: ControlPlaneUserRepository; secrets?: SecretEnvelopeService } = {}) {
    this.mode = ControlPlaneAuthModeSchema.parse(options.mode || process.env.TASK_HANDOFF_CONTROL_PLANE_AUTH_MODE || "disabled");
    this.users = new ControlPlaneUserService(paths, { database: options.database, repository: runtime.repository });
    this.sessions = new ControlPlaneUserAuthentication(this.users, options.loginRateLimit);
    this.cli = new ControlPlaneCliAuthorizationService(this.users, this.sessions);
    this.identityProviders = new ControlPlaneIdentityProviderService(paths, this.users, { secrets: runtime.secrets });
    this.external = new ControlPlaneExternalAuthentication(this.users, this.sessions, this.identityProviders);
    this.onUserAuthorizationChanged = options.onUserAuthorizationChanged;
  }

  async init() {
    if (!this.enabled()) return;
    await this.users.init();
    this.identityProviders.init();
  }

  close() {
    return this.users.store.close();
  }

  enabled() {
    return this.mode === "password";
  }

  async state() {
    if (!this.enabled()) return { mode: this.mode, enabled: false, requiresBootstrap: false };
    return { mode: this.mode, enabled: true, requiresBootstrap: (await this.users.state()).requiresBootstrap };
  }

  async bootstrapAdmin(input: unknown) {
    this.assertEnabled();
    return this.users.bootstrapAdmin(input);
  }

  async login(input: unknown, context: { sourceId?: string } = {}) {
    this.assertEnabled();
    return this.sessions.loginLocal(input, { sourceId: context.sourceId, clientType: "web" });
  }

  async loginMobile(input: unknown, context: { sourceId?: string } = {}) {
    this.assertEnabled();
    const parsed = z.object({
      username: z.string().trim().min(1).max(80),
      password: z.string().min(1).max(4096),
      device: z.custom<ControlPlaneMobileDevice>(),
    }).strict().parse(input);
    const result = await this.sessions.loginLocal({ username: parsed.username, password: parsed.password }, { sourceId: context.sourceId, clientType: "mobile", device: parsed.device });
    return {
      sessionToken: result.sessionToken,
      session: { ...result.session, device: parsed.device, user: result.user },
      authorization: result.authorization,
    };
  }

  changePassword(token: string | undefined, input: unknown) {
    return this.sessions.changeLocalPassword(token, input);
  }

  async currentSession(token: string | undefined, clientTypes: readonly ControlPlaneSessionClientType[] = ["web"]) {
    if (!this.enabled()) {
      // disabled 模式保持"匿名即已认证"的既有语义；但携带有效 CLI 会话时返回真实身份，
      // 让 thctl 的 whoami 与请求审计归属本地操作员。
      const local = token ? await this.resolveDisabledCredential(token, clientTypes) : undefined;
      return {
        ...await this.state(),
        ...(local ? {
          authenticated: true,
          user: local.user,
          authorization: local.authorization,
          requiresPasswordChange: local.requiresPasswordChange,
        } : { authenticated: true }),
      };
    }
    return { ...await this.state(), ...await this.sessions.currentSession(token, clientTypes) };
  }

  /**
   * disabled 模式下的请求归属：有效 CLI 会话按该用户执行 RBAC 与审计，其余请求保持既有
   * 全权 system actor 语义（用户库尚未初始化时同样回退）。
   */
  async disabledModeAuthorization(token: string | undefined, clientTypes: readonly ControlPlaneSessionClientType[]) {
    if (this.enabled() || !token) return undefined;
    const current = await this.resolveDisabledCredential(token, clientTypes);
    if (!current) return undefined;
    return {
      type: "user",
      userId: current.authorization.userId,
      identityId: current.authorization.identityId,
      roleIds: current.authorization.roleIds,
      permissionIds: current.authorization.permissionIds,
      nodeScope: current.authorization.nodeScope,
      instanceScope: current.authorization.instanceScope,
      authorizationRevision: current.authorization.authorizationRevision,
      requiresPasswordChange: current.requiresPasswordChange,
    } satisfies ControlPlaneUserAuthorizationContext;
  }

  async renewSession(token: string | undefined, clientTypes: readonly ControlPlaneSessionClientType[]) {
    this.assertEnabled();
    return this.sessions.renewSession(token, clientTypes);
  }

  async renewMobileSession(token: string | undefined) {
    return this.renewSession(token, ["mobile"]);
  }

  async currentAccess(token: string | undefined, clientTypes: readonly ControlPlaneSessionClientType[]) {
    return (await this.sessions.resolve(token, clientTypes))?.authorization;
  }

  async authorizationForSessionToken(token: string | undefined, clientTypes: readonly ControlPlaneSessionClientType[]): Promise<ControlPlaneUserAuthorizationContext | undefined> {
    const current = await this.sessions.resolve(token, clientTypes);
    if (!current) return undefined;
    return {
      type: "user",
      userId: current.authorization.userId,
      identityId: current.authorization.identityId,
      roleIds: current.authorization.roleIds,
      permissionIds: current.authorization.permissionIds,
      nodeScope: current.authorization.nodeScope,
      instanceScope: current.authorization.instanceScope,
      authorizationRevision: current.authorization.authorizationRevision,
      requiresPasswordChange: current.requiresPasswordChange,
    };
  }

  logout(token: string | undefined) {
    return this.sessions.logout(token);
  }

  async logoutSession(token: string | undefined, clientTypes: readonly ControlPlaneSessionClientType[]) {
    if (!this.enabled()) {
      // disabled 模式下本地信任会话也能被显式注销；未知/已失效 token 保持幂等成功。
      const local = token ? await this.resolveDisabledCredential(token, clientTypes) : undefined;
      return local ? this.sessions.logout(token) : { ok: true };
    }
    const current = await this.sessions.resolve(token, clientTypes);
    return this.sessions.logout(current ? token : undefined);
  }

  async mobileSessions(token: string | undefined, credentialClientTypes: readonly ControlPlaneSessionClientType[] = ["mobile"]) {
    return this.clientSessions(token, credentialClientTypes, "mobile");
  }

  async cliSessions(token: string | undefined, credentialClientTypes: readonly ControlPlaneSessionClientType[] = ["cli"]) {
    if (!this.enabled()) {
      // disabled 模式下本地信任会话仍可被列出，保证本地 CLI 会话可审计、可撤销。
      const current = await this.resolveDisabledCredential(token, credentialClientTypes);
      return current ? this.sessions.listClientSessions(current.user.id, "cli") : undefined;
    }
    return this.clientSessions(token, credentialClientTypes, "cli");
  }

  async revokeClientSession(
    token: string | undefined,
    credentialClientTypes: readonly ControlPlaneSessionClientType[],
    targetClientTypes: readonly ControlPlaneSessionClientType[],
    sessionId: string,
  ) {
    const current = await this.sessions.resolve(token, credentialClientTypes);
    return current ? this.sessions.revokeSession(current.user.id, sessionId, targetClientTypes) : undefined;
  }

  async revokeMobileSession(token: string | undefined, sessionId: string, credentialClientTypes: readonly ControlPlaneSessionClientType[] = ["mobile"]) {
    return this.revokeClientSession(token, credentialClientTypes, ["mobile"], sessionId);
  }

  async revokeCliSession(token: string | undefined, sessionId: string, credentialClientTypes: readonly ControlPlaneSessionClientType[] = ["cli"]) {
    if (!this.enabled()) {
      const current = await this.resolveDisabledCredential(token, credentialClientTypes);
      return current ? this.sessions.revokeSession(current.user.id, sessionId, ["cli"]) : undefined;
    }
    return this.revokeClientSession(token, credentialClientTypes, ["cli"], sessionId);
  }

  async createCliAuthorization(input: unknown, context: { publicOrigin: string; sourceId?: string }) {
    this.assertEnabled();
    return this.cli.create(input, context);
  }

  cliAuthorizationRequest(requestId: string) {
    this.assertEnabled();
    return this.cli.detail(requestId);
  }

  cliAuthorizationRequestByUserCode(userCode: string) {
    this.assertEnabled();
    return this.cli.detailByUserCode(userCode);
  }

  async approveCliAuthorization(requestId: string, approver: ControlPlaneCliAuthorizationApprover) {
    this.assertEnabled();
    return this.cli.approve(requestId, approver);
  }

  async denyCliAuthorization(requestId: string, approver: ControlPlaneCliAuthorizationApprover) {
    this.assertEnabled();
    return this.cli.deny(requestId, approver);
  }

  async exchangeCliToken(input: unknown, context: { sourceId?: string } = {}) {
    this.assertEnabled();
    return this.cli.exchange(input, context);
  }

  /**
   * 本地信任会话：仅 authentication disabled 且来源为 loopback 时可用，
   * 以幂等创建的内置本地操作员身份签发可审计、可撤销的 cli 会话。
   */
  async createLocalCliSession(input: unknown, context: { remoteAddress?: string; sourceId?: string } = {}) {
    if (this.enabled()) {
      throw Object.assign(new Error("Local CLI sessions are unavailable while Control Plane authentication is enabled. Run `thctl login` instead."), {
        code: "AUTH_LOCAL_SESSION_UNAVAILABLE",
        statusCode: 403,
      });
    }
    if (!isLoopbackRemoteAddress(context.remoteAddress)) {
      throw Object.assign(new Error("Local CLI sessions are only available to clients on the same machine."), {
        code: "AUTH_LOCAL_SESSION_NOT_LOCAL",
        statusCode: 403,
      });
    }
    const parsed = ControlPlaneCliLocalSessionRequestSchema.parse(input);
    const operator = await this.users.ensureLocalTrustOperator();
    const created = await this.sessions.createSessionForIdentity(operator.identityId, "cli", { client: parsed.client, loginAt: now() });
    const user = await this.users.summary(operator.userId);
    const timestamp = now();
    await this.users.store.audit.put({
      id: createId("uaudit"),
      action: "cli-local-session.create",
      actorUserId: operator.userId,
      targetType: "cli-session",
      targetId: created.session.id,
      details: { source: "local-trust", client: parsed.client },
      createdAt: timestamp,
    });
    return ControlPlaneCliTokenResponseSchema.parse({
      data: {
        sessionToken: created.sessionToken,
        session: { ...created.session, client: parsed.client, user },
        authorization: created.authorization,
      },
    }).data;
  }

  /** disabled 模式解析 bearer 会话；用户库尚未初始化或会话无效时返回 undefined。 */
  private async resolveDisabledCredential(token: string, clientTypes: readonly ControlPlaneSessionClientType[]) {
    try {
      return await this.sessions.resolve(token, clientTypes);
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code === "CONTROL_PLANE_DATABASE_NOT_INITIALIZED") return undefined;
      throw error;
    }
  }

  private async clientSessions(token: string | undefined, clientTypes: readonly ControlPlaneSessionClientType[], clientType: "mobile" | "cli") {
    const current = await this.sessions.resolve(token, clientTypes);
    return current ? this.sessions.listClientSessions(current.user.id, clientType) : undefined;
  }

  async assertAppAccessAuthorization(binding: { userId: string; authorizationRevision: number; instanceId: string; nodeId: string }) {
    const authorization = await this.users.authorization(binding.userId);
    if (authorization.authorizationRevision !== binding.authorizationRevision) {
      throw Object.assign(new Error("The app access authorization has changed."), { code: "CONTROL_PLANE_AUTHORIZATION_REVISION_CONFLICT", statusCode: 401 });
    }
    assertCanAccessResolvedResource(
      { type: "user", identityId: "access-lease", requiresPasswordChange: false, ...authorization },
      "interactive-access",
      { type: "app-session" },
      { kind: "instance-derived", instanceId: binding.instanceId, nodeId: binding.nodeId },
    );
  }

  async notifyAuthorizationChanged(userId: string) {
    const [user, grant] = await Promise.all([this.users.store.users.get(userId), this.users.store.grants.get(userId)]);
    if (user && grant) this.onUserAuthorizationChanged?.({ userId, authorizationRevision: grant.authorizationRevision, status: user.status });
  }

  private assertEnabled() {
    if (!this.enabled()) throw Object.assign(new Error("Control Plane authentication is disabled."), { code: "AUTH_DISABLED", statusCode: 400 });
  }
}
