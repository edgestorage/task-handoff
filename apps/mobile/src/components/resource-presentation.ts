/** UI presentation ownership only; resource lifecycle remains with its existing controller. */
export class ResourcePresentationRegistry {
  private readonly claims = new Map<string, symbol[]>();
  private readonly listeners = new Set<() => void>();
  owner(key: string) { return this.claims.get(key)?.at(-1); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  claim(key: string, owner: symbol) {
    const current = this.claims.get(key) || [];
    this.claims.set(key, [...current.filter((item) => item !== owner), owner]);
    this.emit();
    return () => {
      const remaining = (this.claims.get(key) || []).filter((item) => item !== owner);
      if (remaining.length) this.claims.set(key, remaining);
      else this.claims.delete(key);
      this.emit();
    };
  }
  private emit() { for (const listener of this.listeners) listener(); }
}
export const resourcePresentations = new ResourcePresentationRegistry();
