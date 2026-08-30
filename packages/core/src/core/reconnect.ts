export const STANDARD_RECONNECT_BASE_DELAY_MS = 250;
export const STANDARD_RECONNECT_MAX_DELAY_MS = 60_000;

export function standardReconnectDelayMs(retryNumber: number, random: () => number = Math.random) {
  const normalizedRetry = Math.max(1, Math.floor(retryNumber));
  if (normalizedRetry === 1) return 0;
  if (normalizedRetry === 2) return STANDARD_RECONNECT_BASE_DELAY_MS;
  const baseDelay = Math.min(
    STANDARD_RECONNECT_MAX_DELAY_MS,
    STANDARD_RECONNECT_BASE_DELAY_MS * (2 ** (normalizedRetry - 2)),
  );
  return Math.min(
    STANDARD_RECONNECT_MAX_DELAY_MS,
    Math.round(baseDelay * (0.75 + random() * 0.5)),
  );
}

export class StandardReconnectBackoff {
  private retryNumber = 0;
  private readonly random: () => number;

  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  get attempts() {
    return this.retryNumber;
  }

  next() {
    this.retryNumber += 1;
    return {
      attempt: this.retryNumber,
      delay: standardReconnectDelayMs(this.retryNumber, this.random),
    };
  }

  reset() {
    this.retryNumber = 0;
  }
}

export class StandardReconnectTimer {
  private readonly backoff: StandardReconnectBackoff;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(random: () => number = Math.random) {
    this.backoff = new StandardReconnectBackoff(random);
  }

  get pending() {
    return Boolean(this.timer);
  }

  get attempts() {
    return this.backoff.attempts;
  }

  schedule(
    callback: () => void,
    options: { setTimeoutFn?: typeof setTimeout } = {},
  ) {
    if (this.timer) return undefined;
    const scheduled = this.backoff.next();
    const setTimeoutFn = options.setTimeoutFn || setTimeout;
    this.timer = setTimeoutFn(() => {
      this.timer = undefined;
      callback();
    }, scheduled.delay);
    return scheduled;
  }

  reset(clearTimeoutFn: typeof clearTimeout = clearTimeout) {
    if (this.timer) clearTimeoutFn(this.timer);
    this.timer = undefined;
    this.backoff.reset();
  }

  cancel(clearTimeoutFn: typeof clearTimeout = clearTimeout) {
    if (this.timer) clearTimeoutFn(this.timer);
    this.timer = undefined;
  }
}
