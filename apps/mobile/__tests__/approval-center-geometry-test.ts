import {
  APPROVAL_CENTER_EDGE_VISIBLE_SIZE,
  APPROVAL_CENTER_FAB_SIZE,
  mobileApprovalCenterLayout,
  resolveApprovalCenterDrop,
  resistedApprovalCenterDrag,
} from '../src/approval-center/geometry';

test.each([
  ['ios', 143, 34, 56, 151, 702],
  ['android', 80, 24, 88, 88, 680],
] as const)('%s approval anchor stays below the header and above the native tab bar', (platform, headerHeight, bottomInset, tabOffset, minY, maxY) => {
  const layout = mobileApprovalCenterLayout({
    adaptiveInsets: { left: 0, right: 0 },
    bottomInset,
    contentWidth: 390,
    headerHeight,
    obstructionHeight: 0,
    platform,
    windowHeight: 844,
    windowWidth: 390,
  });
  expect(layout.bounds.minY).toBe(minY);
  expect(layout.bounds.maxY).toBe(maxY);
  expect(layout.fab).toEqual({ x: 330, y: maxY });
  expect(layout.tabBarReserved).toBe(Math.max(bottomInset, 8) + tabOffset);
  expect(layout.panel.width).toBe(358);
});

test('keyboard obstruction moves the bottom boundary without moving the header boundary', () => {
  const unobstructed = mobileApprovalCenterLayout({
    adaptiveInsets: { left: 0, right: 0 },
    bottomInset: 34,
    contentWidth: 390,
    headerHeight: 143,
    obstructionHeight: 0,
    platform: 'ios',
    windowHeight: 844,
    windowWidth: 390,
  });
  const obstructed = mobileApprovalCenterLayout({
    adaptiveInsets: { left: 0, right: 0 },
    bottomInset: 34,
    contentWidth: 390,
    headerHeight: 143,
    obstructionHeight: 320,
    platform: 'ios',
    windowHeight: 844,
    windowWidth: 390,
  });
  expect(obstructed.bounds.minY).toBe(unobstructed.bounds.minY);
  expect(obstructed.bounds.maxY).toBe(unobstructed.bounds.maxY - 320);
  expect(obstructed.panel.maxHeight).toBeLessThan(unobstructed.panel.maxHeight);
});

test('adaptive widths keep the panel and drag bounds inside sidebars and safe areas', () => {
  const layout = mobileApprovalCenterLayout({
    adaptiveInsets: { left: 120, right: 100 },
    bottomInset: 24,
    contentWidth: 840,
    headerHeight: 200,
    obstructionHeight: 0,
    platform: 'ios',
    windowHeight: 1_194,
    windowWidth: 1_060,
  });
  expect(layout.bounds.minX).toBe(136);
  expect(layout.bounds.maxX).toBe(900);
  expect(layout.panel.width).toBe(380);
  expect(layout.panel.right).toBe(116);
  expect(layout.hiddenX).toEqual({ left: 98, right: 938 });
});

test('the panel flips below the entry when there is no room above it', () => {
  const layout = mobileApprovalCenterLayout({
    adaptiveInsets: { left: 0, right: 0 },
    bottomInset: 34,
    contentWidth: 390,
    headerHeight: 143,
    obstructionHeight: 0,
    placement: { dockSide: 'left', verticalRatio: 0, visibility: 'docked' },
    platform: 'ios',
    windowHeight: 844,
    windowWidth: 390,
  });
  expect(layout.fab).toEqual({ x: 16, y: 151 });
  expect(layout.panelPlacement).toBe('below');
  expect(layout.panel.top).toBe(205);
  expect(layout.panel.left).toBe(16);
});

test('edge-hidden entries expose only the configured sliver on either side', () => {
  for (const dockSide of ['left', 'right'] as const) {
    const layout = mobileApprovalCenterLayout({
      adaptiveInsets: { left: 0, right: 0 },
      bottomInset: 34,
      contentWidth: 390,
      headerHeight: 143,
      obstructionHeight: 0,
      placement: { dockSide, verticalRatio: 1, visibility: 'edge-hidden' },
      platform: 'ios',
      windowHeight: 844,
      windowWidth: 390,
    });
    expect(layout.fab.x).toBe(layout.hiddenX[dockSide]);
    const visibleWidth = Math.min(390, layout.fab.x + APPROVAL_CENTER_FAB_SIZE) - Math.max(0, layout.fab.x);
    expect(visibleWidth).toBe(APPROVAL_CENTER_EDGE_VISIBLE_SIZE);
  }
});

test('drop resolution snaps within bounds and hides only on overscroll or outward fling', () => {
  const bounds = { maxX: 330, maxY: 702, minX: 16, minY: 151 };
  expect(resolveApprovalCenterDrop({ bounds, velocityX: 0, x: 180, y: -100 })).toEqual({
    dockSide: 'right',
    verticalRatio: 0,
    visibility: 'docked',
  });
  expect(resolveApprovalCenterDrop({ bounds, velocityX: 0, x: 340, y: 400 })).toMatchObject({
    dockSide: 'right',
    visibility: 'docked',
  });
  expect(resolveApprovalCenterDrop({ bounds, velocityX: 0, x: -20, y: 400 })).toMatchObject({
    dockSide: 'left',
    visibility: 'edge-hidden',
  });
  expect(resolveApprovalCenterDrop({ bounds, velocityX: 1.2, x: 325, y: 900 })).toMatchObject({
    dockSide: 'right',
    verticalRatio: 1,
    visibility: 'edge-hidden',
  });
  expect(resolveApprovalCenterDrop({ bounds, velocityX: 0.4, x: 330, y: 400 })).toMatchObject({
    dockSide: 'right',
    visibility: 'docked',
  });
  expect(resolveApprovalCenterDrop({ bounds, velocityX: 0.9, x: 330, y: 400 })).toMatchObject({
    dockSide: 'right',
    visibility: 'edge-hidden',
  });
  expect(resolveApprovalCenterDrop({ bounds, velocityX: -0.9, x: 16, y: 400 })).toMatchObject({
    dockSide: 'left',
    visibility: 'edge-hidden',
  });
});

test('an edge-hidden entry returns to a docked placement when dragged inward', () => {
  const bounds = { maxX: 330, maxY: 702, minX: 16, minY: 151 };
  expect(resolveApprovalCenterDrop({ bounds, velocityX: 0, x: 38, y: 400 })).toEqual({
    dockSide: 'left',
    verticalRatio: (400 - 151) / (702 - 151),
    visibility: 'docked',
  });
});

test('landscape safe areas and the native tab bar reduce the usable drag bounds', () => {
  const layout = mobileApprovalCenterLayout({
    adaptiveInsets: { left: 47, right: 47 },
    bottomInset: 21,
    contentWidth: 750,
    headerHeight: 56,
    obstructionHeight: 0,
    platform: 'ios',
    windowHeight: 390,
    windowWidth: 844,
  });
  expect(layout.bounds).toEqual({ maxX: 737, maxY: 261, minX: 63, minY: 64 });
  expect(layout.hiddenX).toEqual({ left: 25, right: 775 });
  for (const dockSide of ['left', 'right'] as const) {
    const hidden = mobileApprovalCenterLayout({
      adaptiveInsets: { left: 47, right: 47 },
      bottomInset: 21,
      contentWidth: 750,
      headerHeight: 56,
      obstructionHeight: 0,
      placement: { dockSide, verticalRatio: 0.5, visibility: 'edge-hidden' },
      platform: 'ios',
      windowHeight: 390,
      windowWidth: 844,
    });
    const visibleWidth = Math.min(844 - 47, hidden.fab.x + APPROVAL_CENTER_FAB_SIZE) - Math.max(47, hidden.fab.x);
    expect(visibleWidth).toBe(APPROVAL_CENTER_EDGE_VISIBLE_SIZE);
  }
});

test('drag resistance caps visual overscroll', () => {
  expect(resistedApprovalCenterDrag(-100, 16, 330)).toBe(4);
  expect(resistedApprovalCenterDrag(430, 16, 330)).toBe(342);
  expect(resistedApprovalCenterDrag(180, 16, 330)).toBe(180);
});
