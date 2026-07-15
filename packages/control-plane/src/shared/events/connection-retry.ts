export const DEFAULT_EVENT_CONNECTION_SAFETY_INTERVAL_MS = 45_000;

export function eventConnectionSafetyIntervalMs(value?: number) {
  return Math.min(60_000, Math.max(30_000, value ?? DEFAULT_EVENT_CONNECTION_SAFETY_INTERVAL_MS));
}

export function eventConnectionRetryDelay(attempt: number, random = Math.random) {
  const baseDelay = Math.min(30_000, 1_000 * (2 ** Math.max(0, attempt)));
  return Math.min(30_000, Math.round(baseDelay * (0.75 + random() * 0.5)));
}

export class EventConnectionRetryTimer {
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  get pending() {
    return Boolean(this.timer);
  }

  get attempts() {
    return this.attempt;
  }

  schedule(
    callback: () => void,
    options: {
      random?: () => number;
      setTimeoutFn?: typeof setTimeout;
      clearTimeoutFn?: typeof clearTimeout;
    } = {},
  ) {
    if (this.timer) return undefined;
    const delay = eventConnectionRetryDelay(this.attempt, options.random);
    this.attempt += 1;
    const setTimeoutFn = options.setTimeoutFn || setTimeout;
    this.timer = setTimeoutFn(() => {
      this.timer = undefined;
      callback();
    }, delay);
    return { attempt: this.attempt, delay };
  }

  reset(clearTimeoutFn: typeof clearTimeout = clearTimeout) {
    if (this.timer) clearTimeoutFn(this.timer);
    this.timer = undefined;
    this.attempt = 0;
  }

  cancel(clearTimeoutFn: typeof clearTimeout = clearTimeout) {
    if (this.timer) clearTimeoutFn(this.timer);
    this.timer = undefined;
  }
}
