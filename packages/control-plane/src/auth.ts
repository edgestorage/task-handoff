import crypto from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { ControlPlaneRole } from "./authorization.ts";
import { createId, createSecret, JsonCollection, type ControlPlaneStorePaths, type StoredRecord } from "./store.ts";

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
};

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

  constructor(paths: ControlPlaneStorePaths, options: ControlPlaneAuthOptions = {}) {
    this.mode = resolveAuthMode(options);
    this.users = new JsonCollection<AuthUser>(paths.authUsersDir, { schema: AuthUserSchema });
    this.sessions = new JsonCollection<AuthSession>(paths.authSessionsDir, { schema: AuthSessionSchema });
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
    if (this.users.list().length > 0) {
      const error = new Error("Control Plane admin user already exists.");
      Object.assign(error, { statusCode: 409, code: "AUTH_BOOTSTRAP_ALREADY_DONE" });
      throw error;
    }
    const parsed = BootstrapAdminSchema.parse(input);
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
  }

  async login(input: unknown) {
    if (!this.enabled()) {
      const error = new Error("Control Plane authentication is disabled.");
      Object.assign(error, { statusCode: 400, code: "AUTH_DISABLED" });
      throw error;
    }
    const parsed = LoginSchema.parse(input);
    const user = this.users.list().find((item) => item.username === parsed.username);
    if (!user || !(await verifyPassword(parsed.password, user.passwordHash))) {
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
