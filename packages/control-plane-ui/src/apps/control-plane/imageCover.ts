import type { ImageCover } from "../../api/types";

export const DEFAULT_IMAGE_COVER_URL = "/image-covers/default.svg";

export function resolveImageCover(cover?: ImageCover) {
  if (!cover) return DEFAULT_IMAGE_COVER_URL;
  if (cover.kind === "builtin") {
    return cover.key === "default-image-cover" ? DEFAULT_IMAGE_COVER_URL : DEFAULT_IMAGE_COVER_URL;
  }
  return cover.url || DEFAULT_IMAGE_COVER_URL;
}

export function useDefaultImageCover(event: Event) {
  const image = event.currentTarget;
  if (image instanceof HTMLImageElement && image.src !== new URL(DEFAULT_IMAGE_COVER_URL, window.location.href).href) {
    image.src = DEFAULT_IMAGE_COVER_URL;
  }
}
