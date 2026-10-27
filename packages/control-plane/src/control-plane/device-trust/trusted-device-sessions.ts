type TrustedSession = {
  close(reason: string): Promise<void> | void;
};

export type TrustedSessionClaim = Readonly<{ epoch: number }>;

/**
 * Tracks only live cloud-device relay sessions. A pin is the authorization
 * authority; this registry is the local side effect used to revoke it without
 * touching other device/access-context pins.
 */
export class TrustedDeviceSessionRegistry {
  private readonly sessions = new Map<string, Set<TrustedSession>>();
  private readonly closedPinRevisions = new Map<string, number>();
  private epoch = 0;

  beginClaim(): TrustedSessionClaim {
    return Object.freeze({ epoch: this.epoch });
  }

  register(pinId: string, authorizationRevision: number, claim: TrustedSessionClaim, session: TrustedSession) {
    if (claim.epoch !== this.epoch || (this.closedPinRevisions.get(pinId) ?? 0) >= authorizationRevision) return undefined;
    const current = this.sessions.get(pinId) ?? new Set<TrustedSession>();
    current.add(session);
    this.sessions.set(pinId, current);
    return () => {
      const active = this.sessions.get(pinId);
      if (!active) return;
      active.delete(session);
      if (!active.size) this.sessions.delete(pinId);
    };
  }

  async closePin(pinId: string, authorizationRevision: number, reason: string) {
    this.closedPinRevisions.set(pinId, Math.max(this.closedPinRevisions.get(pinId) ?? 0, authorizationRevision));
    const active = [...(this.sessions.get(pinId) ?? [])];
    this.sessions.delete(pinId);
    await Promise.allSettled(active.map((session) => session.close(reason)));
  }

  async closeAll(reason: string) {
    this.epoch += 1;
    const active = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.allSettled(active.flatMap(([, sessions]) => [...sessions].map((session) => session.close(reason))));
  }
}
