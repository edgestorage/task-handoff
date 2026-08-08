import { AppSessionRecordSchema } from '@task-handoff/protocol/app-sessions';

import { canOpenAppSession } from '../src/app-sessions/status';
import { APP_SESSION_ACCESS_RENEWAL_LEAD_MS, AppSessionAccessLeaseController, appSessionAccessRenewalDelay, shouldRenewAppSessionAccessAfterHttpStatus } from '../src/app-sessions/access-lease';

describe('mobile App Session access', () => {
  test('opens running TTY and GUI sessions without treating Web sessions as VNC', () => {
    const session = (kind: string, status: string = 'running') => AppSessionRecordSchema.parse({ id: `${kind}-1`, kind, status, bindings: [] });
    expect(canOpenAppSession(session('tty'))).toBe(true);
    expect(canOpenAppSession(session('gui'))).toBe(true);
    expect(canOpenAppSession(session('web'))).toBe(false);
    expect(canOpenAppSession(session('gui', 'stopping'))).toBe(false);
    expect(canOpenAppSession(session('future-kind'))).toBe(false);
  });

  test('renews VNC access before expiry and recovers only authentication failures', () => {
    const now = Date.parse('2026-08-08T00:00:00.000Z');
    expect(appSessionAccessRenewalDelay('2026-08-08T00:15:00.000Z', now)).toBe(14 * 60_000);
    expect(appSessionAccessRenewalDelay('2026-08-08T00:00:30.000Z', now)).toBe(0);
    expect(APP_SESSION_ACCESS_RENEWAL_LEAD_MS).toBe(60_000);
    expect(shouldRenewAppSessionAccessAfterHttpStatus(401)).toBe(true);
    expect(shouldRenewAppSessionAccessAfterHttpStatus(403)).toBe(false);
    expect(shouldRenewAppSessionAccessAfterHttpStatus(500)).toBe(false);
  });

  test('lease controller rotates the token before expiry and revokes superseded access', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-08T00:00:00.000Z'));
    try {
      const leases = [
        { mode: 'vnc' as const, url: 'https://control.test/vnc?token=one', token: 'one', expiresAt: '2026-08-08T00:15:00.000Z' },
        { mode: 'vnc' as const, url: 'https://control.test/vnc?token=two', token: 'two', expiresAt: '2026-08-08T00:29:00.000Z' },
      ];
      const create = jest.fn(async () => leases.shift()!);
      const revoke = jest.fn(async () => undefined);
      const onLease = jest.fn();
      const controller = new AppSessionAccessLeaseController({ create, revoke, onError: jest.fn(), onLease });

      await controller.start();
      expect(onLease).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'one' }));
      await jest.advanceTimersByTimeAsync(14 * 60_000);
      expect(create).toHaveBeenCalledTimes(2);
      expect(onLease).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'two' }));
      expect(revoke).toHaveBeenCalledWith('one');

      controller.stop();
      expect(revoke).toHaveBeenCalledWith('two');
    } finally {
      jest.useRealTimers();
    }
  });
});
