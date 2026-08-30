export type ExpiringValue = { expiresAt: string };

export class EphemeralTokenStore<T extends ExpiringValue> {
  private readonly values = new Map<string, T>();

  put(key: string, value: T, nowMs = Date.now()) {
    this.prune(nowMs);
    this.values.set(key, value);
  }

  take(key: string, nowMs = Date.now()) {
    this.prune(nowMs);
    const value = this.values.get(key);
    if (value) this.values.delete(key);
    return value;
  }

  peek(key: string, nowMs = Date.now()) {
    this.prune(nowMs);
    return this.values.get(key);
  }

  delete(key: string, nowMs = Date.now()) {
    this.prune(nowMs);
    const value = this.values.get(key);
    if (value) this.values.delete(key);
    return value;
  }

  list(nowMs = Date.now()) {
    this.prune(nowMs);
    return [...this.values.values()];
  }

  prune(nowMs = Date.now()) {
    for (const [key, value] of this.values) {
      if (Date.parse(value.expiresAt) <= nowMs) this.values.delete(key);
    }
  }
}
