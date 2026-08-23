import { z } from "zod";
import type { ControlPlaneMobileDevice } from "@task-handoff/protocol/control-plane-access";
import type { ControlPlaneStorePaths } from "../persistence/paths.ts";
import type { ControlPlaneUserDatabaseConfigInput } from "./database/index.ts";
import { assertCanAccessResolvedResource, type ControlPlaneUserAuthorizationContext } from "./authorization.ts";
import { ControlPlaneExternalAuthentication } from "./external-authentication.ts";
import { ControlPlaneIdentityProviderService } from "./identity-provider-service.ts";
import { ControlPlaneUserAuthentication } from "./user-authentication.ts";
import { ControlPlaneUserService } from "./user-service.ts";

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
  readonly identityProviders: ControlPlaneIdentityProviderService;
  readonly external: ControlPlaneExternalAuthentication;
  private readonly onUserAuthorizationChanged?: ControlPlaneAuthOptions["onUserAuthorizationChanged"];

  constructor(paths: ControlPlaneStorePaths, options: ControlPlaneAuthOptions = {}) {
    this.mode = ControlPlaneAuthModeSchema.parse(options.mode || process.env.TASK_HANDOFF_CONTROL_PLANE_AUTH_MODE || "disabled");
    this.users = new ControlPlaneUserService(paths, { database: options.database });
    this.sessions = new ControlPlaneUserAuthentication(this.users, options.loginRateLimit);
    this.identityProviders = new ControlPlaneIdentityProviderService(paths, this.users.store);
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

  state() {
    if (!this.enabled()) return { mode: this.mode, enabled: false, requiresBootstrap: false };
    return { mode: this.mode, enabled: true, requiresBootstrap: this.users.state().requiresBootstrap };
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

  async currentSession(token: string | undefined, clientType: "web" | "mobile" = "web") {
    const current = this.enabled() ? await this.sessions.currentSession(token, clientType) : { authenticated: true };
    return { ...this.state(), ...current };
  }

  async currentAccess(token: string | undefined, clientType: "web" | "mobile") {
    return (await this.sessions.resolve(token, clientType))?.authorization;
  }

  async authorizationForSessionToken(token: string | undefined, clientType: "web" | "mobile"): Promise<ControlPlaneUserAuthorizationContext | undefined> {
    const current = await this.sessions.resolve(token, clientType);
    if (!current) return undefined;
    return {
      type: "user",
      userId: current.authorization.userId,
      identityId: current.authorization.identityId,
      roleIds: current.authorization.roleIds,
      permissionIds: current.authorization.permissionIds,
      nodeScope: current.authorization.nodeScope,
      authorizationRevision: current.authorization.authorizationRevision,
    };
  }

  logout(token: string | undefined) {
    return this.sessions.logout(token);
  }

  async mobileSessions(token: string | undefined) {
    const current = await this.sessions.resolve(token);
    return current ? this.sessions.listMobileSessions(current.user.id) : undefined;
  }

  async revokeMobileSession(token: string | undefined, sessionId: string) {
    const current = await this.sessions.resolve(token);
    return current ? this.sessions.revokeSession(current.user.id, sessionId) : undefined;
  }

  assertAppAccessAuthorization(binding: { userId: string; authorizationRevision: number; nodeId: string }) {
    const authorization = this.users.authorization(binding.userId);
    if (authorization.authorizationRevision !== binding.authorizationRevision) {
      throw Object.assign(new Error("The app access authorization has changed."), { code: "CONTROL_PLANE_AUTHORIZATION_REVISION_CONFLICT", statusCode: 401 });
    }
    assertCanAccessResolvedResource({ type: "user", identityId: "access-lease", ...authorization }, "interactive-access", { type: "app-session" }, { kind: "node", nodeId: binding.nodeId });
  }

  notifyAuthorizationChanged(userId: string) {
    const user = this.users.store.users.get(userId);
    const grant = this.users.store.grants.get(userId);
    if (user && grant) this.onUserAuthorizationChanged?.({ userId, authorizationRevision: grant.authorizationRevision, status: user.status });
  }

  private assertEnabled() {
    if (!this.enabled()) throw Object.assign(new Error("Control Plane authentication is disabled."), { code: "AUTH_DISABLED", statusCode: 400 });
  }
}
