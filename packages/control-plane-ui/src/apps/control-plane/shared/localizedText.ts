/**
 * Resolves one entry of a locale-keyed text map for the active locale: exact
 * locale tag first, then the language subtag, then no match so the caller can
 * fall back to its canonical value. Covers both image descriptions and
 * product-shipped built-in project folder names.
 */
export function resolveLocalizedText(entries: Record<string, string> | undefined, locale: string | undefined) {
  if (!entries || !locale) return undefined;
  const normalized = locale.trim().replaceAll("_", "-").toLowerCase();
  if (!normalized) return undefined;
  const language = normalized.split("-")[0];
  const pairs = Object.entries(entries);
  return pairs.find(([key]) => key.toLowerCase() === normalized)?.[1]
    || pairs.find(([key]) => key.toLowerCase() === language)?.[1];
}
