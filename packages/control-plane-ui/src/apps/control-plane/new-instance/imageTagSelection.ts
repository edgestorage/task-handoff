import type { SelectableImage } from "../../../api/types";

export function selectableImageTags(image?: SelectableImage) {
  return image?.origin === "market" ? image.availableTags.filter((tag) => tag.status !== "yanked") : [];
}

export function defaultImageTag(image?: SelectableImage) {
  const tags = selectableImageTags(image);
  return tags.find((tag) => tag.name === "latest")?.name
    ?? tags.find((tag) => tag.name === image?.tag)?.name
    ?? tags[0]?.name
    ?? "";
}

export function resolveImageTag(image: SelectableImage | undefined, currentTag: string) {
  return selectableImageTags(image).some((tag) => tag.name === currentTag)
    ? currentTag
    : defaultImageTag(image);
}
