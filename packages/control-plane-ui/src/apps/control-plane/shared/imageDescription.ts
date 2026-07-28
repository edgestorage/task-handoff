type ImageDescriptionSource = {
  description?: string;
  localizedDescriptions?: Record<string, string>;
};

export function resolveImageDescription(image: ImageDescriptionSource, locale: string) {
  const normalizedLocale = locale.trim().replaceAll("_", "-").toLowerCase();
  const language = normalizedLocale.split("-")[0];
  const localizedEntries = Object.entries(image.localizedDescriptions || {});
  const exact = localizedEntries.find(([key]) => key.toLowerCase() === normalizedLocale)?.[1];
  if (exact) return exact;
  const languageDefault = localizedEntries.find(([key]) => key.toLowerCase() === language)?.[1];
  return languageDefault || image.description || "";
}
