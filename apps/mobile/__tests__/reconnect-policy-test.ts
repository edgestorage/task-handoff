import {
  MOBILE_RECONNECT_MAX_DELAY_MS,
  MobileReconnectBackoff,
  mobileReconnectDelayMs,
} from '../src/platform/reconnect';

test('mobile reconnect policy matches the shared immediate and jittered exponential sequence', () => {
  expect(mobileReconnectDelayMs(1, () => 0.5)).toBe(0);
  expect(mobileReconnectDelayMs(2, () => 0.5)).toBe(250);
  expect(mobileReconnectDelayMs(3, () => 0)).toBe(375);
  expect(mobileReconnectDelayMs(3, () => 0.5)).toBe(500);
  expect(mobileReconnectDelayMs(3, () => 1)).toBe(625);
  expect(mobileReconnectDelayMs(20, () => 1)).toBe(MOBILE_RECONNECT_MAX_DELAY_MS);

  const backoff = new MobileReconnectBackoff();
  expect(backoff.next()).toEqual({ attempt: 1, delay: 0 });
  expect(backoff.next()).toEqual({ attempt: 2, delay: 250 });
  backoff.reset();
  expect(backoff.next()).toEqual({ attempt: 1, delay: 0 });
});
