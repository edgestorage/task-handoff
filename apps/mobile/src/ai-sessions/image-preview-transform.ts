export type ImagePreviewTransform = { scale: number; x: number; y: number };
export type ImagePreviewSize = { width: number; height: number };

export const IMAGE_PREVIEW_MIN_SCALE = 1;
export const IMAGE_PREVIEW_MAX_SCALE = 3;

export function fitImagePreview(source: ImagePreviewSize, viewport: ImagePreviewSize): ImagePreviewSize {
  const ratio = Math.min(viewport.width / source.width, viewport.height / source.height);
  return { width: source.width * ratio, height: source.height * ratio };
}

export function imagePreviewScale(scale: number): number {
  'worklet';
  return Math.min(IMAGE_PREVIEW_MAX_SCALE, Math.max(IMAGE_PREVIEW_MIN_SCALE, scale));
}

/** Allow movement on both axes, even at fit size, while keeping part of the image reachable. */
export function constrainImagePreview(transform: ImagePreviewTransform, image: ImagePreviewSize, viewport: ImagePreviewSize): ImagePreviewTransform {
  'worklet';
  const visibleWidth = Math.min(48, image.width * transform.scale, viewport.width);
  const visibleHeight = Math.min(48, image.height * transform.scale, viewport.height);
  const maxX = (image.width * transform.scale + viewport.width) / 2 - visibleWidth;
  const maxY = (image.height * transform.scale + viewport.height) / 2 - visibleHeight;
  return { scale: transform.scale, x: Math.max(-maxX, Math.min(maxX, transform.x)), y: Math.max(-maxY, Math.min(maxY, transform.y)) };
}

/** Keep the image point under the pinch focal point as the fingers move and change distance. */
export function pinchImagePreview(start: ImagePreviewTransform, relativeScale: number, origin: { x: number; y: number }, focal: { x: number; y: number }): ImagePreviewTransform {
  'worklet';
  const scale = imagePreviewScale(start.scale * relativeScale);
  const ratio = scale / start.scale;
  return { scale, x: focal.x - (origin.x - start.x) * ratio, y: focal.y - (origin.y - start.y) * ratio };
}
