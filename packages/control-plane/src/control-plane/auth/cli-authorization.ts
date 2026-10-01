import crypto from "node:crypto";
import {
  ControlPlaneCliAuthorizationRequestSchema,
  ControlPlaneCliAuthorizationSchema,
  ControlPlaneCliTokenRequestSchema,
  ControlPlaneCliTokenResponseSchema,
  CONTROL_PLANE_CLI_DEVICE_CODE_GRANT_TYPE,
  type ControlPlaneCliAuthorization,
  type ControlPlaneCliAuthorizationErrorCode,
  type ControlPlaneCliAuthorizationRequestDetail,
  type ControlPlaneCliClient,
} from "@task-handoff/protocol/control-plane-access";
import { nowIso as now } from "@task-handoff/core/core/time";
import { createId } from "../../shared/persistence/store.ts";
import type { ControlPlaneUserAuthentication } from "./user-authentication.ts";
import type { ControlPlaneUserService } from "./user-service.ts";

const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const RECORD_RETENTION_MS = 10 * 60 * 1000;
const DEVICE_CODE_POLL_INTERVAL_SECONDS = 5;
const DEVICE_CODE_SLOW_DOWN_SECONDS = 5;
const DEVICE_CODE_MAX_POLL_INTERVAL_SECONDS = 300;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USER_CODE_LENGTH = 8;

type CliAuthorizationStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

type CliAuthorizationRecord = {
  requestId: string;
  mode: "browser" | "device";
  status: CliAuthorizationStatus;
  client: ControlPlaneCliClient;
  createdAt: string;
  expiresAt: string;
  redirectUri?: string;
  state?: string;
  codeChallenge?: string;
  userCode?: string;
  intervalSeconds: number;
  lastPolledAt?: number;
  code?: string;
  approvedUserId?: string;
  approvedIdentityId?: string;
  decidedAt?: string;
  consumedAt?: string;
};

export type ControlPlaneCliAuthorizationApprover = { userId: string; identityId: string };

function authorizationFailure(code: ControlPlaneCliAuthorizationErrorCode, message: string, statusCode: number, details?: Record<string, unknown>) {
  return Object.assign(new Error(message), { code, statusCode, ...(details ? { details } : {}) });
}

function invalidGrant() {
  return authorizationFailure("CLI_AUTHORIZATION_INVALID_GRANT", "The CLI authorization grant is invalid or no longer usable.", 400);
}

class CliAuthorizationRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private readonly windowMs: number;
  private readonly maxAttempts: number;

  constructor(windowMs: number, maxAttempts: number) {
    this.windowMs = windowMs;
    this.maxAttempts = maxAttempts;
  }

  assert(key: string) {
    const timestamp = Date.now();
    const attempts = (this.buckets.get(key) || []).filter((value) => value > timestamp - this.windowMs);
    if (attempts.length >= this.maxAttempts) {
      throw Object.assign(new Error("Too many CLI authorization attempts. Try again later."), {
        code: "CLI_AUTHORIZATION_RATE_LIMITED",
        statusCode: 429,
        retryAfterSeconds: Math.max(1, Math.ceil((attempts[0] + this.windowMs - timestamp) / 1_000)),
      });
    }
    attempts.push(timestamp);
    this.buckets.set(key, attempts);
  }
}

export class ControlPlaneCliAuthorizationService {
  private readonly records = new Map<string, CliAuthorizationRecord>();
  private readonly userCodeIndex = new Map<string, string>();
  private readonly createLimiter = new CliAuthorizationRateLimiter(60 * 1000, 30);
  private readonly tokenLimiter = new CliAuthorizationRateLimiter(5 * 60 * 1000, 300);
  private readonly users: ControlPlaneUserService;
  private readonly sessions: ControlPlaneUserAuthentication;

  constructor(users: ControlPlaneUserService, sessions: ControlPlaneUserAuthentication) {
    this.users = users;
    this.sessions = sessions;
  }

  async create(input: unknown, context: { publicOrigin: string; sourceId?: string }): Promise<ControlPlaneCliAuthorization> {
    const parsed = ControlPlaneCliAuthorizationRequestSchema.parse(input);
    this.createLimiter.assert(`create:${context.sourceId?.trim() || "unknown"}`);
    this.prune();
    const createdAt = now();
    const expiresAt = new Date(Date.parse(createdAt) + AUTHORIZATION_TTL_MS).toISOString();
    const requestId = createId("cliauth");
    if (parsed.mode === "browser") {
      const record: CliAuthorizationRecord = {
        requestId,
        mode: "browser",
        status: "pending",
        client: parsed.client,
        createdAt,
        expiresAt,
        redirectUri: parsed.redirectUri,
        state: parsed.state,
        codeChallenge: parsed.codeChallenge,
        intervalSeconds: DEVICE_CODE_POLL_INTERVAL_SECONDS,
      };
      this.records.set(requestId, record);
      await this.audit(record, "cli-authorization.request", { mode: record.mode });
      return ControlPlaneCliAuthorizationSchema.parse({
        mode: "browser",
        requestId,
        verificationUri: `${context.publicOrigin}/cli/authorize?request=${encodeURIComponent(requestId)}`,
        expiresAt,
      });
    }
    const userCode = this.mintUserCode();
    const record: CliAuthorizationRecord = {
      requestId,
      mode: "device",
      status: "pending",
      client: parsed.client,
      createdAt,
      expiresAt,
      userCode,
      intervalSeconds: DEVICE_CODE_POLL_INTERVAL_SECONDS,
    };
    this.records.set(requestId, record);
    this.userCodeIndex.set(this.normalizeUserCode(userCode), requestId);
    await this.audit(record, "cli-authorization.request", { mode: record.mode });
    return ControlPlaneCliAuthorizationSchema.parse({
      mode: "device",
      requestId,
      verificationUri: `${context.publicOrigin}/cli/authorize`,
      verificationUriComplete: `${context.publicOrigin}/cli/authorize?user_code=${encodeURIComponent(userCode)}`,
      userCode,
      intervalSeconds: record.intervalSeconds,
      expiresAt,
    });
  }

  detail(requestId: string): ControlPlaneCliAuthorizationRequestDetail {
    this.prune();
    return this.project(this.requireRecord(requestId));
  }

  detailByUserCode(userCode: string): ControlPlaneCliAuthorizationRequestDetail {
    this.prune();
    const requestId = this.userCodeIndex.get(this.normalizeUserCode(userCode));
    const record = requestId ? this.records.get(requestId) : undefined;
    if (!record) throw authorizationFailure("CLI_AUTHORIZATION_REQUEST_UNKNOWN", "The CLI authorization request was not found.", 404);
    return this.project(record);
  }

  async approve(requestId: string, approver: ControlPlaneCliAuthorizationApprover) {
    const record = this.requireRecord(requestId);
    if (record.status === "pending") {
      record.status = "approved";
      record.approvedUserId = approver.userId;
      record.approvedIdentityId = approver.identityId;
      record.decidedAt = now();
      if (record.mode === "browser") record.code = crypto.randomBytes(32).toString("base64url");
      await this.audit(record, "cli-authorization.approve", { mode: record.mode });
    } else if (record.status === "expired") {
      throw authorizationFailure("CLI_AUTHORIZATION_EXPIRED", "The CLI authorization request expired. Start the sign-in again.", 410);
    } else if (record.status !== "approved" || record.approvedUserId !== approver.userId) {
      throw authorizationFailure("CLI_AUTHORIZATION_ALREADY_USED", "This CLI authorization request was already decided.", 409);
    }
    return {
      mode: record.mode,
      ...(record.mode === "browser" && record.redirectUri && record.code && record.state ? { redirectUri: this.callbackUri(record) } : {}),
    };
  }

  async deny(requestId: string, approver: ControlPlaneCliAuthorizationApprover) {
    const record = this.requireRecord(requestId);
    if (record.status === "expired") throw authorizationFailure("CLI_AUTHORIZATION_EXPIRED", "The CLI authorization request expired. Start the sign-in again.", 410);
    if (record.status === "approved" || record.status === "consumed") {
      throw authorizationFailure("CLI_AUTHORIZATION_ALREADY_USED", "This CLI authorization request was already decided.", 409);
    }
    if (record.status === "pending") {
      record.status = "denied";
      record.approvedUserId = approver.userId;
      record.decidedAt = now();
      await this.audit(record, "cli-authorization.deny", { mode: record.mode });
    }
    return { ok: true };
  }

  async exchange(input: unknown, context: { sourceId?: string } = {}) {
    const parsed = ControlPlaneCliTokenRequestSchema.parse(input);
    this.tokenLimiter.assert(`token:${context.sourceId?.trim() || "unknown"}`);
    this.prune();
    const record = this.records.get(parsed.requestId);
    if (!record) throw invalidGrant();
    if (record.status === "expired") return this.failExchange(record, "expired", authorizationFailure("CLI_AUTHORIZATION_EXPIRED", "The CLI authorization request expired. Start the sign-in again.", 410));
    if (record.status === "denied") return this.failExchange(record, "denied", authorizationFailure("CLI_AUTHORIZATION_DENIED", "The CLI authorization request was denied.", 403));
    if (record.status === "consumed") return this.failExchange(record, "already-used", authorizationFailure("CLI_AUTHORIZATION_ALREADY_USED", "This CLI authorization request was already exchanged.", 409));
    if (record.status === "pending") {
      if (parsed.grantType === CONTROL_PLANE_CLI_DEVICE_CODE_GRANT_TYPE) {
        const timestamp = Date.now();
        if (record.lastPolledAt !== undefined && timestamp - record.lastPolledAt < record.intervalSeconds * 1_000) {
          record.intervalSeconds = Math.min(record.intervalSeconds + DEVICE_CODE_SLOW_DOWN_SECONDS, DEVICE_CODE_MAX_POLL_INTERVAL_SECONDS);
          record.lastPolledAt = timestamp;
          return this.failExchange(record, "slow-down", authorizationFailure("CLI_AUTHORIZATION_SLOW_DOWN", "Poll the CLI authorization request less frequently.", 400, { intervalSeconds: record.intervalSeconds }));
        }
        record.lastPolledAt = timestamp;
      }
      throw authorizationFailure("CLI_AUTHORIZATION_PENDING", "The CLI authorization request is waiting for approval.", 400);
    }
    if (parsed.grantType === "authorization_code") {
      if (record.mode !== "browser" || !record.code || !record.codeChallenge) throw invalidGrant();
      const challenge = crypto.createHash("sha256").update(parsed.codeVerifier).digest("base64url");
      if (record.code !== parsed.code || challenge !== record.codeChallenge) throw invalidGrant();
    } else if (record.mode !== "device") {
      throw invalidGrant();
    }
    if (!record.approvedIdentityId) throw invalidGrant();
    record.status = "consumed";
    record.code = undefined;
    record.consumedAt = now();
    const created = await this.sessions.createSessionForIdentity(record.approvedIdentityId, "cli", { client: record.client });
    const user = await this.users.summary(created.session.userId);
    await this.audit(record, "cli-authorization.exchange", { mode: record.mode, userId: user.id });
    return ControlPlaneCliTokenResponseSchema.parse({
      data: {
        sessionToken: created.sessionToken,
        session: { ...created.session, client: record.client, user },
        authorization: created.authorization,
      },
    }).data;
  }

  private async failExchange(record: CliAuthorizationRecord, reason: string, error: Error) {
    await this.audit(record, "cli-authorization.exchange-failed", { mode: record.mode, reason });
    throw error;
  }

  private requireRecord(requestId: string) {
    const record = this.records.get(requestId);
    if (!record) throw authorizationFailure("CLI_AUTHORIZATION_REQUEST_UNKNOWN", "The CLI authorization request was not found.", 404);
    if ((record.status === "pending" || record.status === "approved") && record.expiresAt <= now()) record.status = "expired";
    return record;
  }

  private project(record: CliAuthorizationRecord): ControlPlaneCliAuthorizationRequestDetail {
    return {
      requestId: record.requestId,
      mode: record.mode,
      status: record.status,
      client: record.client,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      ...(record.redirectUri ? { redirectUri: record.redirectUri } : {}),
      ...(record.userCode ? { userCode: record.userCode } : {}),
      ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
    };
  }

  private callbackUri(record: CliAuthorizationRecord) {
    const url = new URL(record.redirectUri!);
    url.searchParams.set("code", record.code!);
    url.searchParams.set("state", record.state!);
    return url.toString();
  }

  private mintUserCode() {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const raw = Array.from({ length: USER_CODE_LENGTH }, () => USER_CODE_ALPHABET.charAt(crypto.randomInt(USER_CODE_ALPHABET.length))).join("");
      if (!this.userCodeIndex.has(raw)) return `${raw.slice(0, 4)}-${raw.slice(4)}`;
    }
    throw Object.assign(new Error("Unable to allocate a CLI authorization user code."), { code: "CLI_AUTHORIZATION_USER_CODE_UNAVAILABLE", statusCode: 503 });
  }

  private normalizeUserCode(userCode: string) {
    return userCode.trim().toUpperCase().replace(/[\s-]/g, "");
  }

  private prune() {
    const cutoff = Date.now() - RECORD_RETENTION_MS;
    for (const [requestId, record] of this.records) {
      if (Date.parse(record.expiresAt) > cutoff) continue;
      this.records.delete(requestId);
      if (record.userCode) this.userCodeIndex.delete(this.normalizeUserCode(record.userCode));
    }
  }

  private audit(record: CliAuthorizationRecord, action: string, details: Record<string, unknown>) {
    const timestamp = now();
    return this.users.store.audit.put({
      id: createId("uaudit"),
      action,
      ...(record.approvedUserId ? { actorUserId: record.approvedUserId } : {}),
      targetType: "cli-authorization",
      targetId: record.requestId,
      details: { mode: record.mode, client: record.client, ...details },
      createdAt: timestamp,
    });
  }
}
