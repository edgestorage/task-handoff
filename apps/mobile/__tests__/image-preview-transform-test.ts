import { constrainImagePreview, fitImagePreview, pinchImagePreview } from '../src/ai-sessions/image-preview-transform';

test.each([
  [{ width: 1600, height: 800 }, { width: 400, height: 200 }],
  [{ width: 800, height: 1600 }, { width: 300, height: 600 }],
])('fits an image without changing its aspect ratio', (source, expected) => {
  expect(fitImagePreview(source, { width: 400, height: 600 })).toEqual(expected);
});

test.each([1, 2, 3])('keeps a dragged image reachable at scale %s, including narrow images', (scale) => {
  const viewport = { width: 400, height: 600 };
  const image = { width: 20, height: 600 };
  const transform = constrainImagePreview({ scale, x: 100_000, y: -100_000 }, image, viewport);
  const overlapX = viewport.width / 2 - (transform.x - image.width * scale / 2);
  const overlapY = viewport.height / 2 + transform.y + image.height * scale / 2;
  expect(overlapX).toBeGreaterThanOrEqual(Math.min(48, image.width * scale));
  expect(overlapY).toBeGreaterThanOrEqual(48);
});

test('moving fingers at the zoom limit preserves the touched image point', () => {
  const start = { scale: 2, x: 30, y: 50 };
  const origin = { x: 40, y: 60 };
  const focal = { x: 70, y: 80 };
  const result = pinchImagePreview(start, 10, origin, focal);
  expect(result.scale).toBe(3);
  expect((focal.x - result.x) / result.scale).toBe((origin.x - start.x) / start.scale);
  expect((focal.y - result.y) / result.scale).toBe((origin.y - start.y) / start.scale);
});

test('inverse pinches restore the original transform without cumulative drift', () => {
  const start = { scale: 1.5, x: 25, y: -40 };
  const focal = { x: 35, y: -10 };
  const enlarged = pinchImagePreview(start, 2, focal, focal);
  expect(pinchImagePreview(enlarged, 0.5, focal, focal)).toEqual(start);
});
