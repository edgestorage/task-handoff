export type ExpiringValue = { expiresAt: string };

export class EphemeralTokenStore<T extends ExpiringValue> {
  private readonly values = new Map<string, T>();

  put(key: string, value: T) {
    this.prune();
    this.values.set(key, value);
  }

  take(key: string) {
    this.prune();
    const value = this.values.get(key);
    if (value) this.values.delete(key);
    return value;
  }

  prune(nowMs = Date.now()) {
    for (const [key, value] of this.values) {
      if (Date.parse(value.expiresAt) <= nowMs) this.values.delete(key);
    }
  }
}
