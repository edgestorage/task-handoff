import { watch, type WatchStopHandle } from "vue";

export function waitForAiSessionProjection<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T | undefined> {
  const current = read();
  if (current !== undefined) return Promise.resolve(current);

  return new Promise((resolve) => {
    let settled = false;
    let stop: WatchStopHandle | undefined;
    let timeoutId: number | undefined;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      stop?.();
      resolve(value);
    };

    timeoutId = window.setTimeout(() => finish(undefined), timeoutMs);
    stop = watch(read, (value) => {
      if (value !== undefined) finish(value);
    }, { flush: "sync" });

    // Cover a projection committed between the initial read and watcher setup.
    const projected = read();
    if (projected !== undefined) finish(projected);
  });
}
