import {
  IDENTITY_REMOTE_DESKTOP_TRANSFORM,
  REMOTE_DESKTOP_PAN_FULL_ZOOM,
  REMOTE_DESKTOP_MIN_VISIBLE_EDGE,
  REMOTE_DESKTOP_TRACKPAD_EDGE_INSET,
  constrainRemoteDesktopTransform,
  keepRemoteDesktopCursorVisible,
  remoteDesktopContainRect,
  remoteDesktopMultiTouchIntent,
  remoteDesktopMultiTouchInTapDeadZone,
  remoteDesktopPinchTransform,
  remoteDesktopPointForTouch,
  remoteDesktopScrollAnchor,
  remoteDesktopTrackpadMove,
  type RemoteDesktopPoint,
  type RemoteDesktopSize,
  type RemoteDesktopTransform,
} from '../src/remote-desktop/geometry';

const viewport = { width: 1_000, height: 1_000 };
const content = { width: 1_920, height: 1_080 };

test('maps only the visible contain rectangle and ignores letterbox touches', () => {
  const rect = remoteDesktopContainRect(viewport, content);
  expect(rect.x).toBeCloseTo(0, 8);
  expect(rect.y).toBeCloseTo(218.75, 8);
  expect(rect.width).toBeCloseTo(1_000, 8);
  expect(rect.height).toBeCloseTo(562.5, 8);
  expect(remoteDesktopPointForTouch({ x: 500, y: 500 }, viewport, content)).toEqual({ x: 0.5, y: 0.5 });
  expect(remoteDesktopPointForTouch({ x: 500, y: 100 }, viewport, content)).toBeUndefined();
  expect(remoteDesktopPointForTouch({ x: 500, y: 100 }, viewport, content, IDENTITY_REMOTE_DESKTOP_TRANSFORM, true)).toEqual({ x: 0.5, y: 0 });
  expect(remoteDesktopPointForTouch({ x: 1_100, y: 500 }, viewport, content, IDENTITY_REMOTE_DESKTOP_TRANSFORM, true)).toEqual({ x: 1, y: 0.5 });
});

test('zoomed touch mapping follows the rendered content frame', () => {
  const transform = { scale: 2, translateX: 100, translateY: -40 };
  const point = remoteDesktopPointForTouch({ x: 600, y: 460 }, viewport, content, transform);
  expect(point?.x).toBeCloseTo(0.5, 8);
  expect(point?.y).toBeCloseTo(0.5, 8);
});

test('pinch zoom stays anchored to the source point and clamps to the viewport', () => {
  const zoomed = remoteDesktopPinchTransform(
    IDENTITY_REMOTE_DESKTOP_TRANSFORM,
    { x: 500, y: 500 },
    { x: 650, y: 520 },
    200,
    400,
    viewport,
    content,
  );
  expect(zoomed.scale).toBe(2);
  expect(zoomed.translateX).toBe(150);
  expect(zoomed.translateY).toBe(20);
  expect(constrainRemoteDesktopTransform({ scale: 4, translateX: 10_000, translateY: -10_000 }, viewport, remoteDesktopContainRect(viewport, content)).scale).toBe(4);
});

function frameBounds(viewport: { width: number; height: number }, rect: { x: number; y: number; width: number; height: number }, transform: { scale: number; translateX: number; translateY: number }) {
  return {
    bottom: viewport.height / 2 + transform.translateY + rect.height * transform.scale / 2,
    left: viewport.width / 2 + transform.translateX - rect.width * transform.scale / 2,
    right: viewport.width / 2 + transform.translateX + rect.width * transform.scale / 2,
    top: viewport.height / 2 + transform.translateY - rect.height * transform.scale / 2,
  };
}

function cursorViewPoint(
  cursor: RemoteDesktopPoint,
  transform: RemoteDesktopTransform,
  viewportSize: RemoteDesktopSize,
  contentSize: RemoteDesktopSize,
) {
  const rect = remoteDesktopContainRect(viewportSize, contentSize);
  return {
    x: viewportSize.width / 2 + transform.translateX + (cursor.x - 0.5) * rect.width * transform.scale,
    y: viewportSize.height / 2 + transform.translateY + (cursor.y - 0.5) * rect.height * transform.scale,
  };
}

test('zoomed content may leave the viewport while keeping one visible edge', () => {
  const portrait = { width: 390, height: 844 };
  const rect = remoteDesktopContainRect(portrait, content);
  const down = constrainRemoteDesktopTransform({ scale: 2, translateX: 0, translateY: 10_000 }, portrait, rect);
  const up = constrainRemoteDesktopTransform({ scale: 2, translateX: 0, translateY: -10_000 }, portrait, rect);
  const right = constrainRemoteDesktopTransform({ scale: 2, translateX: 10_000, translateY: 0 }, portrait, rect);
  const left = constrainRemoteDesktopTransform({ scale: 2, translateX: -10_000, translateY: 0 }, portrait, rect);
  expect(frameBounds(portrait, rect, down).top).toBeCloseTo(portrait.height - REMOTE_DESKTOP_MIN_VISIBLE_EDGE, 8);
  expect(frameBounds(portrait, rect, up).bottom).toBeCloseTo(REMOTE_DESKTOP_MIN_VISIBLE_EDGE, 8);
  expect(frameBounds(portrait, rect, right).left).toBeCloseTo(portrait.width - REMOTE_DESKTOP_MIN_VISIBLE_EDGE, 8);
  expect(frameBounds(portrait, rect, left).right).toBeCloseTo(REMOTE_DESKTOP_MIN_VISIBLE_EDGE, 8);
});

test('covering zoom retains the same edge-overlap movement range', () => {
  const portrait = { width: 390, height: 844 };
  const rect = remoteDesktopContainRect(portrait, content);
  const top = constrainRemoteDesktopTransform({ scale: 4, translateX: 0, translateY: 10_000 }, portrait, rect);
  const bottom = constrainRemoteDesktopTransform({ scale: 4, translateX: 0, translateY: -10_000 }, portrait, rect);
  expect(frameBounds(portrait, rect, top).top).toBeCloseTo(portrait.height - REMOTE_DESKTOP_MIN_VISIBLE_EDGE, 8);
  expect(frameBounds(portrait, rect, bottom).bottom).toBeCloseTo(REMOTE_DESKTOP_MIN_VISIBLE_EDGE, 8);
});

test('pan range opens linearly from center through 1.3x zoom', () => {
  const portrait = { width: 390, height: 844 };
  const rect = remoteDesktopContainRect(portrait, content);
  const panToLimit = (scale: number) => constrainRemoteDesktopTransform(
    { scale, translateX: 10_000, translateY: 10_000 },
    portrait,
    rect,
  );
  const expectedLinearLimit = (scale: number, axis: 'x' | 'y') => {
    const progress = (scale - 1) / (REMOTE_DESKTOP_PAN_FULL_ZOOM - 1);
    const viewportSize = axis === 'x' ? portrait.width : portrait.height;
    const rectStart = axis === 'x' ? rect.x : rect.y;
    const rectSize = axis === 'x' ? rect.width : rect.height;
    const left = viewportSize / 2 + scale * (rectStart - viewportSize / 2);
    const fullLimit = viewportSize - REMOTE_DESKTOP_MIN_VISIBLE_EDGE - left;
    return fullLimit * progress;
  };

  const minimum = panToLimit(1);
  const nearlyMinimum = panToLimit(1.0001);
  const slightlyZoomed = panToLimit(1.01);
  const halfOpen = panToLimit(1.15);
  const fullyOpen = panToLimit(REMOTE_DESKTOP_PAN_FULL_ZOOM);

  expect(REMOTE_DESKTOP_PAN_FULL_ZOOM).toBe(1.3);
  expect(minimum.translateX).toBeCloseTo(0, 8);
  expect(minimum.translateY).toBeCloseTo(0, 8);
  expect(Math.abs(nearlyMinimum.translateY - minimum.translateY)).toBeLessThan(1);
  expect(slightlyZoomed.translateX).toBeCloseTo(expectedLinearLimit(1.01, 'x'), 8);
  expect(slightlyZoomed.translateY).toBeCloseTo(expectedLinearLimit(1.01, 'y'), 8);
  expect(halfOpen.translateX).toBeCloseTo(expectedLinearLimit(1.15, 'x'), 8);
  expect(halfOpen.translateY).toBeCloseTo(expectedLinearLimit(1.15, 'y'), 8);
  expect(frameBounds(portrait, rect, fullyOpen).top).toBeCloseTo(portrait.height - REMOTE_DESKTOP_MIN_VISIBLE_EDGE, 8);
});

test('phone-sized window streaming keeps a practical 3x vertical pan range', () => {
  const phone = { width: 393, height: 755 };
  const windowContent = { width: 724, height: 472 };
  const rect = remoteDesktopContainRect(phone, windowContent);
  const top = constrainRemoteDesktopTransform({ scale: 3, translateX: 0, translateY: 10_000 }, phone, rect);
  const bottom = constrainRemoteDesktopTransform({ scale: 3, translateX: 0, translateY: -10_000 }, phone, rect);
  expect(frameBounds(phone, rect, top).top).toBeCloseTo(phone.height - REMOTE_DESKTOP_MIN_VISIBLE_EDGE, 8);
  expect(frameBounds(phone, rect, bottom).bottom).toBeCloseTo(REMOTE_DESKTOP_MIN_VISIBLE_EDGE, 8);
});

test('classifies two-finger movement as scroll or pinch after a small dead zone', () => {
  const startFirst = { x: 100, y: 100 };
  const startSecond = { x: 200, y: 100 };
  expect(remoteDesktopMultiTouchIntent(
    startFirst,
    startSecond,
    { x: 102, y: 101 },
    { x: 202, y: 101 },
  )).toBe('pending');
  expect(remoteDesktopMultiTouchIntent(
    startFirst,
    startSecond,
    { x: 100, y: 70 },
    { x: 200, y: 70 },
  )).toBe('scroll');
  expect(remoteDesktopMultiTouchIntent(
    startFirst,
    startSecond,
    { x: 90, y: 100 },
    { x: 210, y: 100 },
  )).toBe('pinch');
});

test('scrolls only when both fingers move in the same direction', () => {
  expect(remoteDesktopMultiTouchIntent(
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 100, y: 70 },
    { x: 200, y: 70 },
  )).toBe('scroll');
  expect(remoteDesktopMultiTouchIntent(
    { x: 100, y: 100 },
    { x: 100, y: 200 },
    { x: 100, y: 70 },
    { x: 100, y: 170 },
  )).toBe('scroll');
  expect(remoteDesktopMultiTouchIntent(
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 100, y: 70 },
    { x: 200, y: 130 },
  )).toBe('pinch');
});

test('a pinch remains a pinch while both fingers also pan', () => {
  expect(remoteDesktopMultiTouchIntent(
    { x: 100, y: 200 },
    { x: 200, y: 200 },
    { x: 85, y: 160 },
    { x: 225, y: 160 },
  )).toBe('pinch');
});

test('a pinch with one nearly stationary finger still becomes pinch', () => {
  expect(remoteDesktopMultiTouchIntent(
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 100, y: 100 },
    { x: 230, y: 100 },
  )).toBe('pinch');
});

test('minor separation drift does not turn a two-finger scroll into pinch', () => {
  expect(remoteDesktopMultiTouchIntent(
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 102, y: 70 },
    { x: 198, y: 70 },
  )).toBe('scroll');
});

test('small two-finger drift remains eligible for a tap', () => {
  const start = { x: 100, y: 100 };
  const moved = { x: 104, y: 103 };
  expect(remoteDesktopMultiTouchInTapDeadZone(start, moved, 80, 86)).toBe(true);
  expect(remoteDesktopMultiTouchInTapDeadZone(start, moved, 80, 90)).toBe(false);
});

test('keeps the wheel anchor fixed at the virtual cursor or last direct pointer', () => {
  const cursor = { x: 0.25, y: 0.75 };
  const pointer = { x: 0.8, y: 0.2 };
  expect(remoteDesktopScrollAnchor('trackpad', cursor, pointer)).toEqual(cursor);
  expect(remoteDesktopScrollAnchor('direct', cursor, pointer)).toEqual(pointer);
  expect(remoteDesktopScrollAnchor('direct', cursor)).toEqual(cursor);
});

test('trackpad movement only moves the cursor before zooming', () => {
  const moved = remoteDesktopTrackpadMove(
    { x: 0.5, y: 0.5 },
    { x: 0.1, y: -0.2 },
    IDENTITY_REMOTE_DESKTOP_TRANSFORM,
    viewport,
    content,
  );
  expect(moved.cursor.x).toBeCloseTo(0.6, 8);
  expect(moved.cursor.y).toBeCloseTo(0.3, 8);
  expect(moved.transform).toEqual(IDENTITY_REMOTE_DESKTOP_TRANSFORM);
});

test('trackpad movement pans zoomed content while pinning the cursor at the edge', () => {
  const start = remoteDesktopTrackpadMove(
    { x: 0.7, y: 0.5 },
    { x: 0.1, y: 0 },
    { scale: 2, translateX: 0, translateY: 0 },
    viewport,
    content,
  );
  expect(start.cursor.x).toBeCloseTo(0.8, 8);
  expect(start.transform.translateX).toBeCloseTo(-120, 8);
  expect(cursorViewPoint(start.cursor, start.transform, viewport, content).x)
    .toBeCloseTo(viewport.width - REMOTE_DESKTOP_TRACKPAD_EDGE_INSET, 8);

  const continued = remoteDesktopTrackpadMove(
    start.cursor,
    { x: 0.1, y: 0 },
    start.transform,
    viewport,
    content,
  );
  expect(continued.cursor.x).toBeCloseTo(0.9, 8);
  expect(continued.transform.translateX).toBeCloseTo(-320, 8);
  expect(cursorViewPoint(continued.cursor, continued.transform, viewport, content).x)
    .toBeCloseTo(viewport.width - REMOTE_DESKTOP_TRACKPAD_EDGE_INSET, 8);
});

test('pinch panning keeps the virtual cursor inside the viewport', () => {
  const nextTransform = remoteDesktopPinchTransform(
    IDENTITY_REMOTE_DESKTOP_TRANSFORM,
    { x: 250, y: 250 },
    { x: 750, y: 250 },
    200,
    400,
    viewport,
    content,
  );
  const nextCursor = keepRemoteDesktopCursorVisible({ x: 0.5, y: 0.5 }, nextTransform, viewport, content);
  const cursorView = cursorViewPoint(nextCursor, nextTransform, viewport, content);
  expect(cursorView.x).toBeCloseTo(viewport.width - REMOTE_DESKTOP_TRACKPAD_EDGE_INSET, 8);
  expect(cursorView.y).toBeGreaterThanOrEqual(REMOTE_DESKTOP_TRACKPAD_EDGE_INSET);
  expect(cursorView.y).toBeLessThanOrEqual(viewport.height - REMOTE_DESKTOP_TRACKPAD_EDGE_INSET);
});

test('cursor stays visible after panning the content to a transform boundary', () => {
  const rect = remoteDesktopContainRect(viewport, content);
  const transform = constrainRemoteDesktopTransform(
    { scale: 2, translateX: 10_000, translateY: -10_000 },
    viewport,
    rect,
  );
  const cursor = keepRemoteDesktopCursorVisible({ x: 0.5, y: 0.5 }, transform, viewport, content);
  const cursorView = cursorViewPoint(cursor, transform, viewport, content);
  expect(cursorView.x).toBeGreaterThanOrEqual(REMOTE_DESKTOP_TRACKPAD_EDGE_INSET);
  expect(cursorView.x).toBeLessThanOrEqual(viewport.width - REMOTE_DESKTOP_TRACKPAD_EDGE_INSET);
  expect(cursorView.y).toBeGreaterThanOrEqual(REMOTE_DESKTOP_TRACKPAD_EDGE_INSET);
  expect(cursorView.y).toBeLessThanOrEqual(viewport.height - REMOTE_DESKTOP_TRACKPAD_EDGE_INSET);
});
