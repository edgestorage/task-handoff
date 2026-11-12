import {
  clampFloatingPreviewFrame,
  DEFAULT_FLOATING_PREVIEW_PREFERENCE,
  FLOATING_PREVIEW_COLLAPSED_HEIGHT,
  FLOATING_PREVIEW_COLLAPSED_WIDTH,
  FLOATING_PREVIEW_DEFAULT_WIDTH,
  FLOATING_PREVIEW_MAX_MEDIA_ASPECT_RATIO,
  FLOATING_PREVIEW_MEDIA_ASPECT_RATIO,
  FLOATING_PREVIEW_MIN_MEDIA_ASPECT_RATIO,
  floatingPreviewMediaAspectRatio,
  floatingPreviewHeight,
  floatingPreviewLayout,
  floatingPreviewPreferenceForFrame,
  resizeFloatingPreviewFrame,
  resistedFloatingPreviewDrag,
  type FloatingPreviewViewport,
} from '../src/remote-desktop/floating-preview-layout';

const portrait: FloatingPreviewViewport = {
  height: 844,
  insets: { bottom: 34, left: 0, right: 0 },
  width: 390,
};

const headerPortrait: FloatingPreviewViewport = {
  ...portrait,
  insets: { ...portrait.insets, top: 103 },
};

test('places the default preview at the bottom-right safe edge', () => {
  const { bounds, frame } = floatingPreviewLayout(portrait, DEFAULT_FLOATING_PREVIEW_PREFERENCE);
  expect(frame).toEqual({ height: 189, width: 244, x: 130, y: 529 });
  expect(bounds).toEqual({ maxBottom: 718, maxRight: 374, maxX: 130, maxY: 529, minX: 16, minY: 8 });
  expect(frame.x + frame.width).toBe(bounds.maxRight);
  expect(frame.y + frame.height).toBe(bounds.maxBottom);
});

test('clamps dragged frames and only allows a small resisted overshoot while moving', () => {
  expect(resistedFloatingPreviewDrag(-100, 16, 130)).toBe(4);
  expect(resistedFloatingPreviewDrag(230, 16, 130)).toBe(142);
  expect(clampFloatingPreviewFrame({ height: 189, width: 244, x: -100, y: 1_000 }, portrait)).toEqual({
    height: 189,
    width: 244,
    x: 16,
    y: 529,
  });
});

test('keeps the preview below the session header when dragging or restoring its position', () => {
  expect(floatingPreviewLayout(headerPortrait, DEFAULT_FLOATING_PREVIEW_PREFERENCE).bounds.minY).toBe(111);
  expect(clampFloatingPreviewFrame({ height: 189, width: 244, x: 130, y: 0 }, headerPortrait).y).toBe(111);
  expect(clampFloatingPreviewFrame({ height: FLOATING_PREVIEW_COLLAPSED_HEIGHT, width: FLOATING_PREVIEW_COLLAPSED_WIDTH, x: 178, y: 0 }, headerPortrait).y).toBe(111);
  expect(floatingPreviewLayout(headerPortrait, { ...DEFAULT_FLOATING_PREVIEW_PREFERENCE, xRatio: 0, yRatio: 0 }).frame.y).toBe(111);
});

test('reduces the expanded preview width when the header leaves less vertical room', () => {
  const shortViewport: FloatingPreviewViewport = {
    height: 400,
    insets: { bottom: 0, left: 0, right: 0, top: 160 },
    width: 390,
  };
  const { bounds, frame } = floatingPreviewLayout(shortViewport, DEFAULT_FLOATING_PREVIEW_PREFERENCE);

  expect(frame.width).toBeLessThan(FLOATING_PREVIEW_DEFAULT_WIDTH);
  expect(frame.y).toBe(bounds.minY);
  expect(frame.y + frame.height).toBeLessThanOrEqual(bounds.maxBottom);
});

test('resizes from either vertical edge and moves upward instead of clipping the bottom safe area', () => {
  const start = floatingPreviewLayout(portrait, DEFAULT_FLOATING_PREVIEW_PREFERENCE).frame;
  const wider = resizeFloatingPreviewFrame({ dx: -80, edge: 'left', start, viewport: portrait });
  expect(wider.width).toBe(324);
  expect(wider.x).toBe(50);
  expect(wider.height).toBe(floatingPreviewHeight(wider.width, false));
  expect(wider.y + wider.height).toBe(718);

  const narrower = resizeFloatingPreviewFrame({ dx: -80, edge: 'right', start, viewport: portrait });
  expect(narrower.width).toBe(176);
  expect(narrower.x).toBe(130);

  const largest = resizeFloatingPreviewFrame({ dx: -1_000, edge: 'left', start, viewport: portrait });
  expect(largest.width).toBe(358);
  expect(largest.x).toBe(16);
  expect(largest.y).toBeGreaterThanOrEqual(8);
  expect(largest.y + largest.height).toBeLessThanOrEqual(718);
});

test('collapses to a compact pill and restores the expanded width', () => {
  const expanded = floatingPreviewLayout(portrait, DEFAULT_FLOATING_PREVIEW_PREFERENCE).frame;
  const preference = floatingPreviewPreferenceForFrame({
    collapsed: true,
    expandedWidth: expanded.width,
    frame: expanded,
    viewport: portrait,
  });
  expect(preference).toEqual({
    collapsed: true,
    width: 244,
    xRatio: 1,
    yRatio: 1,
  });
  const collapsed = floatingPreviewLayout(portrait, preference).frame;
  expect(collapsed).toEqual({
    height: FLOATING_PREVIEW_COLLAPSED_HEIGHT,
    width: FLOATING_PREVIEW_COLLAPSED_WIDTH,
    x: 178,
    y: 674,
  });
  expect(floatingPreviewLayout(portrait, { ...preference, collapsed: false }).frame.width).toBe(244);
});

test('fits the expanded preview to the live stream aspect ratio', () => {
  const mediaAspectRatio = floatingPreviewMediaAspectRatio(1_728, 1_117);
  const { bounds, frame } = floatingPreviewLayout(portrait, DEFAULT_FLOATING_PREVIEW_PREFERENCE, mediaAspectRatio);

  expect(frame.width).toBe(244);
  expect(frame.height).toBe(Math.round(244 * mediaAspectRatio) + 52);
  expect(frame.x + frame.width).toBe(bounds.maxRight);
  expect(frame.y + frame.height).toBe(bounds.maxBottom);
});

test('falls back for invalid dimensions and caps extreme aspect ratios so overflow is letterboxed', () => {
  expect(floatingPreviewMediaAspectRatio(0, 100)).toBe(FLOATING_PREVIEW_MEDIA_ASPECT_RATIO);
  expect(floatingPreviewMediaAspectRatio(100, 0)).toBe(FLOATING_PREVIEW_MEDIA_ASPECT_RATIO);
  expect(floatingPreviewMediaAspectRatio(1_000, 1_800)).toBe(1.8);

  const tallAspectRatio = floatingPreviewMediaAspectRatio(100, 1_000);
  const tall = floatingPreviewLayout(portrait, DEFAULT_FLOATING_PREVIEW_PREFERENCE, tallAspectRatio);

  expect(tallAspectRatio).toBe(FLOATING_PREVIEW_MAX_MEDIA_ASPECT_RATIO);
  expect(tall.frame.height).toBe(Math.round(tall.frame.width * FLOATING_PREVIEW_MAX_MEDIA_ASPECT_RATIO) + 52);
  expect(tall.frame.y + tall.frame.height).toBeLessThanOrEqual(tall.bounds.maxBottom);

  const wideAspectRatio = floatingPreviewMediaAspectRatio(1_000, 100);
  const wide = floatingPreviewLayout(portrait, DEFAULT_FLOATING_PREVIEW_PREFERENCE, wideAspectRatio);

  expect(wideAspectRatio).toBe(FLOATING_PREVIEW_MIN_MEDIA_ASPECT_RATIO);
  expect(wide.frame.height).toBe(Math.round(wide.frame.width * FLOATING_PREVIEW_MIN_MEDIA_ASPECT_RATIO) + 52);
  expect(wide.frame.y + wide.frame.height).toBeLessThanOrEqual(wide.bounds.maxBottom);
});

test('resizing keeps the live stream aspect ratio', () => {
  const mediaAspectRatio = 10 / 16;
  const start = floatingPreviewLayout(portrait, DEFAULT_FLOATING_PREVIEW_PREFERENCE, mediaAspectRatio).frame;
  const wider = resizeFloatingPreviewFrame({ dx: -80, edge: 'left', mediaAspectRatio, start, viewport: portrait });

  expect(wider.height).toBe(floatingPreviewHeight(wider.width, false, mediaAspectRatio));
  expect(wider.y + wider.height).toBe(718);
});
