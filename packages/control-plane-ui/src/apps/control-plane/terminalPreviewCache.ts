export type TerminalPreviewCacheEntry = {
  active: boolean;
  lastUsed: number;
  dispose(): void;
};

export class BoundedInactiveLruCache<Entry extends TerminalPreviewCacheEntry> {
  private readonly entries = new Map<string, Entry>();
  readonly limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Terminal preview cache limit must be a positive integer.");
    this.limit = limit;
  }

  get size() {
    return this.entries.size;
  }

  get(key: string) {
    return this.entries.get(key);
  }

  values() {
    return this.entries.values();
  }

  add(key: string, entry: Entry) {
    if (this.entries.has(key)) throw new Error(`Terminal preview cache entry already exists: ${key}`);
    if (this.entries.size >= this.limit) {
      const candidate = [...this.entries.entries()]
        .filter(([, cached]) => !cached.active)
        .sort(([, left], [, right]) => left.lastUsed - right.lastUsed)[0];
      if (!candidate) return false;
      this.entries.delete(candidate[0]);
      candidate[1].dispose();
    }
    this.entries.set(key, entry);
    return true;
  }

  remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    entry.dispose();
    return true;
  }

  prune(keep: (entry: Entry) => boolean) {
    for (const [key, entry] of this.entries) {
      if (!keep(entry)) this.remove(key);
    }
  }

  clear() {
    for (const entry of this.entries.values()) entry.dispose();
    this.entries.clear();
  }
}
