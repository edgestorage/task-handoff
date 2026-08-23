import crypto from "node:crypto";
import { z } from "zod";
import {
  ControlPlaneCurrentAuthorizationSchema,
  ControlPlaneMobileDeviceSchema,
  ControlPlaneUserSessionSummarySchema,
  type ControlPlaneMobileDevice,
} from "@task-handoff/protocol/control-plane-access";
import { nowIso as now } from "@task-handoff/core/core/time";
import { createId, createSecret } from "../../shared/persistence/store.ts";
import { normalizeControlPlaneLoginName, verifyControlPlanePassword } from "./passwords.ts";
import type { ControlPlaneUserService } from "./user-service.ts";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const SESSION_ACTIVITY_PRUNE_INTERVAL_MS = 1000 * 60 * 60;
const LoginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(4096),
}).strict();

type RateLimitOptions = {
  windowMs: number;
  maxFailuresPerSource: number;
  maxFailuresPerUsername: number;
  maxConcurrent: number;
};

const DEFAULT_RATE_LIMIT: RateLimitOptions = {
  windowMs: 15 * 60 * 1000,
  maxFailuresPerSource: 20,
  maxFailuresPerUsername: 10,
  maxConcurrent: 4,
};

class LoginRateLimiter {
  private readonly sourceFailures = new Map<string, number[]>();
  private readonly usernameFailures = new Map<string, number[]>();
  private readonly options: RateLimitOptions;
  private concurrent = 0;

  constructor(options: RateLimitOptions) {
    this.options = options;
  }

  begin(sourceId: string, username: string) {
    const timestamp = Date.now();
    this.assertAvailable(this.sourceFailures, sourceId, this.options.maxFailuresPerSource, timestamp);
    this.assertAvailable(this.usernameFailures, username, this.options.maxFailuresPerUsername, timestamp);
    if (this.concurrent >= this.options.maxConcurrent) throw this.error();
    this.concurrent += 1;
  }

  finish() {
    this.concurrent = Math.max(0, this.concurrent - 1);
  }

  failure(sourceId: string, username: string) {
    const timestamp = Date.now();
    this.current(this.sourceFailures, sourceId, timestamp).push(timestamp);
    this.current(this.usernameFailures, username, timestamp).push(timestamp);
  }

  private current(buckets: Map<string, number[]>, key: string, timestamp: number) {
    const values = (buckets.get(key) || []).filter((value) => value > timestamp - this.options.windowMs);
    buckets.set(key, values);
    return values;
  }

  private assertAvailable(buckets: Map<string, number[]>, key: string, maximum: number, timestamp: number) {
    const failures = this.current(buckets, key, timestamp);
    if (failures.length >= maximum) throw this.error(failures[0] + this.options.windowMs - timestamp);
  }

  private error(retryAfterMs = 1_000) {
    return Object.assign(new Error("Too many failed sign-in attempts. Try again later."), {
      code: "AUTH_LOGIN_RATE_LIMITED",
      statusCode: 429,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
    });
  }
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

export class ControlPlaneUserAuthentication {
  private readonly limiter: LoginRateLimiter;
  private readonly sessionActivity = new Map<string, { expiresAt: string; lastSeenAt: string }>();
  private readonly users: ControlPlaneUserService;
  private nextSessionActivityPruneAt = 0;

  constructor(users: ControlPlaneUserService, options: Partial<RateLimitOptions> = {}) {
    this.users = users;
    this.limiter = new LoginRateLimiter({ ...DEFAULT_RATE_LIMIT, ...options });
  }

  async loginLocal(input: unknown, context: { sourceId?: string; clientType?: "web" | "mobile"; device?: ControlPlaneMobileDevice } = {}) {
    const parsed = LoginSchema.parse(input);
    const loginName = normalizeControlPlaneLoginName(parsed.username);
    const sourceId = context.sourceId?.trim() || "unknown";
    this.limiter.begin(sourceId, loginName);
    try {
      const identity = await this.users.store.identities.findByLoginName(loginName);
      const valid = identity ? await verifyControlPlanePassword(parsed.password, identity.passwordHash || "") : false;
      if (!identity || !valid) {
        this.limiter.failure(sourceId, loginName);
        throw Object.assign(new Error("Invalid username or password."), { code: "AUTH_LOGIN_FAILED", statusCode: 401 });
      }
      const user = await this.users.store.users.get(identity.userId);
      if (!user || user.status !== "active") {
        this.limiter.failure(sourceId, loginName);
        throw Object.assign(new Error("Invalid username or password."), { code: "AUTH_LOGIN_FAILED", statusCode: 401 });
      }
      const timestamp = now();
      return this.createSessionForIdentity(identity.id, context.clientType || "web", context.device, { loginAt: timestamp });
    } finally {
      this.limiter.finish();
    }
  }

  async createSessionForIdentity(
    identityId: string,
    clientType: "web" | "mobile",
    device?: ControlPlaneMobileDevice,
    activity: { loginAt?: string } = {},
  ) {
    const parsedDevice = device ? ControlPlaneMobileDeviceSchema.parse(device) : undefined;
    if (clientType === "mobile" && !parsedDevice) throw Object.assign(new Error("Mobile sessions require device metadata."), { code: "AUTH_MOBILE_DEVICE_REQUIRED", statusCode: 400 });
    const timestamp = now();
    const secret = createSecret();
    const created = await this.users.store.transaction(async (repository) => {
      const identity = await repository.identities.get(identityId);
      if (!identity) throw Object.assign(new Error("Login identity was not found."), { code: "CONTROL_PLANE_IDENTITY_NOT_FOUND", statusCode: 404 });
      if (clientType === "mobile" && identity.requiresPasswordChange === true) {
        throw Object.assign(new Error("Change the temporary password in the Control Plane before signing in on mobile."), {
          code: "AUTH_PASSWORD_CHANGE_REQUIRED",
          statusCode: 403,
        });
      }
      const authorization = await this.users.authorization(identity.userId, repository);
      if (activity.loginAt) {
        const user = (await repository.users.get(identity.userId))!;
        await repository.users.put({ ...user, lastLoginAt: activity.loginAt, updatedAt: activity.loginAt });
        await repository.identities.put({ ...identity, lastUsedAt: activity.loginAt, updatedAt: activity.loginAt });
      }
      const record = await repository.sessions.put({
        id: createId(clientType === "mobile" ? "msess" : "sess"),
        userId: identity.userId,
        identityId,
        authorizationRevision: authorization.authorizationRevision,
        tokenHash: sha256(secret),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        createdAt: timestamp,
        updatedAt: timestamp,
        clientType,
        ...(parsedDevice ? { device: parsedDevice } : {}),
      });
      return { record, identity, authorization };
    });
    const { record, identity, authorization } = created;
    this.trackSessionActivity(record, timestamp);
    return {
      sessionToken: `${record.id}.${secret}`,
      expiresAt: record.expiresAt,
      session: await this.publicSession(record.id),
      user: await this.users.detail(identity.userId),
      authorization: ControlPlaneCurrentAuthorizationSchema.parse({ ...authorization, identityId }),
      requiresPasswordChange: identity.requiresPasswordChange === true,
    };
  }

  async changeLocalPassword(token: string | undefined, input: unknown) {
    const parsed = z.object({ currentPassword: z.string().min(1).max(4096), newPassword: z.string().min(8).max(4096) }).strict().parse(input);
    const current = await this.resolve(token, "web");
    if (!current) throw Object.assign(new Error("Sign in to change the password."), { code: "CONTROL_PLANE_AUTH_REQUIRED", statusCode: 401 });
    const identity = await this.users.store.identities.get(current.session.identityId);
    if (!identity || identity.kind !== "local-password" || !(await verifyControlPlanePassword(parsed.currentPassword, identity.passwordHash || ""))) {
      throw Object.assign(new Error("The current password is incorrect."), { code: "AUTH_CURRENT_PASSWORD_INVALID", statusCode: 400 });
    }
    if (await verifyControlPlanePassword(parsed.newPassword, identity.passwordHash || "")) {
      throw Object.assign(new Error("The new password must be different from the current password."), { code: "AUTH_PASSWORD_UNCHANGED", statusCode: 400 });
    }
    await this.users.resetLocalPassword(identity.userId, parsed.newPassword, false);
    return this.createSessionForIdentity(identity.id, "web");
  }

  async resolve(token: string | undefined, clientType?: "web" | "mobile") {
    const [sessionId, secret] = token?.split(".") || [];
    if (!sessionId || !secret) return undefined;
    const session = await this.users.store.sessions.get(sessionId);
    const timestamp = now();
    if (!session) {
      this.sessionActivity.delete(sessionId);
      return undefined;
    }
    if (session.expiresAt <= timestamp) {
      this.sessionActivity.delete(sessionId);
      return undefined;
    }
    if ((clientType && session.clientType !== clientType) || session.tokenHash !== sha256(secret)) return undefined;
    let authorization;
    try {
      authorization = await this.users.authorization(session.userId);
    } catch {
      await this.users.store.sessions.delete(session.id);
      this.sessionActivity.delete(session.id);
      return undefined;
    }
    if (authorization.authorizationRevision !== session.authorizationRevision) {
      await this.users.store.sessions.delete(session.id);
      this.sessionActivity.delete(session.id);
      return undefined;
    }
    this.trackSessionActivity(session, timestamp);
    return {
      session: { ...session, lastSeenAt: timestamp },
      user: await this.users.detail(session.userId),
      authorization: ControlPlaneCurrentAuthorizationSchema.parse({ ...authorization, identityId: session.identityId }),
      requiresPasswordChange: (await this.users.store.identities.get(session.identityId))?.requiresPasswordChange === true,
    };
  }

  async currentSession(token: string | undefined, clientType: "web" | "mobile" = "web") {
    const current = await this.resolve(token, clientType);
    return {
      authenticated: Boolean(current),
      user: current?.user,
      authorization: current?.authorization,
      requiresPasswordChange: current?.requiresPasswordChange === true,
    };
  }

  async listSessions(requestingUserId: string, targetUserId = requestingUserId) {
    if (requestingUserId !== targetUserId) {
      const authorization = await this.users.authorization(requestingUserId);
      if (!authorization.permissionIds.includes("users:manage")) throw Object.assign(new Error("Session management is forbidden."), { code: "CONTROL_PLANE_FORBIDDEN", statusCode: 403 });
    }
    const sessions = (await this.users.store.sessions.listByUser(targetUserId)).filter((session) => session.expiresAt > now());
    return Promise.all(sessions.map((session) => this.publicSession(session.id)));
  }

  async listMobileSessions(requestingUserId: string) {
    const sessions = (await this.users.store.sessions.listByUser(requestingUserId))
      .filter((session) => session.clientType === "mobile" && session.expiresAt > now());
    return Promise.all(sessions.map(async (session) => ({
      ...await this.publicSession(session.id),
      device: session.device!,
      user: await this.users.detail(session.userId),
    })));
  }

  async revokeSession(requestingUserId: string, sessionId: string) {
    const session = await this.users.store.sessions.get(sessionId);
    if (!session) {
      this.sessionActivity.delete(sessionId);
      return false;
    }
    if (session.userId !== requestingUserId && !(await this.users.authorization(requestingUserId)).permissionIds.includes("users:manage")) {
      throw Object.assign(new Error("Session management is forbidden."), { code: "CONTROL_PLANE_FORBIDDEN", statusCode: 403 });
    }
    const revoked = await this.users.store.sessions.delete(sessionId);
    if (revoked) this.sessionActivity.delete(sessionId);
    return revoked;
  }

  async logout(token: string | undefined) {
    const sessionId = token?.split(".")[0];
    if (sessionId) {
      await this.users.store.sessions.delete(sessionId);
      this.sessionActivity.delete(sessionId);
    }
    return { ok: true };
  }

  private async publicSession(sessionId: string) {
    const session = await this.users.store.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error("Session was not found."), { code: "CONTROL_PLANE_SESSION_NOT_FOUND", statusCode: 404 });
    return ControlPlaneUserSessionSummarySchema.parse({
      id: session.id,
      userId: session.userId,
      identityId: session.identityId,
      clientType: session.clientType,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastSeenAt: this.sessionActivity.get(session.id)?.lastSeenAt || session.lastSeenAt || session.createdAt,
    });
  }

  private trackSessionActivity(session: { id: string; expiresAt: string }, timestamp: string) {
    const timestampMs = Date.parse(timestamp);
    if (timestampMs >= this.nextSessionActivityPruneAt) {
      for (const [sessionId, activity] of this.sessionActivity) {
        if (Date.parse(activity.expiresAt) <= timestampMs) this.sessionActivity.delete(sessionId);
      }
      this.nextSessionActivityPruneAt = timestampMs + SESSION_ACTIVITY_PRUNE_INTERVAL_MS;
    }
    this.sessionActivity.set(session.id, { expiresAt: session.expiresAt, lastSeenAt: timestamp });
  }
}
