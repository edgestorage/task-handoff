export type RemoteDesktopSize = { width: number; height: number };
export type RemoteDesktopPoint = { x: number; y: number };
export type RemoteDesktopRect = RemoteDesktopPoint & RemoteDesktopSize;
export type RemoteDesktopTransform = { scale: number; translateX: number; translateY: number };

export const IDENTITY_REMOTE_DESKTOP_TRANSFORM: RemoteDesktopTransform = { scale: 1, translateX: 0, translateY: 0 };
export const MIN_REMOTE_DESKTOP_ZOOM = 1;
export const MAX_REMOTE_DESKTOP_ZOOM = 4;

/** The visible video rectangle produced by `objectFit: contain`. */
export function remoteDesktopContainRect(viewport: RemoteDesktopSize, content: RemoteDesktopSize): RemoteDesktopRect {
  if (viewport.width <= 0 || viewport.height <= 0 || content.width <= 0 || content.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.min(viewport.width / content.width, viewport.height / content.height);
  const width = content.width * scale;
  const height = content.height * scale;
  return { x: (viewport.width - width) / 2, y: (viewport.height - height) / 2, width, height };
}

/**
 * Converts a view-space touch into normalized remote-desktop coordinates. The
 * transform matches the wrapper style: scale and translate around view center.
 * Touches in the contain letterbox are ignored instead of being clamped onto an
 * edge, which would make the remote cursor drift away from the visible frame.
 */
export function remoteDesktopPointForTouch(
  point: RemoteDesktopPoint,
  viewport: RemoteDesktopSize,
  content: RemoteDesktopSize,
  transform: RemoteDesktopTransform = IDENTITY_REMOTE_DESKTOP_TRANSFORM,
): RemoteDesktopPoint | undefined {
  const rect = remoteDesktopContainRect(viewport, content);
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  const scale = clamp(transform.scale, MIN_REMOTE_DESKTOP_ZOOM, MAX_REMOTE_DESKTOP_ZOOM);
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const unscaledX = centerX + (point.x - centerX - transform.translateX) / scale;
  const unscaledY = centerY + (point.y - centerY - transform.translateY) / scale;
  if (unscaledX < rect.x || unscaledX > rect.x + rect.width || unscaledY < rect.y || unscaledY > rect.y + rect.height) return undefined;
  return {
    x: clamp((unscaledX - rect.x) / rect.width, 0, 1),
    y: clamp((unscaledY - rect.y) / rect.height, 0, 1),
  };
}

/**
 * Pinch/pan transform around the gesture midpoint. `source` is the unscaled
 * content point that started under the initial midpoint, so zoom and pan stay
 * anchored even when the user moves both fingers at once.
 */
export function remoteDesktopPinchTransform(
  start: RemoteDesktopTransform,
  startMidpoint: RemoteDesktopPoint,
  currentMidpoint: RemoteDesktopPoint,
  startDistance: number,
  currentDistance: number,
  viewport: RemoteDesktopSize,
  content: RemoteDesktopSize,
): RemoteDesktopTransform {
  const rect = remoteDesktopContainRect(viewport, content);
  if (rect.width <= 0 || rect.height <= 0 || startDistance <= 0) return start;
  const nextScale = clamp(start.scale * (currentDistance / startDistance), MIN_REMOTE_DESKTOP_ZOOM, MAX_REMOTE_DESKTOP_ZOOM);
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const sourceX = centerX + (startMidpoint.x - centerX - start.translateX) / start.scale;
  const sourceY = centerY + (startMidpoint.y - centerY - start.translateY) / start.scale;
  return constrainRemoteDesktopTransform({
    scale: nextScale,
    translateX: currentMidpoint.x - centerX - nextScale * (sourceX - centerX),
    translateY: currentMidpoint.y - centerY - nextScale * (sourceY - centerY),
  }, viewport, rect);
}

export function constrainRemoteDesktopTransform(
  transform: RemoteDesktopTransform,
  viewport: RemoteDesktopSize,
  rect: RemoteDesktopRect = remoteDesktopContainRect(viewport, viewport),
): RemoteDesktopTransform {
  const scale = clamp(transform.scale, MIN_REMOTE_DESKTOP_ZOOM, MAX_REMOTE_DESKTOP_ZOOM);
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  return {
    scale,
    translateX: constrainAxis(transform.translateX, viewport.width, rect.x, rect.width, centerX, scale),
    translateY: constrainAxis(transform.translateY, viewport.height, rect.y, rect.height, centerY, scale),
  };
}

function constrainAxis(translate: number, viewportSize: number, rectStart: number, rectSize: number, center: number, scale: number) {
  const left = center + scale * (rectStart - center);
  const transformedSize = rectSize * scale;
  if (transformedSize <= viewportSize) return viewportSize / 2 - center - scale * (rectStart + rectSize / 2 - center);
  const min = viewportSize - (left + transformedSize);
  const max = -left;
  return clamp(translate, min, max);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

export function remoteDesktopTouchDistance(a: RemoteDesktopPoint, b: RemoteDesktopPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function remoteDesktopTouchMidpoint(a: RemoteDesktopPoint, b: RemoteDesktopPoint): RemoteDesktopPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Classifies the first meaningful movement of a two-finger gesture. Fingers
 * moving together are a scroll; changing spacing is a pinch. Keeping the
 * decision latched for the rest of the gesture avoids wheel/zoom oscillation.
 */
export function remoteDesktopMultiTouchIntent(
  startMidpoint: RemoteDesktopPoint,
  currentMidpoint: RemoteDesktopPoint,
  startDistance: number,
  currentDistance: number,
): 'pending' | 'scroll' | 'pinch' {
  const travel = remoteDesktopTouchDistance(startMidpoint, currentMidpoint);
  const spread = Math.abs(currentDistance - startDistance);
  if (travel < 8 && spread < 10) return 'pending';
  return spread >= Math.max(12, travel) ? 'pinch' : 'scroll';
}
