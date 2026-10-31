import { mobileApprovalCenterLayout } from '../src/approval-center/geometry';

test.each([
  ['ios', 390, 34, 56],
  ['android', 390, 24, 88],
] as const)('%s approval anchor stays above the native tab bar and safe area', (platform, width, bottomInset, tabOffset) => {
  const layout = mobileApprovalCenterLayout({
    adaptiveInsets: { left: 0, right: 0 },
    bottomInset,
    contentWidth: width,
    obstructionHeight: 0,
    platform,
    windowHeight: 844,
  });
  expect(layout.bottom).toBe(Math.max(bottomInset, 8) + tabOffset);
  expect(layout.right).toBe(16);
  expect(layout.panelWidth).toBe(358);
});

test('keyboard and composer obstruction moves the anchor and shrinks only the panel', () => {
  const unobstructed = mobileApprovalCenterLayout({
    adaptiveInsets: { left: 0, right: 0 },
    bottomInset: 34,
    contentWidth: 390,
    obstructionHeight: 0,
    platform: 'ios',
    windowHeight: 844,
  });
  const obstructed = mobileApprovalCenterLayout({
    adaptiveInsets: { left: 0, right: 0 },
    bottomInset: 34,
    contentWidth: 390,
    obstructionHeight: 320,
    platform: 'ios',
    windowHeight: 844,
  });
  expect(obstructed.bottom - unobstructed.bottom).toBe(320);
  expect(obstructed.panelMaxHeight).toBeLessThan(unobstructed.panelMaxHeight);
});

test('adaptive widths keep the panel inside sidebars and safe areas', () => {
  const layout = mobileApprovalCenterLayout({
    adaptiveInsets: { left: 120, right: 100 },
    bottomInset: 24,
    contentWidth: 840,
    obstructionHeight: 0,
    platform: 'ios',
    windowHeight: 1_194,
  });
  expect(layout.right).toBe(116);
  expect(layout.panelWidth).toBe(380);
});
