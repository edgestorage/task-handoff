import type { AppSessionAccessLease } from '@task-handoff/protocol/app-sessions';

export const APP_SESSION_ACCESS_RENEWAL_LEAD_MS = 60_000;
export const APP_SESSION_ACCESS_RETRY_MS = 10_000;

export function appSessionAccessRenewalDelay(expiresAt: string, now = Date.now()) {
  const expiration = Date.parse(expiresAt);
  if (!Number.isFinite(expiration)) return 0;
  return Math.max(0, expiration - now - APP_SESSION_ACCESS_RENEWAL_LEAD_MS);
}

export function shouldRenewAppSessionAccessAfterHttpStatus(statusCode: number) {
  return statusCode === 401;
}

export class AppSessionAccessLeaseController {
  private lease?: AppSessionAccessLease;
  private live = false;
  private renewing = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: {
    create(): Promise<AppSessionAccessLease>;
    revoke(token: string): Promise<void>;
    onError(cause?: unknown): void;
    onLease(lease?: AppSessionAccessLease): void;
  }) {}

  start() {
    this.live = true;
    return this.renew();
  }

  async renew(invalidateCurrent = false) {
    if (!this.live || this.renewing) return;
    if (invalidateCurrent && this.lease) {
      const invalid = this.lease;
      this.lease = undefined;
      this.options.onLease(undefined);
      void this.options.revoke(invalid.token).catch(() => undefined);
    }
    this.renewing = true;
    try {
      const created = await this.options.create();
      if (!this.live) {
        void this.options.revoke(created.token).catch(() => undefined);
        return;
      }
      const previous = this.lease;
      this.lease = created;
      this.options.onError(undefined);
      this.options.onLease(created);
      this.schedule(appSessionAccessRenewalDelay(created.expiresAt));
      if (previous && previous.token !== created.token) {
        void this.options.revoke(previous.token).catch(() => undefined);
      }
    } catch (cause) {
      if (!this.live) return;
      const currentRenewalDelay = this.lease ? appSessionAccessRenewalDelay(this.lease.expiresAt) : 0;
      if (!this.lease || Date.parse(this.lease.expiresAt) <= Date.now()) this.options.onError(cause);
      this.schedule(Math.max(APP_SESSION_ACCESS_RETRY_MS, currentRenewalDelay));
    } finally {
      this.renewing = false;
    }
  }

  stop() {
    this.live = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const current = this.lease;
    this.lease = undefined;
    if (current) void this.options.revoke(current.token).catch(() => undefined);
  }

  private schedule(delay: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.renew(); }, delay);
  }
}
