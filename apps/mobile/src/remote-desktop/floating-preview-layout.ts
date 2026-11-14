export const FLOATING_PREVIEW_MIN_WIDTH = 176;
export const FLOATING_PREVIEW_MAX_WIDTH = 360;
export const FLOATING_PREVIEW_DEFAULT_WIDTH = 244;
export const FLOATING_PREVIEW_COLLAPSED_WIDTH = 196;
export const FLOATING_PREVIEW_COLLAPSED_HEIGHT = 44;
export const FLOATING_PREVIEW_CAPTURE_ROW_HEIGHT = 52;
export const FLOATING_PREVIEW_HORIZONTAL_MARGIN = 16;
export const FLOATING_PREVIEW_TOP_MARGIN = 8;
export const FLOATING_PREVIEW_BOTTOM_RESERVED = 92;
export const FLOATING_PREVIEW_MEDIA_ASPECT_RATIO = 9 / 16;
export const FLOATING_PREVIEW_MIN_MEDIA_ASPECT_RATIO = 1 / 4;
export const FLOATING_PREVIEW_MAX_MEDIA_ASPECT_RATIO = 2;

export type FloatingPreviewInsets = {
  bottom: number;
  left: number;
  right: number;
  top?: number;
};

export type FloatingPreviewViewport = {
  height: number;
  insets: FloatingPreviewInsets;
  width: number;
};

export type FloatingPreviewPreference = {
  collapsed: boolean;
  width: number;
  xRatio: number;
  yRatio: number;
};

export type FloatingPreviewFrame = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type FloatingPreviewBounds = {
  maxBottom: number;
  maxRight: number;
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
};

export type FloatingPreviewLayout = {
  bounds: FloatingPreviewBounds;
  frame: FloatingPreviewFrame;
};

export const DEFAULT_FLOATING_PREVIEW_PREFERENCE: FloatingPreviewPreference = {
  collapsed: false,
  width: FLOATING_PREVIEW_DEFAULT_WIDTH,
  xRatio: 1,
  yRatio: 1,
};

export function clampFloatingPreview(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeFloatingPreviewMediaAspectRatio(mediaAspectRatio: number | undefined) {
  const ratio = Number(mediaAspectRatio) > 0 && Number.isFinite(mediaAspectRatio) ? Number(mediaAspectRatio) : FLOATING_PREVIEW_MEDIA_ASPECT_RATIO;
  return clampFloatingPreview(
    ratio,
    FLOATING_PREVIEW_MIN_MEDIA_ASPECT_RATIO,
    FLOATING_PREVIEW_MAX_MEDIA_ASPECT_RATIO,
  );
}

export function floatingPreviewMediaAspectRatio(width: number | undefined, height: number | undefined) {
  const ratio = Number(width) > 0 && Number(height) > 0 ? Number(height) / Number(width) : undefined;
  return normalizeFloatingPreviewMediaAspectRatio(ratio);
}

export function floatingPreviewMediaHeight(width: number, mediaAspectRatio = FLOATING_PREVIEW_MEDIA_ASPECT_RATIO) {
  return Math.round(Math.max(0, width) * normalizeFloatingPreviewMediaAspectRatio(mediaAspectRatio));
}

export function floatingPreviewHeight(width: number, collapsed: boolean, mediaAspectRatio = FLOATING_PREVIEW_MEDIA_ASPECT_RATIO) {
  return collapsed ? FLOATING_PREVIEW_COLLAPSED_HEIGHT : floatingPreviewMediaHeight(width, mediaAspectRatio) + FLOATING_PREVIEW_CAPTURE_ROW_HEIGHT;
}

export function floatingPreviewBounds(
  viewport: FloatingPreviewViewport,
  width: number,
  collapsed: boolean,
  mediaAspectRatio = FLOATING_PREVIEW_MEDIA_ASPECT_RATIO,
): FloatingPreviewBounds {
  const safeLeft = Math.max(0, viewport.insets.left);
  const safeRight = Math.max(0, viewport.insets.right);
  const safeBottom = Math.max(0, viewport.insets.bottom);
  const safeTop = Math.max(0, viewport.insets.top ?? 0);
  const minX = safeLeft + FLOATING_PREVIEW_HORIZONTAL_MARGIN;
  const maxRight = Math.max(minX, viewport.width - safeRight - FLOATING_PREVIEW_HORIZONTAL_MARGIN);
  const minY = safeTop + FLOATING_PREVIEW_TOP_MARGIN;
  const maxBottom = Math.max(
    minY,
    viewport.height - safeBottom - FLOATING_PREVIEW_BOTTOM_RESERVED,
  );
  const height = floatingPreviewHeight(width, collapsed, mediaAspectRatio);
  return {
    maxBottom,
    maxRight,
    maxX: Math.max(minX, maxRight - width),
    maxY: Math.max(minY, maxBottom - height),
    minX,
    minY,
  };
}

export function floatingPreviewWidthForViewport(
  viewport: FloatingPreviewViewport,
  preference: FloatingPreviewPreference,
  mediaAspectRatio = FLOATING_PREVIEW_MEDIA_ASPECT_RATIO,
) {
  const safeWidth = Math.max(
    0,
    viewport.width
      - Math.max(0, viewport.insets.left)
      - Math.max(0, viewport.insets.right)
      - FLOATING_PREVIEW_HORIZONTAL_MARGIN * 2,
  );
  if (preference.collapsed) return Math.min(FLOATING_PREVIEW_COLLAPSED_WIDTH, safeWidth);
  const safeTop = Math.max(0, viewport.insets.top ?? 0);
  const availableHeight = Math.max(
    0,
    viewport.height
      - Math.max(0, viewport.insets.bottom)
      - FLOATING_PREVIEW_BOTTOM_RESERVED
      - safeTop
      - FLOATING_PREVIEW_TOP_MARGIN
      - FLOATING_PREVIEW_CAPTURE_ROW_HEIGHT,
  );
  const maxWidthByHeight = Math.floor(availableHeight / normalizeFloatingPreviewMediaAspectRatio(mediaAspectRatio));
  const maxWidth = Math.min(FLOATING_PREVIEW_MAX_WIDTH, safeWidth, maxWidthByHeight);
  const minWidth = Math.min(FLOATING_PREVIEW_MIN_WIDTH, maxWidth);
  return clampFloatingPreview(preference.width, minWidth, maxWidth);
}

export function floatingPreviewLayout(
  viewport: FloatingPreviewViewport,
  preference: FloatingPreviewPreference,
  mediaAspectRatio = FLOATING_PREVIEW_MEDIA_ASPECT_RATIO,
): FloatingPreviewLayout {
  const width = floatingPreviewWidthForViewport(viewport, preference, mediaAspectRatio);
  const height = floatingPreviewHeight(width, preference.collapsed, mediaAspectRatio);
  const bounds = floatingPreviewBounds(viewport, width, preference.collapsed, mediaAspectRatio);
  const xRatio = clampFloatingPreview(preference.xRatio, 0, 1);
  const yRatio = clampFloatingPreview(preference.yRatio, 0, 1);
  return {
    bounds,
    frame: {
      height,
      width,
      x: bounds.minX + (bounds.maxX - bounds.minX) * xRatio,
      y: bounds.minY + (bounds.maxY - bounds.minY) * yRatio,
    },
  };
}

export function clampFloatingPreviewFrame(
  frame: FloatingPreviewFrame,
  viewport: FloatingPreviewViewport,
  mediaAspectRatio = FLOATING_PREVIEW_MEDIA_ASPECT_RATIO,
): FloatingPreviewFrame {
  const bounds = floatingPreviewBounds(viewport, frame.width, frame.height === FLOATING_PREVIEW_COLLAPSED_HEIGHT, mediaAspectRatio);
  return {
    ...frame,
    x: clampFloatingPreview(frame.x, bounds.minX, bounds.maxX),
    y: clampFloatingPreview(frame.y, bounds.minY, bounds.maxY),
  };
}

export function resistedFloatingPreviewDrag(value: number, min: number, max: number) {
  if (value < min) return min - Math.min(12, (min - value) * 0.25);
  if (value > max) return max + Math.min(12, (value - max) * 0.25);
  return value;
}

export function resizeFloatingPreviewFrame(input: {
  dx: number;
  dy?: number;
  edge: 'left' | 'right';
  mediaAspectRatio?: number;
  start: FloatingPreviewFrame;
  viewport: FloatingPreviewViewport;
}): FloatingPreviewFrame {
  const { dx, edge, mediaAspectRatio = FLOATING_PREVIEW_MEDIA_ASPECT_RATIO, start, viewport } = input;
  const ratio = normalizeFloatingPreviewMediaAspectRatio(mediaAspectRatio);
  const horizontal = edge === 'left' ? -dx : dx;
  // Project the corner gesture onto the fixed aspect ratio, so vertical and
  // diagonal movement resize the same frame as horizontal movement.
  const widthDelta = input.dy === undefined ? horizontal : (horizontal + ratio * input.dy) / (1 + ratio * ratio);
  const bounds = floatingPreviewBounds(viewport, start.width, false, mediaAspectRatio);
  const minWidth = Math.min(FLOATING_PREVIEW_MIN_WIDTH, Math.max(0, bounds.maxRight - bounds.minX));
  const maxWidthByHeight = Math.floor(
    Math.max(0, bounds.maxBottom - bounds.minY - FLOATING_PREVIEW_CAPTURE_ROW_HEIGHT)
      / normalizeFloatingPreviewMediaAspectRatio(mediaAspectRatio),
  );
  const maxWidth = Math.max(minWidth, Math.min(bounds.maxRight - bounds.minX, maxWidthByHeight));
  const frameForWidth = (width: number, x: number): FloatingPreviewFrame => {
    const height = floatingPreviewHeight(width, false, mediaAspectRatio);
    return {
      ...start,
      height,
      width,
      x,
      y: clampFloatingPreview(start.y, bounds.minY, Math.max(bounds.minY, bounds.maxBottom - height)),
    };
  };
  if (edge === 'left') {
    const width = clampFloatingPreview(start.width + widthDelta, minWidth, Math.min(maxWidth, start.x + start.width - bounds.minX));
    return frameForWidth(width, start.x + start.width - width);
  }
  const width = clampFloatingPreview(start.width + widthDelta, minWidth, Math.max(minWidth, Math.min(maxWidth, bounds.maxRight - start.x)));
  return frameForWidth(width, start.x);
}

export function floatingPreviewPreferenceForFrame(input: {
  collapsed: boolean;
  expandedWidth: number;
  frame: FloatingPreviewFrame;
  mediaAspectRatio?: number;
  viewport: FloatingPreviewViewport;
}): FloatingPreviewPreference {
  const { collapsed, expandedWidth, frame, mediaAspectRatio = FLOATING_PREVIEW_MEDIA_ASPECT_RATIO, viewport } = input;
  const frameCollapsed = frame.height === FLOATING_PREVIEW_COLLAPSED_HEIGHT;
  const bounds = floatingPreviewBounds(viewport, frame.width, frameCollapsed, mediaAspectRatio);
  return {
    collapsed,
    width: expandedWidth,
    xRatio: bounds.maxX > bounds.minX ? clampFloatingPreview((frame.x - bounds.minX) / (bounds.maxX - bounds.minX), 0, 1) : 1,
    yRatio: bounds.maxY > bounds.minY ? clampFloatingPreview((frame.y - bounds.minY) / (bounds.maxY - bounds.minY), 0, 1) : 1,
  };
}

export function floatingPreviewPreferenceForCollapse(input: {
  collapsed: boolean;
  frame: FloatingPreviewFrame;
  preference: FloatingPreviewPreference;
  viewport: FloatingPreviewViewport;
  mediaAspectRatio: number;
}): FloatingPreviewPreference {
  const expandedWidth = input.preference.collapsed ? input.preference.width : input.frame.width;
  const next = floatingPreviewLayout(input.viewport, { ...input.preference, collapsed: input.collapsed, width: expandedWidth }, input.mediaAspectRatio).frame;
  const frame = clampFloatingPreviewFrame({
    ...next,
    x: input.frame.x + (input.frame.width - next.width) * clampFloatingPreview(input.preference.xRatio, 0, 1),
    y: input.frame.y + input.frame.height - next.height,
  }, input.viewport, input.mediaAspectRatio);
  return floatingPreviewPreferenceForFrame({ collapsed: input.collapsed, expandedWidth, frame, viewport: input.viewport, mediaAspectRatio: input.mediaAspectRatio });
}
