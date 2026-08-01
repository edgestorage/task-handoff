import crypto from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { ControlPlaneRole } from "./authorization.ts";
import type { ControlPlaneStorePaths } from "../persistence/paths.ts";
import { createId, createSecret, JsonCollection, type StoredRecord } from "../../shared/persistence/store.ts";

const scryptAsync = promisify(crypto.scrypt);
export const CONTROL_PLANE_SESSION_COOKIE = "task_handoff_cp_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

export const ControlPlaneAuthModeSchema = z.enum(["disabled", "password"]);

const UsernameSchema = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.@-]+$/);
const PasswordSchema = z.string().min(8).max(4096);

export const BootstrapAdminSchema = z
  .object({
    username: UsernameSchema,
    password: PasswordSchema,
  })
  .strict();

export const LoginSchema = z
  .object({
    username: z.string().trim().min(1).max(80),
    password: z.string().min(1).max(4096),
  })
  .strict();

export type ControlPlaneAuthMode = z.infer<typeof ControlPlaneAuthModeSchema>;

export type ControlPlaneAuthOptions = {
  mode?: ControlPlaneAuthMode;
  loginRateLimit?: Partial<ControlPlaneLoginRateLimitOptions>;
};

export type ControlPlaneLoginRateLimitOptions = {
  windowMs: number;
  maxFailuresPerSource: number;
  maxFailuresPerUsername: number;
  maxConcurrent: number;
};

const DEFAULT_LOGIN_RATE_LIMIT: ControlPlaneLoginRateLimitOptions = {
  windowMs: 15 * 60 * 1000,
  maxFailuresPerSource: 20,
  maxFailuresPerUsername: 10,
  maxConcurrent: 4,
};
const MAX_LOGIN_RATE_LIMIT_KEYS = 10_000;

type AuthUser = StoredRecord & {
  username: string;
  passwordHash: string;
  role: ControlPlaneRole;
  lastLoginAt?: string;
};

type AuthSession = StoredRecord & {
  userId: string;
  tokenHash: string;
  expiresAt: string;
  lastSeenAt?: string;
};
const StoredRecordSchema = z.object({
  id: z.string().trim().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
const AuthUserSchema = StoredRecordSchema.extend({
  username: UsernameSchema,
  passwordHash: z.string().trim().min(1),
  role: z.enum(["viewer", "operator", "admin"]),
  lastLoginAt: z.string().datetime().optional(),
}).strict();
const AuthSessionSchema = StoredRecordSchema.extend({
  userId: z.string().trim().min(1),
  tokenHash: z.string().trim().min(1),
  expiresAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
}).strict();

function now() {
  return new Date().toISOString();
}

function positiveInteger(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function loginRateLimitOptions(input: Partial<ControlPlaneLoginRateLimitOptions> = {}): ControlPlaneLoginRateLimitOptions {
  return {
    windowMs: positiveInteger(input.windowMs, DEFAULT_LOGIN_RATE_LIMIT.windowMs),
    maxFailuresPerSource: positiveInteger(input.maxFailuresPerSource, DEFAULT_LOGIN_RATE_LIMIT.maxFailuresPerSource),
    maxFailuresPerUsername: positiveInteger(input.maxFailuresPerUsername, DEFAULT_LOGIN_RATE_LIMIT.maxFailuresPerUsername),
    maxConcurrent: positiveInteger(input.maxConcurrent, DEFAULT_LOGIN_RATE_LIMIT.maxConcurrent),
  };
}

class LoginRateLimiter {
  private readonly options: ControlPlaneLoginRateLimitOptions;
  private readonly sourceFailures = new Map<string, number[]>();
  private readonly usernameFailures = new Map<string, number[]>();
  private concurrent = 0;

  constructor(options: Partial<ControlPlaneLoginRateLimitOptions> = {}) {
    this.options = loginRateLimitOptions(options);
  }

  begin(sourceId: string, username: string) {
    const timestamp = Date.now();
    this.assertBucketAvailable(this.sourceFailures, sourceId, this.options.maxFailuresPerSource, timestamp);
    this.assertBucketAvailable(this.usernameFailures, username, this.options.maxFailuresPerUsername, timestamp);
    if (this.concurrent >= this.options.maxConcurrent) {
      throw loginRateLimitError("Too many password verifications are already in progress.", 1_000);
    }
    this.concurrent += 1;
  }

  finish() {
    this.concurrent = Math.max(0, this.concurrent - 1);
  }

  recordFailure(sourceId: string, username: string) {
    const timestamp = Date.now();
    this.record(this.sourceFailures, sourceId, timestamp);
    this.record(this.usernameFailures, username, timestamp);
    if (this.sourceFailures.size + this.usernameFailures.size > MAX_LOGIN_RATE_LIMIT_KEYS) {
      this.pruneAll(timestamp);
      this.trimOldest(this.sourceFailures, MAX_LOGIN_RATE_LIMIT_KEYS / 2);
      this.trimOldest(this.usernameFailures, MAX_LOGIN_RATE_LIMIT_KEYS / 2);
    }
  }

  private assertBucketAvailable(buckets: Map<string, number[]>, key: string, maximum: number, timestamp: number) {
    const failures = this.currentFailures(buckets, key, timestamp);
    if (failures.length < maximum) return;
    throw loginRateLimitError("Too many failed sign-in attempts. Try again later.", failures[0] + this.options.windowMs - timestamp);
  }

  private record(buckets: Map<string, number[]>, key: string, timestamp: number) {
    const failures = this.currentFailures(buckets, key, timestamp);
    failures.push(timestamp);
    buckets.set(key, failures);
  }

  private currentFailures(buckets: Map<string, number[]>, key: string, timestamp: number) {
    const cutoff = timestamp - this.options.windowMs;
    const failures = (buckets.get(key) || []).filter((value) => value > cutoff);
    if (failures.length) buckets.set(key, failures);
    else buckets.delete(key);
    return failures;
  }

  private pruneAll(timestamp: number) {
    for (const [key] of this.sourceFailures) this.currentFailures(this.sourceFailures, key, timestamp);
    for (const [key] of this.usernameFailures) this.currentFailures(this.usernameFailures, key, timestamp);
  }

  private trimOldest(buckets: Map<string, number[]>, maximum: number) {
    while (buckets.size > maximum) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) return;
      buckets.delete(oldest);
    }
  }
}

function loginRateLimitError(message: string, retryAfterMs: number) {
  const error = new Error(message);
  Object.assign(error, {
    statusCode: 429,
    code: "AUTH_LOGIN_RATE_LIMITED",
    retryable: true,
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  });
  return error;
}

function resolveAuthMode(options: ControlPlaneAuthOptions = {}) {
  return ControlPlaneAuthModeSchema.parse(options.mode || process.env.TASK_HANDOFF_CONTROL_PLANE_AUTH_MODE || "disabled");
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, hash: string) {
  const [scheme, salt, expected] = hash.split("$");
  if (scheme !== "scrypt" || !salt || !expected) {
    return false;
  }
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  const expectedBuffer = Buffer.from(expected, "base64url");
  return expectedBuffer.length === derived.length && crypto.timingSafeEqual(expectedBuffer, derived);
}

function publicUser(user: AuthUser) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
}

export class ControlPlaneAuth {
  readonly mode: ControlPlaneAuthMode;
  private readonly users: JsonCollection<AuthUser>;
  private readonly sessions: JsonCollection<AuthSession>;
  private readonly loginRateLimiter: LoginRateLimiter;
  private bootstrapAdminInProgress = false;

  constructor(paths: ControlPlaneStorePaths, options: ControlPlaneAuthOptions = {}) {
    this.mode = resolveAuthMode(options);
    this.users = new JsonCollection<AuthUser>(paths.authUsersDir, { schema: AuthUserSchema });
    this.sessions = new JsonCollection<AuthSession>(paths.authSessionsDir, { schema: AuthSessionSchema });
    this.loginRateLimiter = new LoginRateLimiter(options.loginRateLimit);
  }

  init() {
    this.users.init();
    this.sessions.init();
  }

  enabled() {
    return this.mode === "password";
  }

  state() {
    return {
      mode: this.mode,
      enabled: this.enabled(),
      requiresBootstrap: this.enabled() && this.users.list().length === 0,
    };
  }

  async bootstrapAdmin(input: unknown) {
    if (!this.enabled()) {
      const error = new Error("Control Plane authentication is disabled.");
      Object.assign(error, { statusCode: 400, code: "AUTH_DISABLED" });
      throw error;
    }
    if (this.bootstrapAdminInProgress) {
      const error = new Error("Control Plane admin initialization is already in progress.");
      Object.assign(error, { statusCode: 409, code: "AUTH_BOOTSTRAP_IN_PROGRESS" });
      throw error;
    }
    if (this.users.list().length > 0) {
      const error = new Error("Control Plane admin user already exists.");
      Object.assign(error, { statusCode: 409, code: "AUTH_BOOTSTRAP_ALREADY_DONE" });
      throw error;
    }
    const parsed = BootstrapAdminSchema.parse(input);
    this.bootstrapAdminInProgress = true;
    try {
      const timestamp = now();
      const user = this.users.put({
        id: createId("user"),
        username: parsed.username,
        passwordHash: await hashPassword(parsed.password),
        role: "admin",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return publicUser(user);
    } finally {
      this.bootstrapAdminInProgress = false;
    }
  }

  async login(input: unknown, context: { sourceId?: string } = {}) {
    if (!this.enabled()) {
      const error = new Error("Control Plane authentication is disabled.");
      Object.assign(error, { statusCode: 400, code: "AUTH_DISABLED" });
      throw error;
    }
    const parsed = LoginSchema.parse(input);
    const sourceId = String(context.sourceId || "unknown").trim() || "unknown";
    const normalizedUsername = parsed.username.toLocaleLowerCase("en-US");
    this.loginRateLimiter.begin(sourceId, normalizedUsername);
    try {
      const user = this.users.list().find((item) => item.username === parsed.username);
      if (!user || !(await verifyPassword(parsed.password, user.passwordHash))) {
        this.loginRateLimiter.recordFailure(sourceId, normalizedUsername);
        const error = new Error("Invalid username or password.");
        Object.assign(error, { statusCode: 401, code: "AUTH_LOGIN_FAILED" });
        throw error;
      }
      const timestamp = now();
      const token = createSecret();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      const session = this.sessions.put({
        id: createId("sess"),
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSeenAt: timestamp,
      });
      this.users.put({ ...user, lastLoginAt: timestamp, updatedAt: timestamp });
      return {
        user: publicUser({ ...user, lastLoginAt: timestamp, updatedAt: timestamp }),
        sessionToken: `${session.id}.${token}`,
        expiresAt,
      };
    } finally {
      this.loginRateLimiter.finish();
    }
  }

  async userForSessionToken(token: string | undefined) {
    if (!this.enabled()) {
      return undefined;
    }
    if (!token) {
      return undefined;
    }
    const [sessionId, secret] = token.split(".");
    if (!sessionId || !secret) {
      return undefined;
    }
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt <= now() || session.tokenHash !== sha256(secret)) {
      return undefined;
    }
    const user = this.users.get(session.userId);
    if (!user) {
      return undefined;
    }
    this.sessions.put({ ...session, lastSeenAt: now(), updatedAt: now() });
    return publicUser(user);
  }

  async currentSession(token: string | undefined) {
    const state = this.state();
    const user = await this.userForSessionToken(token);
    return {
      ...state,
      authenticated: !this.enabled() || Boolean(user),
      user,
    };
  }

  logout(token: string | undefined) {
    const sessionId = token?.split(".")[0];
    if (sessionId) {
      this.sessions.delete(sessionId);
    }
    return { ok: true };
  }
}
