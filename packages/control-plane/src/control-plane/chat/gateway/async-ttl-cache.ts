export type AsyncTtlCacheOptions = {
  now?: () => number;
};

export class AsyncTtlCache<T> {
  private readonly ttlMs: number;
  private readonly load: () => Promise<T>;
  private readonly now: () => number;
  private cached: { expiresAt: number; value: T } | undefined;
  private pending: Promise<T> | undefined;

  constructor(ttlMs: number, load: () => Promise<T>, options: AsyncTtlCacheOptions = {}) {
    this.ttlMs = ttlMs;
    this.load = load;
    this.now = options.now || Date.now;
  }

  get() {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return Promise.resolve(this.cached.value);
    }
    if (this.pending) return this.pending;
    const pending = this.load()
      .then((value) => {
        this.cached = { expiresAt: this.now() + this.ttlMs, value };
        return value;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
    return pending;
  }

  invalidate() {
    this.cached = undefined;
  }
}
