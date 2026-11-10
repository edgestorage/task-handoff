import {
  IDENTITY_REMOTE_DESKTOP_TRANSFORM,
  constrainRemoteDesktopTransform,
  remoteDesktopContainRect,
  remoteDesktopMultiTouchIntent,
  remoteDesktopPinchTransform,
  remoteDesktopPointForTouch,
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

test('classifies two-finger movement as scroll or pinch after a small dead zone', () => {
  expect(remoteDesktopMultiTouchIntent({ x: 100, y: 100 }, { x: 102, y: 101 }, 200, 203)).toBe('pending');
  expect(remoteDesktopMultiTouchIntent({ x: 100, y: 100 }, { x: 100, y: 70 }, 200, 204)).toBe('scroll');
  expect(remoteDesktopMultiTouchIntent({ x: 100, y: 100 }, { x: 100, y: 70 }, 200, 214)).toBe('scroll');
  expect(remoteDesktopMultiTouchIntent({ x: 100, y: 100 }, { x: 100, y: 96 }, 200, 240)).toBe('pinch');
});
