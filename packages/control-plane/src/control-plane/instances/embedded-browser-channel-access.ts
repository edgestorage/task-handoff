import crypto from "node:crypto";

export type EmbeddedBrowserChannelAuthorization = {
  userId: string;
  authorizationRevision: number;
};

export type EmbeddedBrowserChannelAccess = {
  accessId: string;
  token: string;
  instanceId: string;
  sourceRef: string;
  generation: number;
  authorization: EmbeddedBrowserChannelAuthorization;
  expiresAt: string;
};

type PendingAccess = EmbeddedBrowserChannelAccess & { timer: NodeJS.Timeout };
type ActiveAccess = EmbeddedBrowserChannelAccess & { close: () => void };

/** One-time, process-memory ticket for the independent browser control relay. */
export class EmbeddedBrowserChannelAccessService {
  private readonly pending = new Map<string, PendingAccess>();
  private readonly active = new Map<string, ActiveAccess>();
  private readonly ttlMs: number;
  private issued = 0;
  private consumed = 0;
  private rejected = 0;
  private expired = 0;
  private closed = 0;

  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
  }

  create(input: {
    instanceId: string;
    sourceRef: string;
    generation: number;
    authorization: EmbeddedBrowserChannelAuthorization;
  }) {
    const token = crypto.randomBytes(32).toString("base64url");
    const access: EmbeddedBrowserChannelAccess = {
      accessId: `browser_channel_${crypto.randomUUID().replace(/-/g, "")}`,
      token,
      instanceId: input.instanceId,
      sourceRef: input.sourceRef,
      generation: input.generation,
      authorization: input.authorization,
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
    };
    const timer = setTimeout(() => {
      if (this.pending.delete(token)) this.expired += 1;
    }, this.ttlMs);
    timer.unref?.();
    this.pending.set(token, { ...access, timer });
    this.issued += 1;
    return access;
  }

  consume(token: string) {
    const pending = this.pending.get(token);
    if (!pending || pending.expiresAt <= new Date().toISOString()) {
      this.rejected += 1;
      if (pending) clearTimeout(pending.timer);
      if (this.pending.delete(token)) this.expired += 1;
      throw invalidBrowserChannelAccess();
    }
    this.pending.delete(token);
    clearTimeout(pending.timer);
    const { timer: _timer, ...access } = pending;
    this.consumed += 1;
    return access;
  }

  track(access: EmbeddedBrowserChannelAccess, close: () => void) {
    this.closeAccess(access.accessId);
    this.active.set(access.accessId, { ...access, close });
    return () => {
      const current = this.active.get(access.accessId);
      if (current?.close === close) this.active.delete(access.accessId);
    };
  }

  closeAccess(accessId: string) {
    const active = this.active.get(accessId);
    if (!active) return false;
    this.active.delete(accessId);
    this.closed += 1;
    try { active.close(); } catch { /* Revocation is already requested. */ }
    return true;
  }

  closeInstance(instanceId: string) {
    let closed = 0;
    for (const access of [...this.active.values()]) {
      if (access.instanceId === instanceId && this.closeAccess(access.accessId)) closed += 1;
    }
    for (const [token, pending] of this.pending) {
      if (pending.instanceId !== instanceId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(token);
    }
    return closed;
  }

  diagnostics() {
    return {
      pending: this.pending.size,
      active: this.active.size,
      issued: this.issued,
      consumed: this.consumed,
      rejected: this.rejected,
      expired: this.expired,
      closed: this.closed,
    };
  }
}

function invalidBrowserChannelAccess() {
  return Object.assign(new Error("Browser channel access token is invalid, expired, or already consumed."), {
    statusCode: 401,
    code: "BROWSER_CHANNEL_ACCESS_INVALID",
  });
}
