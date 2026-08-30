import crypto from "node:crypto";

export type BrowserAccessAuthorization = {
  userId: string;
  authorizationRevision: number;
};

export type BrowserAccessHandshake = {
  accessId: string;
  token: string;
  instanceId: string;
  authorization: BrowserAccessAuthorization;
  expiresAt: string;
};

type ActiveBrowserRelay = BrowserAccessHandshake & { close: () => void };

export class BrowserAccessService {
  private readonly pending = new Map<string, BrowserAccessHandshake & { timer: NodeJS.Timeout }>();
  private readonly active = new Map<string, ActiveBrowserRelay>();
  private readonly ttlMs: number;
  private issued = 0;
  private consumed = 0;
  private rejected = 0;
  private expired = 0;
  private closed = 0;

  constructor(ttlMs = 30_000) {
    this.ttlMs = ttlMs;
  }

  create(input: { instanceId: string; authorization: BrowserAccessAuthorization }) {
    const token = crypto.randomBytes(32).toString("base64url");
    const record: BrowserAccessHandshake = {
      accessId: `browser_${crypto.randomUUID().replace(/-/g, "")}`,
      token,
      instanceId: input.instanceId,
      authorization: input.authorization,
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
    };
    const timer = setTimeout(() => {
      if (this.pending.delete(token)) this.expired += 1;
    }, this.ttlMs);
    timer.unref?.();
    this.pending.set(token, { ...record, timer });
    this.issued += 1;
    return record;
  }

  consume(token: string) {
    const pending = this.pending.get(token);
    if (!pending || pending.expiresAt <= new Date().toISOString()) {
      this.rejected += 1;
      if (pending) clearTimeout(pending.timer);
      if (this.pending.delete(token)) this.expired += 1;
      throw invalidToken();
    }
    this.pending.delete(token);
    clearTimeout(pending.timer);
    const { timer: _timer, ...record } = pending;
    this.consumed += 1;
    return record;
  }

  track(access: BrowserAccessHandshake, close: () => void) {
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
    try { active.close(); } catch { /* Authorization is already revoked. */ }
    return true;
  }

  closeInstance(instanceId: string) {
    let closed = 0;
    for (const access of [...this.active.values()]) {
      if (access.instanceId !== instanceId) continue;
      if (this.closeAccess(access.accessId)) closed += 1;
    }
    for (const [token, pending] of this.pending) {
      if (pending.instanceId !== instanceId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(token);
    }
    return closed;
  }

  activeCount() {
    return this.active.size;
  }

  pendingCount() {
    return this.pending.size;
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

function invalidToken() {
  return Object.assign(new Error("Browser access token is invalid, expired, or already consumed."), {
    statusCode: 401,
    code: "BROWSER_ACCESS_TOKEN_INVALID",
  });
}
