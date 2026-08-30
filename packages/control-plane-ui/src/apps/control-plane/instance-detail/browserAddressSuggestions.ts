export type PinnedBrowserShortcut = { id: string; name: string; url: string };
export type RecentBrowserPage = { title: string; url: string; visitedAt: number };

export type BrowserAddressSuggestion = {
  id: string;
  kind: "pinned" | "recent";
  title: string;
  url: string;
  host: string;
};

export type BrowserStartPageData = {
  pinned: PinnedBrowserShortcut[];
  recent: RecentBrowserPage[];
};

const MAX_PINNED = 6;
const MAX_RECENT = 12;
const MAX_SUGGESTIONS = 8;

export function normalizeDesktopBrowserUrl(value: string) {
  const trimmed = value.trim();
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Unsupported URL protocol.");
  return url.toString();
}

export function sanitizeBrowserStartPageData(input: unknown): BrowserStartPageData {
  const record = isRecord(input) ? input : {};
  const pinned = Array.isArray(record.pinned)
    ? record.pinned.flatMap(sanitizePinnedShortcut).slice(0, MAX_PINNED)
    : [];
  const recent = Array.isArray(record.recent)
    ? record.recent.flatMap(sanitizeRecentPage).sort((left, right) => right.visitedAt - left.visitedAt).slice(0, MAX_RECENT)
    : [];
  return { pinned, recent };
}

export function browserAddressSuggestions(
  pinned: readonly PinnedBrowserShortcut[],
  recent: readonly RecentBrowserPage[],
  query: string,
  limit = MAX_SUGGESTIONS,
): BrowserAddressSuggestion[] {
  const normalizedQuery = searchable(query);
  const candidates = [
    ...pinned.map((item, index) => suggestionCandidate("pinned", item.id, item.name, item.url, index)),
    ...recent.map((item, index) => suggestionCandidate("recent", item.url, item.title || item.url, item.url, index)),
  ];
  const deduplicated = new Map<string, ReturnType<typeof suggestionCandidate>>();
  for (const candidate of candidates) {
    if (!deduplicated.has(candidate.suggestion.url)) deduplicated.set(candidate.suggestion.url, candidate);
  }

  return [...deduplicated.values()]
    .flatMap((candidate) => {
      const match = suggestionMatch(candidate, normalizedQuery);
      return match === undefined ? [] : [{ ...candidate, match }];
    })
    .sort((left, right) => left.match - right.match || left.order - right.order)
    .slice(0, Math.max(0, limit))
    .map(({ suggestion }) => suggestion);
}

function sanitizePinnedShortcut(input: unknown): PinnedBrowserShortcut[] {
  if (!isRecord(input) || typeof input.id !== "string" || typeof input.name !== "string" || typeof input.url !== "string") return [];
  const id = input.id.trim();
  const name = input.name.trim();
  if (!id || !name) return [];
  try {
    return [{ id, name: name.slice(0, 40), url: normalizeDesktopBrowserUrl(input.url) }];
  } catch {
    return [];
  }
}

function sanitizeRecentPage(input: unknown): RecentBrowserPage[] {
  if (!isRecord(input) || typeof input.url !== "string") return [];
  try {
    const url = normalizeDesktopBrowserUrl(input.url);
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : url;
    const visitedAt = typeof input.visitedAt === "number" && Number.isFinite(input.visitedAt) ? input.visitedAt : 0;
    return [{ title, url, visitedAt }];
  } catch {
    return [];
  }
}

function suggestionCandidate(kind: BrowserAddressSuggestion["kind"], id: string, title: string, url: string, order: number) {
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./i, "");
  return {
    suggestion: { id: `${kind}:${id}`, kind, title, url, host } satisfies BrowserAddressSuggestion,
    fields: [title, host, url, url.replace(/^[a-z]+:\/\/(?:www\.)?/i, "")].map(searchable),
    order,
  };
}

function suggestionMatch(candidate: ReturnType<typeof suggestionCandidate>, query: string) {
  if (!query) return candidate.suggestion.kind === "pinned" ? 0 : 1;
  const exact = candidate.fields.some((field) => field === query);
  const prefix = candidate.fields.some((field) => field.startsWith(query));
  const contains = candidate.fields.some((field) => field.includes(query));
  if (!contains) return undefined;
  const sourceOffset = candidate.suggestion.kind === "pinned" ? 0 : 1;
  if (exact) return sourceOffset;
  if (prefix) return 2 + sourceOffset;
  return 4 + sourceOffset;
}

function searchable(value: string) {
  return value.trim().toLowerCase().replace(/^[a-z]+:\/\/(?:www\.)?/i, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
