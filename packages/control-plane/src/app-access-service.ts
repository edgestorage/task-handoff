import type { ControlledInstance } from "@task-handoff/protocol/control-plane";
import type { AppSessionsSnapshot } from "@task-handoff/protocol/app-sessions";
import { ExpiringTokenStore } from "./expiring-token-store.ts";

export type AppAccessMode = "tty" | "vnc" | "web";

export type AppAccessToken = {
  token: string;
  instanceId: string;
  sessionId: string;
  mode: AppAccessMode;
  expiresAt: string;
};

export type AppAccessServiceOptions = {
  requireInstance: (instanceId: string) => Promise<ControlledInstance>;
  listAppSessions: () => Promise<{ instances: Array<{ instanceId: string; appSessions: AppSessionsSnapshot }> }>;
};

export class AppAccessService {
  private readonly requireInstance: AppAccessServiceOptions["requireInstance"];
  private readonly listAppSessions: AppAccessServiceOptions["listAppSessions"];
  private readonly tokens = new ExpiringTokenStore<AppAccessToken>({
    invalidMessage: "App access link is invalid or expired.",
    invalidCode: "APP_ACCESS_TOKEN_INVALID",
    invalidStatusCode: 401,
    tokenBytes: 24,
    ttlMs: 15 * 60 * 1000,
  });

  constructor(options: AppAccessServiceOptions) {
    this.requireInstance = options.requireInstance;
    this.listAppSessions = options.listAppSessions;
  }

  createToken(input: { instanceId: string; sessionId: string; mode: AppAccessMode; ttlMs?: number }) {
    return this.tokens.create({
      instanceId: input.instanceId,
      sessionId: input.sessionId,
      mode: input.mode,
      ttlMs: input.ttlMs,
    });
  }

  resolveToken(token: string, mode?: AppAccessMode) {
    return this.tokens.resolve(token, (record) => !mode || record.mode === mode);
  }

  async proxyTarget(token: string, mode: AppAccessMode, suffix = "") {
    const access = this.resolveToken(token, mode);
    const instance = await this.requireInstance(access.instanceId);
    const appSessions = await this.listAppSessions();
    const session = appSessions.instances
      .find((entry) => entry.instanceId === access.instanceId)
      ?.appSessions.sessions.find((entry) => stringValue(entry.id) === access.sessionId);
    if (!session) {
      const error = new Error("App session was not found.");
      Object.assign(error, { statusCode: 404, code: "APP_SESSION_NOT_FOUND" });
      throw error;
    }
    return {
      access,
      instance,
      session,
      path: appSessionTokenProxyPath(mode, access.sessionId, session, suffix),
    };
  }
}

function appSessionTokenProxyPath(mode: AppAccessMode, sessionId: string, session: Record<string, unknown>, suffix = "") {
  if (mode === "tty") {
    return `/api/apps/sessions/${encodeURIComponent(sessionId)}/tty`;
  }
  if (mode === "vnc") {
    if (suffix) {
      return validatedVncProxyPath(sessionId, suffix);
    }
    const vnc = objectRecord(session.vnc);
    return stringValue(vnc.noVncPath) || `/api/apps/sessions/${encodeURIComponent(sessionId)}/web/`;
  }
  const web = objectRecord(session.web);
  return stringValue(web.webPath) || `/api/apps/sessions/${encodeURIComponent(sessionId)}/web/`;
}

function validatedVncProxyPath(sessionId: string, suffix: string) {
  const normalized = `/${suffix.replace(/^\/+/, "")}`;
  const pathOnly = normalized.split("?", 1)[0] || "/";
  const encodedSessionId = encodeURIComponent(sessionId);
  const allowedPrefixes = [
    "/api/novnc/",
    `/api/apps/sessions/${encodedSessionId}/web/`,
    `/api/apps/sessions/${encodedSessionId}/vnc`,
    `/api/apps/sessions/${encodedSessionId}/novnc/`,
  ];
  if (!allowedPrefixes.some((prefix) => pathOnly === prefix.replace(/\/$/, "") || pathOnly.startsWith(prefix))) {
    const error = new Error("App access token cannot be used for this path.");
    Object.assign(error, { statusCode: 403, code: "APP_ACCESS_PATH_FORBIDDEN" });
    throw error;
  }
  return normalized;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
