import type { ValueStore } from '../platform/secure-storage';
import { normalizeBrowserAddress } from './url';

export type BrowserPage = { url: string; title: string; visitedAt: number };
export type BrowserStartPage = { pinned: BrowserPage[]; recent: BrowserPage[] };
type Snapshot = Record<string, BrowserStartPage>;
const EMPTY: BrowserStartPage = { pinned: [], recent: [] };
const STORAGE_KEY = 'browser.start-pages';
const MAX_SCOPES = 100;
export const MAX_BROWSER_PINNED = 6;
const scopeKey = (controlPlaneId: string, instanceId: string) => JSON.stringify([controlPlaneId, instanceId]);

/** Device-local browsing data. Native navigation owns visits; drafts never enter this store. */
export class BrowserStartPageStore {
  private value: Snapshot = {};
  private readonly listeners = new Set<() => void>();
  private hydration?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly storage: ValueStore, private readonly now = Date.now) {}

  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    void this.load();
    return () => { this.listeners.delete(listener); };
  };
  page(controlPlaneId: string, instanceId: string, snapshot = this.value) {
    return snapshot[scopeKey(controlPlaneId, instanceId)] ?? EMPTY;
  }
  async visit(controlPlaneId: string, instanceId: string, url: string, title: string) {
    const page = sanitizePage({ url, title, visitedAt: this.now() });
    if (!page) return;
    await this.change(controlPlaneId, instanceId, (current) => {
      const previous = current.recent[0];
      if (previous?.url === page.url && previous.title === page.title) return current;
      if (previous?.url === page.url) page.visitedAt = previous.visitedAt;
      return { ...current, recent: [page, ...current.recent.filter((item) => item.url !== page.url)].slice(0, 12) };
    });
  }
  async togglePinned(controlPlaneId: string, instanceId: string, url: string, title: string) {
    const page = sanitizePage({ url, title, visitedAt: this.now() });
    if (!page) return;
    await this.change(controlPlaneId, instanceId, (current) => ({
      ...current,
      pinned: current.pinned.some((item) => item.url === page.url)
        ? current.pinned.filter((item) => item.url !== page.url)
        : current.pinned.length < MAX_BROWSER_PINNED ? [...current.pinned, page] : current.pinned,
    }));
  }
  async clearRecent(controlPlaneId: string, instanceId: string) {
    await this.change(controlPlaneId, instanceId, (current) => ({ ...current, recent: [] }));
  }
  async clearProfile(controlPlaneId: string) {
    await this.load();
    this.value = Object.fromEntries(Object.entries(this.value).filter(([key]) => JSON.parse(key)[0] !== controlPlaneId));
    await this.persist();
  }
  private load() {
    return this.hydration ??= (async () => {
      try { this.value = parseBrowserStartPages(await this.storage.get(STORAGE_KEY)); }
      catch { this.value = {}; }
      this.emit();
    })();
  }
  private async change(controlPlaneId: string, instanceId: string, update: (page: BrowserStartPage) => BrowserStartPage) {
    await this.load();
    const key = scopeKey(controlPlaneId, instanceId);
    const current = this.value[key] ?? EMPTY;
    const next = update(current);
    if (next === current) return;
    const { [key]: _previous, ...rest } = this.value;
    this.value = Object.fromEntries(Object.entries({ ...rest, [key]: next }).slice(-MAX_SCOPES));
    await this.persist();
  }
  private persist() {
    this.emit();
    const raw = JSON.stringify({ version: 1, scopes: this.value });
    this.writes = this.writes.then(() => this.storage.set(STORAGE_KEY, raw)).catch(() => undefined);
    return this.writes;
  }
  private emit() { for (const listener of this.listeners) listener(); }
}

export function parseBrowserStartPages(raw: string | undefined | null): Snapshot {
  try {
    const input = JSON.parse(raw || '{}');
    if (input?.version !== 1 || !record(input.scopes)) return {};
    return Object.fromEntries(Object.entries(input.scopes).flatMap(([key, value]) => {
      let scope: unknown;
      try { scope = JSON.parse(key); } catch { return []; }
      if (!Array.isArray(scope) || scope.length !== 2 || !scope.every((part) => typeof part === 'string' && part.length > 0) || !record(value)) return [];
      return [[key, { pinned: sanitizePages(value.pinned, MAX_BROWSER_PINNED), recent: sanitizePages(value.recent, 12).sort((a, b) => b.visitedAt - a.visitedAt) }]];
    }).slice(-MAX_SCOPES));
  } catch { return {}; }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function sanitizePage(input: unknown): BrowserPage | undefined {
  if (!record(input) || typeof input.url !== 'string' || input.url.length > 4096) return;
  try {
    const url = normalizeBrowserAddress(input.url);
    if (url === 'about:blank') return;
    return { url, title: typeof input.title === 'string' ? input.title.trim().slice(0, 200) : '', visitedAt: typeof input.visitedAt === 'number' && Number.isFinite(input.visitedAt) ? input.visitedAt : 0 };
  } catch { return; }
}
function sanitizePages(input: unknown, limit: number) {
  const pages = new Map<string, BrowserPage>();
  for (const raw of Array.isArray(input) ? input : []) {
    const page = sanitizePage(raw);
    if (page && !pages.has(page.url)) pages.set(page.url, page);
  }
  return [...pages.values()].slice(0, limit);
}
export function browserPageSuggestions(page: BrowserStartPage, query: string) {
  const search = query.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  const entries = new Map<string, BrowserPage>();
  for (const item of [...page.pinned, ...page.recent]) if (!entries.has(item.url)) entries.set(item.url, item);
  return [...entries.values()].map((item, order) => {
    const fields = [item.title.toLowerCase(), item.url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '')];
    const match = !search || fields.some((field) => field === search) ? 0 : fields.some((field) => field.startsWith(search)) ? 1 : fields.some((field) => field.includes(search)) ? 2 : 3;
    return { item, match, order };
  }).filter(({ match }) => match < 3).sort((a, b) => a.match - b.match || a.order - b.order).slice(0, 8).map(({ item }) => item);
}
