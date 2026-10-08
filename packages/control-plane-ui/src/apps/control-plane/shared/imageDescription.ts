import { resolveLocalizedText } from "./localizedText.ts";

type ImageDescriptionSource = {
  description?: string;
  localizedDescriptions?: Record<string, string>;
};

export function resolveImageDescription(image: ImageDescriptionSource, locale: string) {
  return resolveLocalizedText(image.localizedDescriptions, locale) || image.description || "";
}
