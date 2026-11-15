export type RemoteDesktopSize = { width: number; height: number };
export type RemoteDesktopPoint = { x: number; y: number };
export type RemoteDesktopRect = RemoteDesktopPoint & RemoteDesktopSize;
export type RemoteDesktopTransform = { scale: number; translateX: number; translateY: number };

export const IDENTITY_REMOTE_DESKTOP_TRANSFORM: RemoteDesktopTransform = { scale: 1, translateX: 0, translateY: 0 };
export const MIN_REMOTE_DESKTOP_ZOOM = 1;
export const MAX_REMOTE_DESKTOP_ZOOM = 4;
/** Zoom at which the full edge-overlap pan range is available. */
export const REMOTE_DESKTOP_PAN_FULL_ZOOM = 1.3;
export const REMOTE_DESKTOP_MIN_VISIBLE_EDGE = 24;
export const REMOTE_DESKTOP_TRACKPAD_EDGE_INSET = 20;
const MULTITOUCH_TAP_TRAVEL_PX = 8;
const MULTITOUCH_TAP_SPREAD_PX = 10;
const MULTITOUCH_PINCH_OPPOSITION_PX = 6;
const MULTITOUCH_SCROLL_CONFIRM_TRAVEL_PX = 12;
const MULTITOUCH_SCROLL_MIN_FINGER_TRAVEL_PX = 3;

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
 * Touches in the contain letterbox are ignored by default so the remote cursor
 * does not drift away from the visible frame. Surfaces that need letterbox
 * gestures can opt into clamping the point onto the nearest content edge.
 */
export function remoteDesktopPointForTouch(
  point: RemoteDesktopPoint,
  viewport: RemoteDesktopSize,
  content: RemoteDesktopSize,
  transform: RemoteDesktopTransform = IDENTITY_REMOTE_DESKTOP_TRANSFORM,
  clampToContent = false,
): RemoteDesktopPoint | undefined {
  const rect = remoteDesktopContainRect(viewport, content);
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  const scale = clamp(transform.scale, MIN_REMOTE_DESKTOP_ZOOM, MAX_REMOTE_DESKTOP_ZOOM);
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const unscaledX = centerX + (point.x - centerX - transform.translateX) / scale;
  const unscaledY = centerY + (point.y - centerY - transform.translateY) / scale;
  if (!clampToContent && (unscaledX < rect.x || unscaledX > rect.x + rect.width || unscaledY < rect.y || unscaledY > rect.y + rect.height)) return undefined;
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
  const centered = viewportSize / 2 - center - scale * (rectStart + rectSize / 2 - center);
  // Open the edge-overlap range linearly so zooming out collapses the pan
  // bounds to the centered position instead of snapping across a threshold.
  const panProgress = clamp(
    (scale - MIN_REMOTE_DESKTOP_ZOOM) / (REMOTE_DESKTOP_PAN_FULL_ZOOM - MIN_REMOTE_DESKTOP_ZOOM),
    0,
    1,
  );
  const fullMin = REMOTE_DESKTOP_MIN_VISIBLE_EDGE - (left + transformedSize);
  const fullMax = viewportSize - REMOTE_DESKTOP_MIN_VISIBLE_EDGE - left;
  return clamp(
    translate,
    centered + (fullMin - centered) * panProgress,
    centered + (fullMax - centered) * panProgress,
  );
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

export function remoteDesktopMultiTouchInTapDeadZone(
  startMidpoint: RemoteDesktopPoint,
  currentMidpoint: RemoteDesktopPoint,
  startDistance: number,
  currentDistance: number,
) {
  return remoteDesktopTouchDistance(startMidpoint, currentMidpoint) < MULTITOUCH_TAP_TRAVEL_PX
    && Math.abs(currentDistance - startDistance) < MULTITOUCH_TAP_SPREAD_PX;
}

/**
 * A wheel event must scroll at the stationary pointer. In trackpad mode that is
 * the virtual cursor; in direct mode it is the last real pointer position.
 */
export function remoteDesktopScrollAnchor(
  mouseMode: 'direct' | 'trackpad',
  cursor: RemoteDesktopPoint,
  pointer?: RemoteDesktopPoint,
): RemoteDesktopPoint {
  return mouseMode === 'trackpad' ? cursor : pointer ?? cursor;
}

/**
 * Moves the trackpad cursor in normalized content coordinates. Once the cursor
 * reaches the visible edge while zoomed, the remaining movement pans the
 * content so the cursor stays pinned inside the viewport.
 */
export function remoteDesktopTrackpadMove(
  cursor: RemoteDesktopPoint,
  delta: RemoteDesktopPoint,
  transform: RemoteDesktopTransform,
  viewport: RemoteDesktopSize,
  content: RemoteDesktopSize,
  edgeInset = REMOTE_DESKTOP_TRACKPAD_EDGE_INSET,
): { cursor: RemoteDesktopPoint; transform: RemoteDesktopTransform } {
  const nextCursor = {
    x: clamp(cursor.x + delta.x, 0, 1),
    y: clamp(cursor.y + delta.y, 0, 1),
  };
  const rect = remoteDesktopContainRect(viewport, content);
  const constrained = constrainRemoteDesktopTransform(transform, viewport, rect);
  if (constrained.scale <= MIN_REMOTE_DESKTOP_ZOOM + 0.001 || rect.width <= 0 || rect.height <= 0) {
    return { cursor: nextCursor, transform: constrained };
  }
  const insetX = Math.min(edgeInset, viewport.width / 2);
  const insetY = Math.min(edgeInset, viewport.height / 2);
  const cursorView = remoteDesktopCursorViewPoint(nextCursor, constrained, viewport, rect);
  let translateX = constrained.translateX;
  let translateY = constrained.translateY;
  if (cursorView.x < insetX) translateX += insetX - cursorView.x;
  else if (cursorView.x > viewport.width - insetX) translateX -= cursorView.x - (viewport.width - insetX);
  if (cursorView.y < insetY) translateY += insetY - cursorView.y;
  else if (cursorView.y > viewport.height - insetY) translateY -= cursorView.y - (viewport.height - insetY);
  return {
    cursor: nextCursor,
    transform: constrainRemoteDesktopTransform({ ...constrained, translateX, translateY }, viewport, rect),
  };
}

/** Keeps the virtual cursor inside the visible frame after a two-finger pan. */
export function keepRemoteDesktopCursorVisible(
  cursor: RemoteDesktopPoint,
  transform: RemoteDesktopTransform,
  viewport: RemoteDesktopSize,
  content: RemoteDesktopSize,
  edgeInset = REMOTE_DESKTOP_TRACKPAD_EDGE_INSET,
): RemoteDesktopPoint {
  const rect = remoteDesktopContainRect(viewport, content);
  if (rect.width <= 0 || rect.height <= 0) return cursor;
  const constrained = constrainRemoteDesktopTransform(transform, viewport, rect);
  const cursorView = remoteDesktopCursorViewPoint(cursor, constrained, viewport, rect);
  const insetX = Math.min(edgeInset, viewport.width / 2);
  const insetY = Math.min(edgeInset, viewport.height / 2);
  const visibleX = clamp(cursorView.x, insetX, viewport.width - insetX);
  const visibleY = clamp(cursorView.y, insetY, viewport.height - insetY);
  if (visibleX === cursorView.x && visibleY === cursorView.y) return cursor;
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const unscaledX = centerX + (visibleX - centerX - constrained.translateX) / constrained.scale;
  const unscaledY = centerY + (visibleY - centerY - constrained.translateY) / constrained.scale;
  return {
    x: clamp((unscaledX - rect.x) / rect.width, 0, 1),
    y: clamp((unscaledY - rect.y) / rect.height, 0, 1),
  };
}

function remoteDesktopCursorViewPoint(
  cursor: RemoteDesktopPoint,
  transform: RemoteDesktopTransform,
  viewport: RemoteDesktopSize,
  rect: RemoteDesktopRect,
): RemoteDesktopPoint {
  return {
    x: viewport.width / 2 + transform.translateX + (cursor.x - 0.5) * rect.width * transform.scale,
    y: viewport.height / 2 + transform.translateY + (cursor.y - 0.5) * rect.height * transform.scale,
  };
}

/**
 * Classifies the first directionally clear movement of a two-finger gesture.
 * Scroll requires both fingers to travel in the same direction. Opposing
 * movement along their initial separation is a pinch even when the pair also
 * pans, so zooming does not turn into a wheel gesture. Keeping the decision
 * latched for the rest of the gesture avoids wheel/zoom oscillation.
 */
export function remoteDesktopMultiTouchIntent(
  startFirst: RemoteDesktopPoint,
  startSecond: RemoteDesktopPoint,
  currentFirst: RemoteDesktopPoint,
  currentSecond: RemoteDesktopPoint,
): 'pending' | 'scroll' | 'pinch' {
  const startMidpoint = remoteDesktopTouchMidpoint(startFirst, startSecond);
  const currentMidpoint = remoteDesktopTouchMidpoint(currentFirst, currentSecond);
  const startDistance = remoteDesktopTouchDistance(startFirst, startSecond);
  const currentDistance = remoteDesktopTouchDistance(currentFirst, currentSecond);
  const travel = remoteDesktopTouchDistance(startMidpoint, currentMidpoint);
  if (remoteDesktopMultiTouchInTapDeadZone(startMidpoint, currentMidpoint, startDistance, currentDistance)) return 'pending';

  const firstMove = { x: currentFirst.x - startFirst.x, y: currentFirst.y - startFirst.y };
  const secondMove = { x: currentSecond.x - startSecond.x, y: currentSecond.y - startSecond.y };
  const separationX = startSecond.x - startFirst.x;
  const separationY = startSecond.y - startFirst.y;
  if (startDistance > 0) {
    const firstAxisMove = (firstMove.x * separationX + firstMove.y * separationY) / startDistance;
    const secondAxisMove = (secondMove.x * separationX + secondMove.y * separationY) / startDistance;
    const opposingAxisTravel = Math.abs(firstAxisMove - secondAxisMove);
    if (firstAxisMove * secondAxisMove < 0 && opposingAxisTravel >= MULTITOUCH_PINCH_OPPOSITION_PX) return 'pinch';
  }

  const firstTravel = Math.hypot(firstMove.x, firstMove.y);
  const secondTravel = Math.hypot(secondMove.x, secondMove.y);
  const sameDirection = firstTravel >= MULTITOUCH_SCROLL_MIN_FINGER_TRAVEL_PX
    && secondTravel >= MULTITOUCH_SCROLL_MIN_FINGER_TRAVEL_PX
    && firstMove.x * secondMove.x + firstMove.y * secondMove.y > 0;
  if (sameDirection && travel >= MULTITOUCH_SCROLL_CONFIRM_TRAVEL_PX) return 'scroll';
  if (Math.abs(currentDistance - startDistance) >= 12) return 'pinch';
  return 'pending';
}
