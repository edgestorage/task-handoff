import { act, render } from '@testing-library/react-native';
import { Dimensions, StyleSheet, Text, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { ADAPTIVE_READING_MAX_WIDTH, useAdaptiveContentLayout } from '../src/components/adaptive-layout';
import { Screen } from '../src/components/Screen';
import { ScreenFlatList } from '../src/components/ScreenFlatList';
import { SwipeActionList } from '../src/components/SwipeActionList';

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

function AdaptiveProbe({ maxWidth }: { maxWidth: number }) {
  const layout = useAdaptiveContentLayout(maxWidth);
  return <View accessibilityLabel={JSON.stringify(layout)} style={layout.contentStyle} testID="adaptive-probe" />;
}

test.each([
  { contentWidth: 382, indicator: undefined, left: 0, regular: false, right: 84, width: 466 },
  { contentWidth: 780, indicator: { bottom: 0, left: 43.5, right: 43.5, top: 0 }, left: 43.5, regular: true, right: 127.5, width: 951 },
])('reads the $width point viewport through the safe-area hook', async ({ contentWidth, indicator, left, regular, right, width }) => {
  await act(async () => { setViewportWidth(width); });
  const screen = await render(
    <SafeAreaInsetsContext.Provider value={{ bottom: 0, left: 0, right: 84, top: 0 }}>
      <AdaptiveProbe maxWidth={ADAPTIVE_READING_MAX_WIDTH} />
    </SafeAreaInsetsContext.Provider>,
  );

  try {
    const layout = JSON.parse(screen.getByTestId('adaptive-probe').props.accessibilityLabel);
    expect(layout).toEqual({
      contentInsets: { left, right },
      contentStyle: { marginLeft: left, marginRight: right },
      contentWidth,
      regular,
      scrollIndicatorInsets: indicator,
    });
    expect(StyleSheet.flatten(screen.getByTestId('adaptive-probe').props.style)).toEqual({
      marginLeft: left,
      marginRight: right,
    });
  } finally {
    await screen.unmount();
    await act(async () => { restoreViewport(); });
  }
});

test.each([
  { indicator: undefined, left: 0, maxContentWidth: undefined, right: 84, width: 466 },
  { indicator: { bottom: 0, left: 43.5, right: 43.5, top: 0 }, left: 43.5, maxContentWidth: ADAPTIVE_READING_MAX_WIDTH, right: 127.5, width: 951 },
])('puts Screen side insets on the viewport at $width points', async ({ indicator, left, maxContentWidth, right, width }) => {
  await act(async () => { setViewportWidth(width); });
  const screen = await render(
    <SafeAreaInsetsContext.Provider value={{ bottom: 0, left: 0, right: 84, top: 0 }}>
      <Screen contentContainerStyle={{ paddingTop: 7 }} maxContentWidth={maxContentWidth} testID="screen-scroll">
        <Text>Screen content</Text>
      </Screen>
    </SafeAreaInsetsContext.Provider>,
  );

  try {
    const viewportStyle = StyleSheet.flatten(screen.getByTestId('screen-scroll').props.style);
    const contentStyle = StyleSheet.flatten(screen.getByTestId('screen-scroll').props.contentContainerStyle);
    expect(viewportStyle).toEqual(expect.objectContaining({ flex: 1 }));
    expect(viewportStyle.marginLeft).toBeUndefined();
    expect(viewportStyle.marginRight).toBeUndefined();
    expect(contentStyle).toEqual(expect.objectContaining({
      paddingHorizontal: 16,
      paddingLeft: left + 16,
      paddingRight: right + 16,
      paddingTop: 7,
    }));
    expect(screen.getByTestId('screen-scroll').props.scrollIndicatorInsets).toEqual(indicator);
  } finally {
    await screen.unmount();
    await act(async () => { restoreViewport(); });
  }
});

test.each([
  { indicator: undefined, left: 0, right: 84, width: 466 },
  { indicator: { bottom: 0, left: 13.5, right: 13.5, top: 0 }, left: 13.5, right: 97.5, width: 951 },
])('puts ScreenFlatList side insets on the viewport at $width points', async ({ indicator, left, right, width }) => {
  await act(async () => { setViewportWidth(width); });
  const screen = await render(
    <SafeAreaInsetsContext.Provider value={{ bottom: 0, left: 0, right: 84, top: 0 }}>
      <ScreenFlatList
        data={['entry']}
        renderItem={({ item }) => <Text>{item}</Text>}
        style={{ backgroundColor: '#123456' }}
        testID="screen-flat-list"
      />
    </SafeAreaInsetsContext.Provider>,
  );

  try {
    const viewportStyle = StyleSheet.flatten(screen.getByTestId('screen-flat-list').props.style);
    const contentStyle = StyleSheet.flatten(screen.getByTestId('screen-flat-list').props.contentContainerStyle);
    expect(viewportStyle).toEqual({ backgroundColor: '#123456' });
    expect(contentStyle).toEqual({ paddingLeft: left, paddingRight: right });
    expect(screen.getByTestId('screen-flat-list').props.scrollIndicatorInsets).toEqual(indicator);
  } finally {
    await screen.unmount();
    await act(async () => { restoreViewport(); });
  }
});

test.each([
  { indicator: undefined, left: 0, right: 84, width: 466 },
  { indicator: { bottom: 0, left: 13.5, right: 13.5, top: 0 }, left: 13.5, right: 97.5, width: 951 },
])('puts SwipeActionList side insets on the viewport at $width points', async ({ indicator, left, right, width }) => {
  await act(async () => { setViewportWidth(width); });
  const screen = await render(
    <SafeAreaInsetsContext.Provider value={{ bottom: 0, left: 0, right: 84, top: 0 }}>
      <SwipeActionList
        data={['entry']}
        keyExtractor={(item) => item}
        renderItem={({ item }) => <Text>{item}</Text>}
        style={{ backgroundColor: '#654321' }}
        swipeAction={() => null}
      />
    </SafeAreaInsetsContext.Provider>,
  );

  try {
    const viewportStyle = StyleSheet.flatten(screen.getByTestId('swipe-action-list').props.style);
    const contentStyle = StyleSheet.flatten(screen.getByTestId('swipe-action-list').props.contentContainerStyle);
    expect(viewportStyle).toEqual({ backgroundColor: '#654321' });
    expect(contentStyle).toEqual({ paddingLeft: left, paddingRight: right });
    expect(screen.getByTestId('swipe-action-list').props.scrollIndicatorInsets).toEqual(indicator);
  } finally {
    await screen.unmount();
    await act(async () => { restoreViewport(); });
  }
});
