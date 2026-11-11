import {
  IDENTITY_REMOTE_DESKTOP_TRANSFORM,
  REMOTE_DESKTOP_MIN_VISIBLE_EDGE,
  constrainRemoteDesktopTransform,
  remoteDesktopContainRect,
  remoteDesktopMultiTouchIntent,
  remoteDesktopPinchTransform,
  remoteDesktopPointForTouch,
  remoteDesktopScrollAnchor,
  remoteDesktopTouchOrientation,
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
  expect(remoteDesktopMultiTouchIntent({ x: 100, y: 100 }, { x: 102, y: 101 }, 200, 203)).toBe('pending');
  expect(remoteDesktopMultiTouchIntent({ x: 100, y: 100 }, { x: 100, y: 70 }, 200, 204)).toBe('scroll');
  expect(remoteDesktopMultiTouchIntent({ x: 100, y: 100 }, { x: 100, y: 70 }, 200, 214)).toBe('scroll');
  expect(remoteDesktopMultiTouchIntent({ x: 100, y: 100 }, { x: 100, y: 96 }, 200, 240)).toBe('pinch');
});

test('only classifies a horizontally aligned two-finger gesture as scroll', () => {
  const horizontalStart = { x: 100, y: 100 };
  const horizontalSecond = { x: 200, y: 104 };
  const verticalSecond = { x: 104, y: 200 };
  expect(remoteDesktopTouchOrientation(horizontalStart, horizontalSecond)).toBe('horizontal');
  expect(remoteDesktopTouchOrientation(horizontalStart, verticalSecond)).toBe('vertical');
  expect(remoteDesktopMultiTouchIntent({ x: 150, y: 102 }, { x: 150, y: 72 }, 100, 104, 'horizontal')).toBe('scroll');
  expect(remoteDesktopMultiTouchIntent({ x: 102, y: 150 }, { x: 102, y: 120 }, 100, 104, 'vertical')).toBe('pending');
});

test('keeps the wheel anchor fixed at the virtual cursor or last direct pointer', () => {
  const cursor = { x: 0.25, y: 0.75 };
  const pointer = { x: 0.8, y: 0.2 };
  expect(remoteDesktopScrollAnchor('trackpad', cursor, pointer)).toEqual(cursor);
  expect(remoteDesktopScrollAnchor('direct', cursor, pointer)).toEqual(pointer);
  expect(remoteDesktopScrollAnchor('direct', cursor)).toEqual(cursor);
});
