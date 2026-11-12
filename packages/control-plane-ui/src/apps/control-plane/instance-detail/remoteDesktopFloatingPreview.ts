export const SESSION_REMOTE_DESKTOP_PREVIEW_MIN_WIDTH = 280;
export const SESSION_REMOTE_DESKTOP_PREVIEW_MAX_WIDTH = 560;
export const SESSION_REMOTE_DESKTOP_PREVIEW_DEFAULT_WIDTH = 420;
export const SESSION_REMOTE_DESKTOP_PREVIEW_COLLAPSED_WIDTH = 260;
export const SESSION_REMOTE_DESKTOP_PREVIEW_COLLAPSED_HEIGHT = 48;
export const SESSION_REMOTE_DESKTOP_PREVIEW_FOOTER_HEIGHT = 54;
export const SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN = 24;
export const SESSION_REMOTE_DESKTOP_PREVIEW_TOP_MARGIN = 16;
export const SESSION_REMOTE_DESKTOP_PREVIEW_MIN_MEDIA_ASPECT_RATIO = 1 / 4;
export const SESSION_REMOTE_DESKTOP_PREVIEW_MAX_MEDIA_ASPECT_RATIO = 2;
export const SESSION_REMOTE_DESKTOP_PREVIEW_DEFAULT_MEDIA_ASPECT_RATIO = 9 / 16;

export type SessionRemoteDesktopPreviewViewport = {
  width: number;
  height: number;
};

export type SessionRemoteDesktopPreviewPreference = {
  collapsed: boolean;
  width: number;
  xRatio: number;
  yRatio: number;
};

export type SessionRemoteDesktopPreviewFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const DEFAULT_SESSION_REMOTE_DESKTOP_PREVIEW_PREFERENCE: SessionRemoteDesktopPreviewPreference = {
  collapsed: false,
  width: SESSION_REMOTE_DESKTOP_PREVIEW_DEFAULT_WIDTH,
  xRatio: 1,
  yRatio: 1,
};

export function normalizeSessionRemoteDesktopPreviewAspectRatio(value: number | undefined) {
  const ratio = Number(value) > 0 && Number.isFinite(value) ? Number(value) : SESSION_REMOTE_DESKTOP_PREVIEW_DEFAULT_MEDIA_ASPECT_RATIO;
  return clamp(ratio, SESSION_REMOTE_DESKTOP_PREVIEW_MIN_MEDIA_ASPECT_RATIO, SESSION_REMOTE_DESKTOP_PREVIEW_MAX_MEDIA_ASPECT_RATIO);
}

export function sessionRemoteDesktopPreviewAspectRatio(width: number | undefined, height: number | undefined) {
  return normalizeSessionRemoteDesktopPreviewAspectRatio(Number(width) > 0 && Number(height) > 0 ? Number(height) / Number(width) : undefined);
}

export function sessionRemoteDesktopPreviewLayout(
  viewport: SessionRemoteDesktopPreviewViewport,
  preference: SessionRemoteDesktopPreviewPreference,
  mediaAspectRatio = SESSION_REMOTE_DESKTOP_PREVIEW_DEFAULT_MEDIA_ASPECT_RATIO,
): SessionRemoteDesktopPreviewFrame {
  const safeWidth = Math.max(0, viewport.width - SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN * 2);
  const collapsed = preference.collapsed;
  const width = collapsed
    ? Math.min(SESSION_REMOTE_DESKTOP_PREVIEW_COLLAPSED_WIDTH, safeWidth)
    : clamp(preference.width, Math.min(SESSION_REMOTE_DESKTOP_PREVIEW_MIN_WIDTH, safeWidth), Math.min(SESSION_REMOTE_DESKTOP_PREVIEW_MAX_WIDTH, safeWidth));
  const ratio = normalizeSessionRemoteDesktopPreviewAspectRatio(mediaAspectRatio);
  const maxMediaHeight = Math.max(
    0,
    viewport.height - SESSION_REMOTE_DESKTOP_PREVIEW_TOP_MARGIN - SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN - SESSION_REMOTE_DESKTOP_PREVIEW_FOOTER_HEIGHT,
  );
  const displayWidth = collapsed ? width : Math.min(width, Math.floor(maxMediaHeight / ratio));
  const height = collapsed
    ? SESSION_REMOTE_DESKTOP_PREVIEW_COLLAPSED_HEIGHT
    : Math.round(displayWidth * ratio) + SESSION_REMOTE_DESKTOP_PREVIEW_FOOTER_HEIGHT;
  const minX = SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN;
  const maxX = Math.max(minX, viewport.width - SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN - displayWidth);
  const minY = SESSION_REMOTE_DESKTOP_PREVIEW_TOP_MARGIN;
  const maxY = Math.max(minY, viewport.height - SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN - height);
  return {
    x: minX + (maxX - minX) * clamp(preference.xRatio, 0, 1),
    y: minY + (maxY - minY) * clamp(preference.yRatio, 0, 1),
    width: displayWidth,
    height,
  };
}

export function clampSessionRemoteDesktopPreviewFrame(
  frame: SessionRemoteDesktopPreviewFrame,
  viewport: SessionRemoteDesktopPreviewViewport,
) {
  return {
    ...frame,
    x: clamp(frame.x, SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN, Math.max(SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN, viewport.width - SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN - frame.width)),
    y: clamp(frame.y, SESSION_REMOTE_DESKTOP_PREVIEW_TOP_MARGIN, Math.max(SESSION_REMOTE_DESKTOP_PREVIEW_TOP_MARGIN, viewport.height - SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN - frame.height)),
  };
}

export function resizeSessionRemoteDesktopPreviewFrame(input: {
  dx: number;
  edge: "left" | "right";
  frame: SessionRemoteDesktopPreviewFrame;
  mediaAspectRatio: number;
  viewport: SessionRemoteDesktopPreviewViewport;
}) {
  const widthDelta = input.edge === "left" ? -input.dx : input.dx;
  const ratio = normalizeSessionRemoteDesktopPreviewAspectRatio(input.mediaAspectRatio);
  const maxWidth = Math.min(SESSION_REMOTE_DESKTOP_PREVIEW_MAX_WIDTH, input.viewport.width - SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN * 2);
  const width = clamp(input.frame.width + widthDelta, SESSION_REMOTE_DESKTOP_PREVIEW_MIN_WIDTH, maxWidth);
  const height = Math.round(width * ratio) + SESSION_REMOTE_DESKTOP_PREVIEW_FOOTER_HEIGHT;
  const right = input.frame.x + input.frame.width;
  const x = input.edge === "left" ? right - width : input.frame.x;
  return clampSessionRemoteDesktopPreviewFrame({ x, y: input.frame.y, width, height }, input.viewport);
}

export function sessionRemoteDesktopPreviewPreferenceForFrame(input: {
  collapsed: boolean;
  expandedWidth?: number;
  frame: SessionRemoteDesktopPreviewFrame;
  viewport: SessionRemoteDesktopPreviewViewport;
}): SessionRemoteDesktopPreviewPreference {
  const minX = SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN;
  const maxX = Math.max(minX, input.viewport.width - SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN - input.frame.width);
  const minY = SESSION_REMOTE_DESKTOP_PREVIEW_TOP_MARGIN;
  const maxY = Math.max(minY, input.viewport.height - SESSION_REMOTE_DESKTOP_PREVIEW_MARGIN - input.frame.height);
  return {
    collapsed: input.collapsed,
    width: input.expandedWidth ?? (input.collapsed ? SESSION_REMOTE_DESKTOP_PREVIEW_DEFAULT_WIDTH : input.frame.width),
    xRatio: maxX === minX ? 1 : clamp((input.frame.x - minX) / (maxX - minX), 0, 1),
    yRatio: maxY === minY ? 1 : clamp((input.frame.y - minY) / (maxY - minY), 0, 1),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
