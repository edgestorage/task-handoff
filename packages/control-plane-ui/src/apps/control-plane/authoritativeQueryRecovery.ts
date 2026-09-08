import { StandardReconnectBackoff } from "@task-handoff/core/core/reconnect";

export type AuthoritativeQueryRecoveryFailure = {
  attempt: number;
  delay: number;
  error: unknown;
};

export function createAuthoritativeQueryRecovery(
  recover: () => Promise<unknown>,
  options: {
    random?: () => number;
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
    onFailure?: (failure: AuthoritativeQueryRecoveryFailure) => void;
  } = {},
) {
  const backoff = new StandardReconnectBackoff(options.random);
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const clearRetry = () => {
    if (retryTimer !== undefined) clearTimeoutFn(retryTimer);
    retryTimer = undefined;
  };

  const attempt = async (activeGeneration: number): Promise<void> => {
    if (generation !== activeGeneration) return;
    try {
      await recover();
      if (generation === activeGeneration) backoff.reset();
    } catch (error) {
      if (generation !== activeGeneration) return;
      const retry = backoff.next();
      options.onFailure?.({ ...retry, error });
      retryTimer = setTimeoutFn(() => {
        retryTimer = undefined;
        void attempt(activeGeneration);
      }, retry.delay);
    }
  };

  return {
    start() {
      const activeGeneration = ++generation;
      clearRetry();
      backoff.reset();
      return attempt(activeGeneration);
    },
    stop() {
      generation += 1;
      clearRetry();
      backoff.reset();
    },
  };
}
