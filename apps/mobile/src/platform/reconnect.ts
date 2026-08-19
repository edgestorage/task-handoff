export const MOBILE_RECONNECT_BASE_DELAY_MS = 250;
export const MOBILE_RECONNECT_MAX_DELAY_MS = 60_000;

export function mobileReconnectDelayMs(retryNumber: number, random: () => number = Math.random) {
  const normalizedRetry = Math.max(1, Math.floor(retryNumber));
  if (normalizedRetry === 1) return 0;
  if (normalizedRetry === 2) return MOBILE_RECONNECT_BASE_DELAY_MS;
  const baseDelay = Math.min(
    MOBILE_RECONNECT_MAX_DELAY_MS,
    MOBILE_RECONNECT_BASE_DELAY_MS * (2 ** (normalizedRetry - 2)),
  );
  return Math.min(
    MOBILE_RECONNECT_MAX_DELAY_MS,
    Math.round(baseDelay * (0.75 + random() * 0.5)),
  );
}

export class MobileReconnectBackoff {
  private retryNumber = 0;

  get attempts() {
    return this.retryNumber;
  }

  next() {
    this.retryNumber += 1;
    return { attempt: this.retryNumber, delay: mobileReconnectDelayMs(this.retryNumber) };
  }

  reset() {
    this.retryNumber = 0;
  }
}
