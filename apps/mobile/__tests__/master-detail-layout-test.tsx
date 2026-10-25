import { act, fireEvent, render } from '@testing-library/react-native';
import { useEffect, useState } from 'react';
import { Dimensions, Pressable, StyleSheet, Text } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import {
  MASTER_DETAIL_MIN_WIDTH,
  MasterDetailLayout,
  masterDetailMetrics,
} from '../src/components/MasterDetailLayout';
import { useAdaptiveContentLayout } from '../src/components/adaptive-layout';

const initialWindowMetrics = Dimensions.get('window');
const initialScreenMetrics = Dimensions.get('screen');

function setViewportWidth(width: number) {
  Dimensions.set({
    screen: { ...initialScreenMetrics, width },
    window: { ...initialWindowMetrics, width },
  });
}

function restoreViewport() {
  Dimensions.set({ screen: initialScreenMetrics, window: initialWindowMetrics });
}

afterEach(restoreViewport);

describe('master-detail metrics', () => {
  test.each([
    { detailWidth: 382, href: 'Duo cover compact', listWidth: 382, safeRight: 84, width: 466, wide: false },
    { detailWidth: 390, href: 'phone', listWidth: 390, safeRight: 0, width: 390, wide: false },
    { detailWidth: MASTER_DETAIL_MIN_WIDTH - 1, href: 'below threshold', listWidth: MASTER_DETAIL_MIN_WIDTH - 1, safeRight: 0, width: MASTER_DETAIL_MIN_WIDTH - 1, wide: false },
  ])('keeps $href single-column', ({ detailWidth, listWidth, safeRight, width, wide }) => {
    expect(masterDetailMetrics(width, { right: safeRight })).toMatchObject({ detailWidth, listWidth, wide });
  });

  test.each([
    { right: 0, width: 720 },
    { right: 84, width: 951 },
    { right: 0, width: 1032 },
    { right: 24, width: 1280 },
  ])('splits a $widthpt viewport with $rightpt right inset', ({ right, width }) => {
    const metrics = masterDetailMetrics(width, { right });
    expect(metrics.wide).toBe(true);
    expect(metrics.listWidth).toBeGreaterThanOrEqual(300);
    expect(metrics.detailWidth).toBeGreaterThanOrEqual(420 - StyleSheet.hairlineWidth);
    expect(metrics.listWidth + metrics.detailWidth + StyleSheet.hairlineWidth).toBeCloseTo(metrics.availableWidth);
  });
});

function LayoutProbe() {
  const layout = useAdaptiveContentLayout();
  return <Text testID="layout-probe">{JSON.stringify(layout)}</Text>;
}

test('scopes adaptive content to the list pane and applies a side safe area once', async () => {
  await act(async () => { setViewportWidth(951); });
  const screen = await render(
    <SafeAreaInsetsContext.Provider value={{ bottom: 0, left: 0, right: 84, top: 0 }}>
      <MasterDetailLayout detail={<Text>Detail</Text>} list={<LayoutProbe />} />
    </SafeAreaInsetsContext.Provider>,
  );

  expect(StyleSheet.flatten(screen.getByTestId('master-detail-layout').props.style)).toMatchObject({
    flexDirection: 'row',
    paddingLeft: 0,
    paddingRight: 84,
  });
  expect(StyleSheet.flatten(screen.getByTestId('master-detail-layout-list').props.style)).toMatchObject({ width: 312 });
  expect(JSON.parse(screen.getByTestId('layout-probe').props.children)).toMatchObject({
    contentInsets: { left: 0, right: 0 },
    regular: false,
  });
  expect(screen.getByText('Detail')).toBeTruthy();
});

test('does not mount the detail pane in compact mode', async () => {
  await act(async () => { setViewportWidth(390); });
  const screen = await render(
    <MasterDetailLayout detail={<Text>Detail</Text>} list={<Text>List</Text>} />,
  );

  expect(screen.getByText('List')).toBeTruthy();
  expect(screen.queryByText('Detail')).toBeNull();
  expect(screen.queryByTestId('master-detail-layout-detail')).toBeNull();
});

test('keeps the wide split root in the native hierarchy', async () => {
  await act(async () => { setViewportWidth(1032); });
  const screen = await render(<MasterDetailLayout detail={<Text>Detail</Text>} list={<Text>List</Text>} />);

  expect(screen.getByTestId('master-detail-layout').props.collapsable).toBe(false);
});

test('keeps the list mounted and its local state intact across a breakpoint resize', async () => {
  let mountCount = 0;
  function StableList() {
    const [count, setCount] = useState(0);
    useEffect(() => { mountCount += 1; }, []);
    return <Pressable onPress={() => setCount((current) => current + 1)}><Text>{`count:${count}`}</Text></Pressable>;
  }

  await act(async () => { setViewportWidth(390); });
  const screen = await render(<MasterDetailLayout detail={<Text>Detail</Text>} list={<StableList />} />);
  fireEvent.press(screen.getByText('count:0'));
  await act(async () => { setViewportWidth(1032); });

  expect(screen.getByText('count:1')).toBeTruthy();
  expect(screen.getByText('Detail')).toBeTruthy();
  expect(mountCount).toBe(1);
});
